/** Build and verify the immutable Desktop artifact bundle exchanged between packaging and publication. */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'

/** Directory holding the release files uploaded to COS and listed by the manifest inventory. */
export const DESKTOP_ARTIFACT_RELEASE_DIRECTORY = 'release'
/** Directory holding platform verification evidence written on the packaging machine. */
export const DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY = 'verification'
/** Directory holding packaging records retained for audit and never uploaded to COS. */
export const DESKTOP_ARTIFACT_PUBLICATION_DIRECTORY = 'publication'
/** Manifest file name at the bundle root. */
export const DESKTOP_ARTIFACT_MANIFEST_FILENAME = 'manifest.json'

const positiveId = z.string().regex(/^[1-9]\d*$/u)
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const sha512Schema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u)
const sizeSchema = z.number().int().positive()
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u)

/** Release targets a bundle can describe. */
export const desktopArtifactTargetSchema = z.enum(['mac-arm64', 'mac-x64', 'win-x64'])
/** Signing state a bundle carries, which fixes the evidence publication requires. */
export const desktopArtifactQualificationSchema = z.enum(['signed', 'notarized', 'unsigned', 'unnotarized'])

/** Byte fingerprints of one release file, computed after the bundle copy. */
export const desktopArtifactFileSchema = z.strictObject({
  name: nameSchema, size: sizeSchema, sha256: sha256Schema, sha512: sha512Schema,
})

/** Packaging source identity; `sha` is the packaged commit and `ref` the branch or tag requested. */
export const desktopArtifactSourceSchema = z.strictObject({
  ref: z.string().min(1), sha: commitSchema, workflowSha: commitSchema, dirty: z.boolean(),
})

/** Publication-relevant build identity, including the random test prefix used by test downloads. */
export const desktopArtifactBuildSchema = z.strictObject({
  productVersion: versionSchema, version: versionSchema, target: desktopArtifactTargetSchema,
  platform: z.enum(['darwin', 'win32']), arch: z.enum(['arm64', 'x64']),
  channel: z.enum(['nightly', 'latest']), preset: z.enum(['test', 'production']),
  qualification: desktopArtifactQualificationSchema,
  testReleaseId: z.string().regex(/^[a-f0-9]{32}$/u).nullable(),
})

/** Actions identity of the packaging run; `runnerName` is audit-only and never selects a publication machine. */
export const desktopArtifactActionsSchema = z.strictObject({
  workflowRunId: positiveId, workflowAttempt: positiveId, runnerName: z.string().min(1), workflowName: z.string().min(1),
})

/** Platform checks the packaging machine reports for the files in this bundle. */
export const desktopArtifactVerificationSchema = z.strictObject({
  windowsAuthenticode: z.boolean(), windowsTimestamp: z.boolean(),
  macosCodeSignature: z.boolean(), macosNotarization: z.boolean(), feedValidated: z.boolean(),
})

const desktopArtifactManifestShape = z.strictObject({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  source: desktopArtifactSourceSchema,
  build: desktopArtifactBuildSchema,
  actions: desktopArtifactActionsSchema,
  files: z.array(desktopArtifactFileSchema).min(1),
  verification: desktopArtifactVerificationSchema,
})

function consistentBuild(build: z.infer<typeof desktopArtifactBuildSchema>): boolean {
  if (build.target === 'win-x64') {
    return build.platform === 'win32' && build.arch === 'x64' && ['signed', 'unsigned'].includes(build.qualification)
  }
  return build.platform === 'darwin' && build.arch === (build.target === 'mac-arm64' ? 'arm64' : 'x64')
    && ['notarized', 'unnotarized'].includes(build.qualification)
}

function consistentVerification(manifest: z.infer<typeof desktopArtifactManifestShape>): boolean {
  const { verification, build } = manifest
  if (build.platform === 'win32' && (verification.macosCodeSignature || verification.macosNotarization)) return false
  if (build.platform === 'darwin' && (verification.windowsAuthenticode || verification.windowsTimestamp)) return false
  const signed = build.qualification === 'signed'
  const notarized = build.qualification === 'notarized'
  return verification.windowsAuthenticode === signed && verification.windowsTimestamp === signed
    && verification.macosCodeSignature === notarized && verification.macosNotarization === notarized
}

