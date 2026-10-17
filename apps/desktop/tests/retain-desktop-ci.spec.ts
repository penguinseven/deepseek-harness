import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { retainDesktopCi, type DesktopArtifactEvidenceCollector } from '../scripts/retain-desktop-ci.ts'
import {
  verifyDesktopArtifactBundle, type DesktopArtifactEvidence, type DesktopArtifactEvidenceKind,
} from '../scripts/desktop-artifact-bundle.ts'
import type { DesktopArtifactEvidenceRequest } from '../scripts/collect-desktop-artifact-evidence.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/**
 * Stand in for the native signing checks: fixture bytes carry no signature, so this collector only
 * reports the verification flags and the evidence documents that cover the installer bytes.
 * @param request Release inventory, target, qualification and the expected signer identity.
 * @returns Verification flags for the qualification plus one document per required evidence kind.
 */
const evidenceStub: DesktopArtifactEvidenceCollector = async (request: DesktopArtifactEvidenceRequest) => {
  const windows = request.target === 'win-x64'
  const installer = request.releaseFiles.find(path => windows ? path.endsWith('.exe') : path.endsWith('.dmg'))
  if (installer === undefined) throw new Error('fixture: no installer to attest')
  const sha256 = createHash('sha256').update(await readFile(installer)).digest('hex')
  const document = (kind: DesktopArtifactEvidenceKind): DesktopArtifactEvidence => ({
    schemaVersion: 1, kind, target: request.target, verified: true, artifacts: [{ name: basename(installer), sha256 }],
  })
  const signed = request.qualification === 'signed'
  const notarized = request.qualification === 'notarized'
  return {
    verification: {
      windowsAuthenticode: signed, windowsTimestamp: signed,
      macosCodeSignature: notarized, macosNotarization: notarized, feedValidated: true,
    },
    evidence: [
      ...(signed ? [
        { name: 'authenticode.json', evidence: document('windows-authenticode') },
        { name: 'timestamp.json', evidence: document('windows-timestamp') },
      ] : []),
      ...(notarized ? [
        { name: 'codesign.json', evidence: document('macos-codesign') },
        { name: 'notarization.json', evidence: document('macos-notarization') },
      ] : []),
    ],
  }
}

it.each(['mac-arm64', 'win-x64'] as const)('retains the complete %s bundle without signing or upload credentials', async (target) => {
  const root = await mkdtemp(join(tmpdir(), 'retain-ci-'))
  roots.push(root)
  const appRoot = join(root, 'checkout')
  const config = join(root, 'packaging')
  const artifacts = join(appRoot, '.desktop-build', 'targets', target, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(config, 'presets'), { recursive: true })
  await mkdir(join(config, 'publishing'), { recursive: true })
  await writeFile(join(appRoot, 'package.json'), '{"version":"1.0.0"}')
  const releaseId = 'a'.repeat(32)
  await writeFile(join(config, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${releaseId}\n`)
  await writeFile(join(config, 'publishing/test.json'), JSON.stringify({
    bucket: 'fixture-1250000000', origin: 'https://example.com/', credentialsFile: join(root, 'absent-credentials.json'),
  }))
  const base = `deepseek-harness-1.0.0-${target}`
  const recordName = `${target}-release.json`
  // Packaging writes the update feed and blockmap beside the installer; the record names the packaged commit.
  const names = target === 'win-x64'
    ? [`${base}.exe`, `${base}.exe.blockmap`, 'nightly.yml', recordName]
    : [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, 'nightly-mac.yml', recordName]
  await Promise.all(names.filter(name => name !== recordName).map(name => writeFile(join(artifacts, name), 'fixture')))
  await writeFile(join(artifacts, recordName), JSON.stringify({
    schemaVersion: 1, target, version: '1.0.0', commit: 'b'.repeat(40), dirty: false,
  }))
  const env = {
    DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'test',
    DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin',
    DSH_DESKTOP_TARGET_ARCH: target === 'win-x64' ? 'x64' : 'arm64',
    PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0',
    PACKAGE_SIGNING: 'signed', PACKAGE_SKIP_NOTARIZATION: 'false',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/repository',
    GITHUB_SHA: 'b'.repeat(40), RUNNER_NAME: 'dedicated', GITHUB_WORKFLOW: 'desktop-package',
  }
  const retained = await retainDesktopCi(env, appRoot, evidenceStub)
  const qualification = target === 'win-x64' ? 'signed' : 'notarized'
  expect(retained.artifactName).toBe(`desktop-${target}-${qualification}-1.0.0-123-2`)
  const bundle = await verifyDesktopArtifactBundle(retained.directory, {
    repository: 'owner/repository', runId: '123', attempt: '2', target, preset: 'test', artifactName: retained.artifactName,
  })
  expect(bundle.manifest.files.map(file => file.name)).toEqual(names)
  expect(bundle.manifest.build).toMatchObject({ target, qualification, version: '1.0.0', preset: 'test', channel: 'nightly' })
  expect(bundle.manifest.source).toEqual({ ref: 'master', sha: 'b'.repeat(40), workflowSha: 'b'.repeat(40), dirty: false })
  expect(bundle.manifest.actions).toEqual({
    workflowRunId: '123', workflowAttempt: '2', runnerName: 'dedicated', workflowName: 'desktop-package',
  })
})
