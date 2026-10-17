/** Assemble the immutable Artifact Bundle a packaging job hands to publication. */
import { appendFile, lstat, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { desktopBuildRecordFilename, desktopUpdateMetadataFilename, resolveDesktopUpdateChannel } from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths, desktopTargetPlatform, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { collectDesktopArtifactEvidence } from './collect-desktop-artifact-evidence.ts'
import type { DesktopArtifactEvidenceRequest, DesktopArtifactEvidenceResult } from './collect-desktop-artifact-evidence.ts'
import {
  desktopArtifactName,
  writeDesktopArtifactBundle,
  type DesktopArtifactBuild,
  type DesktopArtifactPublicationFile,
  type DesktopArtifactSource,
} from './desktop-artifact-bundle.ts'
import { desktopPublishSecrets, readDesktopPublishConfig } from './desktop-publish-config.ts'

/** Native platform checks a packaging job runs; fixtures replace them because their bytes are not signed. */
export type DesktopArtifactEvidenceCollector =
  (request: DesktopArtifactEvidenceRequest) => Promise<DesktopArtifactEvidenceResult>

/**
 * Completion record packaging wrote beside its artifacts, read back instead of trusting shell variables.
 * Packaging omits the release destination on an unsigned build and the commit when it recorded no checkout.
 */
const buildRecordSchema = z.looseObject({
  schemaVersion: z.literal(1),
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']),
  version: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  dirty: z.boolean().optional(),
})

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`desktop artifact bundle: ${name} is required`)
  return value
}

/** Report whether a release file exists, without swallowing an error other than a missing file. */
async function releaseFilePresent(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    },
  )
}

/**
 * Build the artifact bundle for one successful package job, without reading signing or upload secrets.
 * @param env Actions identity, resolved package version and machine preset selection.
 * @param appRoot Desktop checkout directory; defaults to this script's owning app.
 * @param collect Native verification used for the release files; fixtures inject their own.
 * @returns Bundle directory and the artifact name that directory carries.
 */