/**
 * Portable bundle manifest: the publication input replacing any dependency on the packaging disk.
 * Production publishes only from a release branch or tag, matching the packaging workflow gate.
 */
export const desktopArtifactManifestSchema = desktopArtifactManifestShape
  .refine(manifest => manifest.build.preset === 'test'
    || /^(?:master|main|dsh-v[0-9][0-9A-Za-z.-]*)$/u.test(manifest.source.ref),
  'Production source must be a release branch or tag')
  .refine(manifest => consistentBuild(manifest.build),
    'Target, platform, architecture and qualification must describe one Desktop build')
  .refine(manifest => consistentVerification(manifest),
    'Verification flags must match the qualification and the target platform')

/** Kinds of platform evidence a bundle carries for its signed or notarized release files. */
export const desktopArtifactEvidenceKindSchema = z.enum([
  'windows-authenticode', 'windows-timestamp', 'macos-codesign', 'macos-notarization',
])

/**
 * One platform verification result produced by the packaging machine, bound to the exact bytes it covered.
 * A hosted publication runner cannot repeat native signing checks, so the digests are the binding:
 * a bundle republished after any byte change fails its evidence check.
 */
export const desktopArtifactEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: desktopArtifactEvidenceKindSchema,
  target: desktopArtifactTargetSchema,
  verified: z.boolean(),
  artifacts: z.array(z.strictObject({ name: nameSchema, sha256: sha256Schema })).min(1),
})

/** Evidence kinds publication requires before it publishes a qualified bundle. */
const REQUIRED_EVIDENCE: Record<DesktopArtifactQualification, readonly DesktopArtifactEvidenceKind[]> = {
  signed: ['windows-authenticode', 'windows-timestamp'],
  notarized: ['macos-codesign', 'macos-notarization'],
  unsigned: [],
  unnotarized: [],
}

/** Parsed manifest of one bundle. */
export type DesktopArtifactManifest = z.infer<typeof desktopArtifactManifestSchema>
/** Packaging source identity recorded in a bundle manifest. */
export type DesktopArtifactSource = z.infer<typeof desktopArtifactSourceSchema>
/** Build identity recorded in a bundle manifest. */
export type DesktopArtifactBuild = z.infer<typeof desktopArtifactBuildSchema>
/** Actions identity recorded in a bundle manifest. */
export type DesktopArtifactActions = z.infer<typeof desktopArtifactActionsSchema>
/** One release file and its digests. */
export type DesktopArtifactFile = z.infer<typeof desktopArtifactFileSchema>
/** Platform evidence bound to the release files it covered. */
export type DesktopArtifactEvidence = z.infer<typeof desktopArtifactEvidenceSchema>
/** Kind of platform evidence one evidence document attests. */
export type DesktopArtifactEvidenceKind = z.infer<typeof desktopArtifactEvidenceKindSchema>
/** Platform checks recorded for one bundle. */
export type DesktopArtifactVerification = z.infer<typeof desktopArtifactVerificationSchema>
/** Release target a bundle describes. */
export type DesktopArtifactTarget = z.infer<typeof desktopArtifactTargetSchema>
/** Signing state a bundle carries. */
export type DesktopArtifactQualification = z.infer<typeof desktopArtifactQualificationSchema>

/** Verified bundle contents handed to the publication job. */
export interface DesktopArtifactBundle {
  /** Bundle root that was read, after resolving links. */
  readonly directory: string
  /** Directory containing exactly the manifest inventory, ready for `desktop-upload-plan`. */
  readonly releaseDirectory: string
  /** Validated manifest. */
  readonly manifest: DesktopArtifactManifest
  /** Evidence indexed by kind. */
  readonly evidence: ReadonlyMap<string, DesktopArtifactEvidence>
  /** Packaging records retained for audit, keyed by file name. */
  readonly publication: ReadonlyMap<string, unknown>
}

/** One release file and its digests, computed before any bundle is written. */
export interface DesktopArtifactDigests {
  /** Release file name, which is also its COS object name. */
  readonly name: string
  /** Exact byte length. */
  readonly size: number
  /** Lowercase hexadecimal SHA-256, matching `shasum -a 256`. */
  readonly sha256: string
  /** Base64 SHA-512, matching the update feed and COS reconciliation. */
  readonly sha512: string
}

