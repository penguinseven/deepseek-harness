import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'
import type { DesktopArtifactEvidenceRequest } from '../scripts/collect-desktop-artifact-evidence.ts'
import type { DesktopArtifactEvidence, DesktopArtifactEvidenceKind } from '../scripts/desktop-artifact-bundle.ts'
import { desktopPublicationSummary } from '../scripts/desktop-publication-summary.ts'
import { prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'
import { retainDesktopCi, type DesktopArtifactEvidenceCollector } from '../scripts/retain-desktop-ci.ts'

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

it.each(['mac-arm64', 'win-x64'] as const)('preflights a retained %s bundle without credentials or the packaging checkout', async (target) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-preflight-'))
  try {
    const app = join(root, 'app')
    const configRoot = join(root, 'packaging')
    const artifacts = join(app, '.desktop-build', 'targets', target, 'artifacts')
    await mkdir(artifacts, { recursive: true })
    await mkdir(join(configRoot, 'presets'), { recursive: true })
    await mkdir(join(configRoot, 'publishing'))
    await writeFile(join(app, 'package.json'), '{"version":"1.0.0"}')
    const releaseId = 'a'.repeat(32)
    await writeFile(join(configRoot, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${releaseId}\n`)
    await writeFile(join(configRoot, 'publishing/test.json'), JSON.stringify({
      bucket: 'fixture-1250000000', origin: 'https://EXAMPLE.com:443/', credentialsFile: join(root, 'absent-credentials.json'),
    }))
    const commit = 'b'.repeat(40)
    const base = `deepseek-harness-1.0.0-${target}`
    const installer = target === 'win-x64' ? `${base}.exe` : `${base}.dmg`
    const update = target === 'win-x64' ? `${base}.exe` : `${base}.zip`
    // The update feed fingerprints the same bytes the installer uploads, so both files share one fixture string.
    const bytes = 'fixture installer bytes'
    await writeFile(join(artifacts, installer), target === 'win-x64' ? bytes : 'fixture DMG')
    if (target !== 'win-x64') await writeFile(join(artifacts, update), bytes)
    await writeFile(join(artifacts, `${update}.blockmap`), 'fixture blockmap')
    await writeFile(join(artifacts, target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'), JSON.stringify({
      version: '1.0.0', files: [{ url: update, size: Buffer.byteLength(bytes),
        sha512: createHash('sha512').update(bytes).digest('base64') }],
    }))
    await writeFile(join(artifacts, `${target}-release.json`), JSON.stringify({
      schemaVersion: 1, target, environment: 'test', version: '1.0.0', commit, dirty: false,
      publicUrl: `https://example.com/dsh-desk/${releaseId}/feeds/${target}/`,
    }))
    const env = {
      DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_PACKAGING_PRESET: 'test',
      DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin', DSH_DESKTOP_TARGET_ARCH: target === 'win-x64' ? 'x64' : 'arm64',
      PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: commit, PACKAGE_VERSION: '1.0.0', PACKAGE_SIGNING: 'signed', PACKAGE_SKIP_NOTARIZATION: 'false',
      GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: commit,
      RUNNER_NAME: 'fixture-runner', GITHUB_WORKFLOW: 'desktop-package',
    }
    const retained = await retainDesktopCi(env, app, evidenceStub)
    // Publication owns only the bundle: the packaging output and the checkout manifests are gone before it starts.
    await rm(join(app, '.desktop-build', 'targets'), { recursive: true })
    await rm(join(app, 'package.json'))
    const qualification = target === 'win-x64' ? 'signed' : 'notarized'
    const publishEnv = {
      ...env,
      DESKTOP_ARTIFACT_BUNDLE_DIR: retained.directory,
      DESKTOP_PUBLISH_ROUTE: JSON.stringify({
        runId: '10', attempt: '2', artifactId: '77', artifactName: retained.artifactName,
        workflowSha: commit, target, qualification, version: '1.0.0',
      }),
    }
    const prepared = await prepareDesktopPublication(publishEnv)
    expect(retained.artifactName).toBe(`desktop-${target}-${qualification}-1.0.0-10-2`)
    expect(prepared.selection.artifactName).toBe(retained.artifactName)
    expect(prepared.plan.version).toBe('1.0.0')
    expect(prepared.plan.commit).toBe(commit)
    expect(prepared.approval).toMatch(/^[a-f0-9]{64}$/u)
    expect(prepared.plan.artifacts.every(file => file.path.startsWith(prepared.bundle.releaseDirectory))).toBe(true)
    const summary = await desktopPublicationSummary(prepared.manifest, prepared.plan, 'c'.repeat(64))
    await expect(summary).toMatchFileSnapshot(`./expected/publication-${target}.md`)
    const feed = prepared.plan.artifacts.find(file => file.channelMetadata)!
    expect(summary).toContain(createHash('sha256').update(feed.contents!).digest('hex'))
    expect(summary).toContain('https&#58;//github.com/owner/repo/actions/runs/10/attempts/2')
    expect(summary).not.toContain('example.com//')
    expect(summary).not.toContain(root)
    expect(summary).not.toContain('absent-credentials')
    await expect(prepareDesktopPublication({ ...publishEnv, DESKTOP_APPROVED_PACKAGE: 'wrong' }))
      .rejects.toThrow('desktop publish: package or destination changed after approval')
    await expect(prepareDesktopPublication({ ...publishEnv, DESKTOP_PUBLISH_ROUTE: JSON.stringify({
      ...JSON.parse(publishEnv.DESKTOP_PUBLISH_ROUTE), qualification: 'unsigned',
    }) })).rejects.toThrow('desktop publish: the downloaded bundle differs from the routed package')
    await writeFile(join(prepared.bundle.releaseDirectory, installer), 'changed')
    await expect(prepareDesktopPublication(publishEnv)).rejects.toThrow('does not match its manifest digests')
  } finally { await rm(root, { recursive: true, force: true }) }
})
