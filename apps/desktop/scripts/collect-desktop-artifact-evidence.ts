/** Attest the platform checks a packaging machine performs for the release files it just built. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { load } from 'js-yaml'
import {
  digestDesktopArtifact,
  type DesktopArtifactEvidence,
  type DesktopArtifactEvidenceFile,
  type DesktopArtifactEvidenceKind,
} from './desktop-artifact-bundle.ts'
import type { DesktopArtifactQualification } from './desktop-artifact-bundle.ts'
import type { DesktopArtifactTarget } from './desktop-artifact-bundle.ts'
import type { DesktopArtifactVerification } from './desktop-artifact-bundle.ts'
import type { DesktopPublishConfig } from './desktop-publish-config.ts'
import { verifyMacOSDiskImage, verifyMacOSNotarizedApplication } from './verify-macos-signature.mjs'

/** One packaging machine, its release inventory and the expected signer configuration. */
export interface DesktopArtifactEvidenceRequest {
  /** Absolute paths of the release files the bundle will carry; directories are not accepted. */
  readonly releaseFiles: readonly string[]
  readonly target: DesktopArtifactTarget
  readonly qualification: DesktopArtifactQualification
  /** Build version the update feed must name. */
  readonly version: string
  /** Expected signer identity; public fields only. */
  readonly config: DesktopPublishConfig
  /** Host platform, defaulting to the running machine; tests override it to exercise selection. */
  readonly platform?: NodeJS.Platform
}

/** Platform checks and the evidence documents that support them. */
export interface DesktopArtifactEvidenceResult {
  readonly verification: DesktopArtifactVerification
  readonly evidence: readonly DesktopArtifactEvidenceFile[]
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { env: commandEnvironment(), encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
}

/** Verify the update feed names this build and points at a bundled archive. */
async function feedValidated(request: DesktopArtifactEvidenceRequest, names: readonly string[]): Promise<boolean> {
  const index = names.findIndex(name => /\.ya?ml$/u.test(name))
  if (index < 0) return false
  let metadata: unknown
  try {
    metadata = load(await readFile(request.releaseFiles[index]!, 'utf8'))
  } catch {
    return false
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false
  const record = metadata as Record<string, unknown>
  if (record.version !== request.version) return false
  if (!Array.isArray(record.files) || record.files.length !== 1) return false
  const entry = record.files[0]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const url = (entry as Record<string, unknown>).url
  return typeof url === 'string' && names.includes(basename(url))
}

/** Verify the notarized macOS DMG and the application archived in the ZIP. */
async function verifyMacOS(request: DesktopArtifactEvidenceRequest, names: readonly string[]): Promise<void> {
  if ((request.platform ?? process.platform) !== 'darwin') throw new Error('desktop artifact evidence: notarized macOS verification requires macOS')
  if (!request.config.macOS) throw new Error('desktop artifact evidence: the macOS signing identity and team are required')
  const find = (pattern: RegExp) => {
    const index = names.findIndex(name => pattern.test(name))
    return index < 0 ? undefined : request.releaseFiles[index]!
  }
  const dmg = find(/\.dmg$/u)
  const zip = find(/\.zip$/u)
  if (!dmg || !zip) throw new Error('desktop artifact evidence: a notarized bundle requires the DMG and the ZIP')
  verifyMacOSDiskImage(dmg, request.config.macOS)
  const listing = run('/usr/bin/unzip', ['-Z1', zip]).trim().split('\n')
  if (listing.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) {
    throw new Error('desktop artifact evidence: unsafe ZIP path')
  }
  const extracted = await mkdtemp(join(tmpdir(), 'desktop-artifact-evidence-'))
  try {
    run('/usr/bin/ditto', ['-x', '-k', zip, extracted])
    verifyMacOSNotarizedApplication(join(extracted, 'DeepSeek Harness.app'), request.config.macOS)
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
}

/**
 * Run the native signing checks this platform can perform and return the evidence for them.
 * @param request Release inventory, target, qualification and the expected signer identity.
 * @returns Verification flags matching the qualification plus one document per required evidence kind.
 */
export async function collectDesktopArtifactEvidence(request: DesktopArtifactEvidenceRequest): Promise<DesktopArtifactEvidenceResult> {
  const platform = request.platform ?? process.platform
  const names = request.releaseFiles.map(path => basename(path))
  const digests = new Map<string, string>()
  for (const path of request.releaseFiles) {
    const digest = await digestDesktopArtifact(path)
    digests.set(digest.name, digest.sha256)
  }
  const document = (kind: DesktopArtifactEvidenceKind, covered: readonly string[]): DesktopArtifactEvidenceFile => ({
    name: `${kind}.json`,
    evidence: {
      schemaVersion: 1, kind, target: request.target, verified: true,
      artifacts: covered.map(name => ({ name, sha256: digests.get(name)! })),
    } satisfies DesktopArtifactEvidence,
  })
  const evidence: DesktopArtifactEvidenceFile[] = []
  const windows = request.target === 'win-x64'
  if (windows && request.qualification === 'signed') {
    if (platform !== 'win32') throw new Error('desktop artifact evidence: signed Windows verification requires Windows')
    if (!request.config.windows) throw new Error('desktop artifact evidence: the Windows signer certificate thumbprint is required')
    const installer = names.find(name => name.endsWith('.exe'))
    if (!installer) throw new Error('desktop artifact evidence: the signed installer is missing')
    run('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(import.meta.dirname, 'verify-published-windows.ps1'),
      '-Installer', request.releaseFiles[names.indexOf(installer)]!, '-Thumbprint', request.config.windows.certificateThumbprint])
    evidence.push(document('windows-authenticode', [installer]), document('windows-timestamp', [installer]))
  }
  if (!windows && request.qualification === 'notarized') {
    await verifyMacOS(request, names)
    const archives = names.filter(name => /\.(?:dmg|zip)$/u.test(name))
    evidence.push(document('macos-codesign', archives), document('macos-notarization', archives))
  }
  const signed = request.qualification === 'signed'
  const notarized = request.qualification === 'notarized'
  return {
    verification: {
      windowsAuthenticode: windows && signed,
      windowsTimestamp: windows && signed,
      macosCodeSignature: !windows && notarized,
      macosNotarization: !windows && notarized,
      feedValidated: await feedValidated(request, names),
    },
    evidence,
  }
}