/** One evidence document and the bundle file that carries it. */
export interface DesktopArtifactEvidenceFile {
  /** File name inside `verification/`, without a directory. */
  readonly name: string
  /** Document that must parse as one evidence record of this bundle. */
  readonly evidence: DesktopArtifactEvidence
}

/** One audit record and the bundle file that carries it. */
export interface DesktopArtifactPublicationFile {
  /** File name inside `publication/`, without a directory. */
  readonly name: string
  /** JSON document retained with the bundle and never uploaded to COS. */
  readonly contents: unknown
}

/** Inputs one packaging job supplies when it publishes its bundle. */
export interface DesktopArtifactBundleInput {
  /** Absolute parent directory; the bundle becomes `<outputRoot>/<artifactName>`. */
  readonly outputRoot: string
  /** Artifact name, which must equal the name derived from the manifest identity. */
  readonly artifactName: string
  /** Repository the packaging run belongs to. */
  readonly repository: string
  readonly source: DesktopArtifactSource
  readonly build: DesktopArtifactBuild
  readonly actions: DesktopArtifactActions
  /** Source paths copied into `release/`; directory trees are not accepted. */
  readonly releaseFiles: readonly string[]
  /** Platform checks the packaging machine completed for those files. */
  readonly verification: DesktopArtifactVerification
  /** Evidence documents copied into `verification/`. */
  readonly evidence: readonly DesktopArtifactEvidenceFile[]
  /** Audit documents copied into `publication/`. */
  readonly publication: readonly DesktopArtifactPublicationFile[]
}

/** Identity a caller expects a bundle to carry before it consumes the release files. */
export interface DesktopArtifactExpectation {
  readonly repository?: string
  readonly runId?: string
  readonly attempt?: string
  readonly target?: DesktopArtifactTarget
  readonly preset?: 'test' | 'production'
  /** Artifact name the caller resolved from the artifact listing. */
  readonly artifactName?: string
}

/**
 * Name one bundle from its build identity; packaging uploads and publication resolve the same string.
 * @param build Build identity recorded in the manifest.
 * @param runId Packaging workflow run ID.
 * @param attempt Packaging attempt.
 * @returns Stable artifact name, which is also the bundle directory name.
 */
export function desktopArtifactName(
  build: Pick<DesktopArtifactBuild, 'target' | 'qualification' | 'version'>,
  runId: string,
  attempt: string,
): string {
  const version = versionSchema.parse(build.version)
  positiveId.parse(runId)
  positiveId.parse(attempt)
  return `desktop-${build.target}-${build.qualification}-${version}-${runId}-${attempt}`
}

/**
 * Hash one release file with the digests COS, the update feed and the manifest all compare.
 * @param path Source file; links, directories and empty files reject.
 * @returns File name, byte length and both digests.
 */
export async function digestDesktopArtifact(path: string): Promise<DesktopArtifactDigests> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('desktop artifact bundle: expected a regular release file')
  const name = nameSchema.parse(basename(path))
  const hash256 = createHash('sha256')
  const hash512 = createHash('sha512')
  let size = 0
  for await (const bytes of createReadStream(path)) {
    size += bytes.length
    hash256.update(bytes)
    hash512.update(bytes)
  }
  if (size === 0) throw new Error(`desktop artifact bundle: release file ${name} is empty`)
  return { name, size, sha256: hash256.digest('hex'), sha512: hash512.digest('base64') }
}

async function realDirectory(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('desktop artifact bundle: expected a real directory')
  return realpath(path)
}

async function containedFile(directory: string, name: string): Promise<string> {
  if (name !== basename(name)) throw new Error(`desktop artifact bundle: ${name} must be a file name`)
  const path = join(directory, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`desktop artifact bundle: expected a regular file ${name}`)
  return path
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop artifact bundle: cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeJson(path: string, contents: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
}

async function copyVerified(source: string, destination: string, expected: DesktopArtifactDigests): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const copied = await digestDesktopArtifact(destination)
  if (copied.size !== expected.size || copied.sha256 !== expected.sha256 || copied.sha512 !== expected.sha512) {
    throw new Error(`desktop artifact bundle: ${expected.name} changed while the bundle was written`)
  }
}