export async function retainDesktopCi(
  env: NodeJS.ProcessEnv,
  appRoot = resolve(import.meta.dirname, '..'),
  collect: DesktopArtifactEvidenceCollector = collectDesktopArtifactEvidence,
): Promise<{ directory: string; artifactName: string }> {
  const target = resolveDesktopBuildTarget(env)
  const { platform, arch } = desktopTargetPlatform(target)
  const windows = target === 'win-x64'
  const settings = loadDesktopPackageEnvironment(platform, env, appRoot, { unsigned: true })
  const preset = settings.DSH_PACKAGING_PRESET
  if (preset !== 'test' && preset !== 'production') throw new Error('desktop artifact bundle: a machine preset is required')
  if (windows && !['signed', 'unsigned'].includes(env.PACKAGE_SIGNING ?? '')) throw new Error('desktop artifact bundle: invalid signing selection')
  if (!windows && !['true', 'false'].includes(env.PACKAGE_SKIP_NOTARIZATION ?? '')) throw new Error('desktop artifact bundle: invalid notarization selection')
  const qualification = windows ? (env.PACKAGE_SIGNING === 'signed' ? 'signed' : 'unsigned')
    : (env.PACKAGE_SKIP_NOTARIZATION === 'true' ? 'unnotarized' : 'notarized')
  const product: { version: string } = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  const version = validateDesktopBuildVersion(required(env, 'PACKAGE_VERSION'), product.version)
  const channel = resolveDesktopUpdateChannel(settings)
  const paths = desktopTargetBuildPaths(target)
  // The CLI's checkout owns these paths; alternate app roots are used by fixtures.
  const mode = qualification === 'unsigned' ? 'unsigned-artifacts' : qualification === 'unnotarized' ? 'unnotarized-artifacts' : 'artifacts'
  const artifacts = appRoot === resolve(import.meta.dirname, '..')
    ? join(paths.root, mode) : join(appRoot, '.desktop-build', 'targets', target, mode)
  const suffix = qualification === 'unnotarized' ? '-unnotarized' : qualification === 'unsigned' ? '-unsigned' : ''
  const base = `deepseek-harness-${version}-${windows ? 'win-x64' : target}${suffix}`
  // An unsigned macOS build creates the DMG alone; a notarized or unnotarized one adds the update archive.
  const archives = windows ? [`${base}.exe`] : qualification === 'unsigned' ? [`${base}.dmg`] : [`${base}.dmg`, `${base}.zip`]
  // electron-builder writes blockmaps and channel metadata only for a build that carries an update destination.
  const metadata = qualification === 'unsigned' ? [] : [
    `${base}.${windows ? 'exe' : 'zip'}.blockmap`,
    desktopUpdateMetadataFilename(version, platform, channel),
  ]
  const recordName = desktopBuildRecordFilename(target)
  // A published bundle must carry the complete upload set; a debug bundle carries whatever packaging wrote.
  const published = qualification === 'signed' || qualification === 'notarized'
  const releaseFiles: string[] = []
  for (const name of [...archives, ...metadata, recordName]) {
    const path = join(artifacts, name)
    if (await releaseFilePresent(path)) { releaseFiles.push(path); continue }
    if (published || archives.includes(name) || name === recordName) {
      throw new Error(`desktop artifact bundle: ${name} is missing from ${artifacts}`)
    }
  }
  const record = buildRecordSchema.parse(JSON.parse(await readFile(join(artifacts, recordName), 'utf8')))
  if (record.target !== target || record.version !== version) {
    throw new Error(`desktop artifact bundle: ${recordName} does not describe ${target} ${version}`)
  }
  const packaged = required(env, 'PACKAGE_SOURCE_SHA')
  if (record.commit !== undefined && record.commit !== packaged) {
    throw new Error(`desktop artifact bundle: ${recordName} names a different commit than the packaged checkout`)
  }
  const config = await readDesktopPublishConfig(env.DSH_PACKAGING_CONFIG_DIR, preset, desktopPublishSecrets(env))
  const evidence = await collect({ releaseFiles, target, qualification, version, config })
  const source: DesktopArtifactSource = {
    ref: required(env, 'PACKAGE_SOURCE_REF'), sha: record.commit ?? packaged,
    workflowSha: required(env, 'GITHUB_SHA'), dirty: record.dirty ?? false,
  }
  const build: DesktopArtifactBuild = {
    productVersion: product.version, version, target, platform, arch, channel, preset, qualification,
    testReleaseId: preset === 'test' ? (settings.DOWNLOAD_TEST_RELEASE_ID || null) : null,
  }
  const publication: DesktopArtifactPublicationFile[] = [
    { name: 'build-record.json', contents: record },
    { name: 'packaging-summary.json', contents: {
      schemaVersion: 1, build, installers: releaseFiles.map(path => basename(path)).filter(name => /\.(?:exe|dmg)$/u.test(name)),
    } },
  ]
  const artifactName = desktopArtifactName(build, required(env, 'GITHUB_RUN_ID'), required(env, 'GITHUB_RUN_ATTEMPT'))
  const directory = await writeDesktopArtifactBundle({
    outputRoot: join(appRoot, '.desktop-build', 'artifacts-bundles'), artifactName,
    repository: required(env, 'GITHUB_REPOSITORY'), source, build,
    actions: {
      workflowRunId: required(env, 'GITHUB_RUN_ID'), workflowAttempt: required(env, 'GITHUB_RUN_ATTEMPT'),
      runnerName: required(env, 'RUNNER_NAME'), workflowName: required(env, 'GITHUB_WORKFLOW'),
    },
    releaseFiles, verification: evidence.verification, evidence: evidence.evidence, publication,
  })
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `directory=${directory}\nartifact-name=${artifactName}\n`)
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `\nPackaged artifact: \`${artifactName}\`\n\nPublish it with package_run_id=${env.GITHUB_RUN_ID} and package_run_attempt=${env.GITHUB_RUN_ATTEMPT}\n`)
  return { directory, artifactName }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await retainDesktopCi(process.env)
}