async function readEvidenceFiles(directory: string, manifest: DesktopArtifactManifest): Promise<Map<string, DesktopArtifactEvidence>> {
  const digests = new Map(manifest.files.map(file => [file.name, file.sha256]))
  const evidence = new Map<string, DesktopArtifactEvidence>()
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.json')) {
      throw new Error(`desktop artifact bundle: verification/${file.name} is not a JSON file`)
    }
    const document = desktopArtifactEvidenceSchema.parse(await readJson(join(directory, file.name), `verification/${file.name}`))
    if (!document.verified) throw new Error(`desktop artifact bundle: verification/${file.name} reports an unverified ${document.kind}`)
    if (document.target !== manifest.build.target) {
      throw new Error(`desktop artifact bundle: verification/${file.name} describes ${document.target}, not ${manifest.build.target}`)
    }
    for (const artifact of document.artifacts) {
      if (digests.get(artifact.name) !== artifact.sha256) {
        throw new Error(`desktop artifact bundle: verification/${file.name} does not match the bundled bytes of ${artifact.name}`)
      }
    }
    if (evidence.has(document.kind)) throw new Error(`desktop artifact bundle: duplicate ${document.kind} evidence`)
    evidence.set(document.kind, document)
  }
  for (const kind of REQUIRED_EVIDENCE[manifest.build.qualification]) {
    const document = evidence.get(kind)
    if (document === undefined) throw new Error(`desktop artifact bundle: ${manifest.build.qualification} requires ${kind} evidence`)
    const covered = manifest.build.platform === 'win32' ? /\.exe$/u : /\.(?:dmg|zip)$/u
    if (!document.artifacts.some(artifact => covered.test(artifact.name))) {
      throw new Error(`desktop artifact bundle: ${kind} evidence covers no installer or update archive`)
    }
  }
  return evidence
}

/**
 * Copy one complete release target into a portable bundle and expose it atomically.
 * @param options Packaging identity, the exact release inventory and the evidence that covers it.
 * @returns Bundle directory. An existing bundle is never replaced, so republishing requires a new attempt.
 */
export async function writeDesktopArtifactBundle(options: DesktopArtifactBundleInput): Promise<string> {
  if (!isAbsolute(options.outputRoot)) throw new Error('desktop artifact bundle: output root must be absolute')
  if (options.releaseFiles.length === 0) throw new Error('desktop artifact bundle: the release inventory is empty')
  const release = await Promise.all(options.releaseFiles.map(path => digestDesktopArtifact(path)))
  if (new Set(release.map(file => file.name)).size !== release.length) throw new Error('desktop artifact bundle: duplicate release file name')
  if (release.some(file => file.name === DESKTOP_ARTIFACT_MANIFEST_FILENAME)) throw new Error('desktop artifact bundle: manifest filename is reserved')
  const evidenceNames = options.evidence.map(file => nameSchema.parse(file.name))
  const publicationNames = options.publication.map(file => nameSchema.parse(file.name))
  if (new Set(evidenceNames).size !== evidenceNames.length) throw new Error('desktop artifact bundle: duplicate evidence file name')
  if (new Set(publicationNames).size !== publicationNames.length) throw new Error('desktop artifact bundle: duplicate publication file name')
  const manifest: DesktopArtifactManifest = desktopArtifactManifestSchema.parse({
    schemaVersion: 1, repository: options.repository, source: options.source, build: options.build,
    actions: options.actions, files: release, verification: options.verification,
  })
  const artifactName = nameSchema.parse(options.artifactName)
  if (artifactName !== desktopArtifactName(manifest.build, manifest.actions.workflowRunId, manifest.actions.workflowAttempt)) {
    throw new Error(`desktop artifact bundle: artifact name ${artifactName} does not name this build`)
  }
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 })
  const root = await realDirectory(options.outputRoot)
  const destination = join(root, artifactName)
  await lstat(destination).then(
    () => { throw new Error(`desktop artifact bundle: ${artifactName} already exists`) },
    (error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error },
  )
  const staging = await mkdtemp(join(root, '.bundle-'))
  try {
    const releaseDirectory = join(staging, DESKTOP_ARTIFACT_RELEASE_DIRECTORY)
    await mkdir(releaseDirectory, { mode: 0o700 })
    for (const [index, path] of options.releaseFiles.entries()) {
      const expected = release[index]!
      await copyVerified(path, join(releaseDirectory, expected.name), expected)
    }
    const evidenceDirectory = join(staging, DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY)
    await mkdir(evidenceDirectory, { mode: 0o700 })
    for (const [index, file] of options.evidence.entries()) {
      await writeJson(join(evidenceDirectory, evidenceNames[index]!), desktopArtifactEvidenceSchema.parse(file.evidence))
    }
    const publicationDirectory = join(staging, DESKTOP_ARTIFACT_PUBLICATION_DIRECTORY)
    await mkdir(publicationDirectory, { mode: 0o700 })
    for (const [index, file] of options.publication.entries()) {
      await writeJson(join(publicationDirectory, publicationNames[index]!), file.contents)
    }
    await writeJson(join(staging, DESKTOP_ARTIFACT_MANIFEST_FILENAME), manifest)
    await verifyDesktopArtifactBundle(staging, {
      repository: manifest.repository, runId: manifest.actions.workflowRunId, attempt: manifest.actions.workflowAttempt,
      target: manifest.build.target, preset: manifest.build.preset,
    })
    await rename(staging, destination)
    return destination
  }
  finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Read a bundle, rehash every release file and enforce the identity a consumer expects.
 * @param directory Bundle root as downloaded or as written by the packaging job.
 * @param expected Identity the caller already committed to, such as the route it resolved.
 * @returns Validated bundle whose release directory holds exactly the manifest inventory.
 */
export async function verifyDesktopArtifactBundle(
  directory: string,
  expected: DesktopArtifactExpectation = {},
): Promise<DesktopArtifactBundle> {
  const root = await realDirectory(directory)
  const manifest = desktopArtifactManifestSchema.parse(
    await readJson(await containedFile(root, DESKTOP_ARTIFACT_MANIFEST_FILENAME), DESKTOP_ARTIFACT_MANIFEST_FILENAME),
  )
  if (new Set(manifest.files.map(file => file.name)).size !== manifest.files.length) {
    throw new Error('desktop artifact bundle: duplicate release file name')
  }
  if (expected.repository !== undefined && manifest.repository !== expected.repository) throw new Error('desktop artifact bundle: repository mismatch')
  if (expected.runId !== undefined && manifest.actions.workflowRunId !== expected.runId) throw new Error('desktop artifact bundle: run ID mismatch')
  if (expected.attempt !== undefined && manifest.actions.workflowAttempt !== expected.attempt) throw new Error('desktop artifact bundle: run attempt mismatch')
  if (expected.target !== undefined && manifest.build.target !== expected.target) throw new Error('desktop artifact bundle: target mismatch')
  if (expected.preset !== undefined && manifest.build.preset !== expected.preset) throw new Error('desktop artifact bundle: preset mismatch')
  if (expected.artifactName !== undefined
    && expected.artifactName !== desktopArtifactName(manifest.build, manifest.actions.workflowRunId, manifest.actions.workflowAttempt)) {
    throw new Error('desktop artifact bundle: artifact name does not name this build')
  }
  const releaseDirectory = await realDirectory(join(root, DESKTOP_ARTIFACT_RELEASE_DIRECTORY))
  const inventory = new Set(manifest.files.map(file => file.name))
  for (const name of await readdir(releaseDirectory)) {
    if (!inventory.has(name)) throw new Error(`desktop artifact bundle: release/${name} is not in the manifest`)
  }
  for (const file of manifest.files) {
    const current = await digestDesktopArtifact(await containedFile(releaseDirectory, file.name))
    if (current.size !== file.size || current.sha256 !== file.sha256 || current.sha512 !== file.sha512) {
      throw new Error(`desktop artifact bundle: release/${file.name} does not match its manifest digests`)
    }
  }
  const evidence = await readEvidenceFiles(await realDirectory(join(root, DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY)), manifest)
  const publicationDirectory = await realDirectory(join(root, DESKTOP_ARTIFACT_PUBLICATION_DIRECTORY))
  const publication = new Map<string, unknown>()
  for (const file of await readdir(publicationDirectory, { withFileTypes: true })) {
    if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.json')) {
      throw new Error(`desktop artifact bundle: publication/${file.name} is not a JSON file`)
    }
    publication.set(file.name, await readJson(join(publicationDirectory, file.name), `publication/${file.name}`))
  }
  return { directory: root, releaseDirectory, manifest, evidence, publication }
}
