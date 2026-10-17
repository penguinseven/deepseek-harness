import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY, desktopArtifactName, desktopArtifactManifestSchema,
  digestDesktopArtifact, verifyDesktopArtifactBundle, writeDesktopArtifactBundle,
  type DesktopArtifactBuild, type DesktopArtifactEvidence, type DesktopArtifactPublicationFile,
  type DesktopArtifactVerification,
} from '../scripts/desktop-artifact-bundle.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const VERSION = '1.0.0-test.20261016.1'

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function releaseInventory(build: DesktopArtifactBuild): readonly string[] {
  const base = `deepseek-harness-${VERSION}-${build.target}`
  return build.platform === 'win32'
    ? [`${base}.exe`, `${base}.exe.blockmap`, `${build.target}-release.json`, 'nightly.yml']
    : [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, `${build.target}-release.json`, 'nightly-mac.yml']
}

function verificationFor(build: DesktopArtifactBuild): DesktopArtifactVerification {
  return {
    windowsAuthenticode: build.qualification === 'signed',
    windowsTimestamp: build.qualification === 'signed',
    macosCodeSignature: build.qualification === 'notarized',
    macosNotarization: build.qualification === 'notarized',
    feedValidated: true,
  }
}

function evidenceDocument(
  kind: DesktopArtifactEvidence['kind'], build: DesktopArtifactBuild, covered: string, digest: string,
): DesktopArtifactEvidence {
  return { schemaVersion: 1, kind, target: build.target, verified: true, artifacts: [{ name: covered, sha256: digest }] }
}

async function fixture(build: Partial<DesktopArtifactBuild> = {}, source: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-artifact-bundle-'))
  roots.push(root)
  const sources = join(root, 'sources')
  await mkdir(sources)
  const identity: DesktopArtifactBuild = {
    productVersion: '1.0.0', version: VERSION, target: 'win-x64', platform: 'win32', arch: 'x64',
    channel: 'nightly', preset: 'test', qualification: 'unsigned', testReleaseId: 'c'.repeat(32),
    ...build,
  }
  const inventory = releaseInventory(identity)
  for (const name of inventory) await writeFile(join(sources, name), `fixture bytes for ${name}`)
  const digests = new Map(await Promise.all(inventory.map(async name =>
    [name, sha256(await readFile(join(sources, name)))] as const)))
  const covered = identity.platform === 'win32' ? inventory[0]! : inventory[1]!
  const digest = digests.get(covered)!
  const evidence: readonly { name: string; evidence: DesktopArtifactEvidence }[] = identity.qualification === 'signed'
    ? [
      { name: 'authenticode.json', evidence: evidenceDocument('windows-authenticode', identity, covered, digest) },
      { name: 'timestamp.json', evidence: evidenceDocument('windows-timestamp', identity, covered, digest) },
    ]
    : identity.qualification === 'notarized'
      ? [
        { name: 'codesign.json', evidence: evidenceDocument('macos-codesign', identity, covered, digest) },
        { name: 'notarization.json', evidence: evidenceDocument('macos-notarization', identity, covered, digest) },
      ]
      : []
  const actions = { workflowRunId: '100', workflowAttempt: '1', runnerName: 'windows-runner', workflowName: 'windows-package' }
  const artifactName = desktopArtifactName(identity, actions.workflowRunId, actions.workflowAttempt)
  const options = {
    outputRoot: join(root, 'bundles'),
    artifactName,
    repository: 'owner/repository',
    source: { ref: 'master', sha: 'a'.repeat(40), workflowSha: 'a'.repeat(40), dirty: false, ...source },
    build: identity,
    actions,
    releaseFiles: inventory.map(name => join(sources, name)),
    verification: verificationFor(identity),
    evidence,
    publication: [{ name: 'build-record.json', contents: { schemaVersion: 1 } }] as readonly DesktopArtifactPublicationFile[],
  }
  return {
    root, sources, identity, artifactName, inventory, digests, covered,
    installerName: inventory[0]!,
    installerBytes: await readFile(join(sources, inventory[0]!)),
    write: (overrides: Partial<typeof options> = {}) => writeDesktopArtifactBundle({ ...options, ...overrides }),
  }
}

it('writes one complete bundle whose manifest describes the copied bytes', async () => {
  const built = await fixture()
  const directory = await built.write()
  expect(basename(directory)).toBe(built.artifactName)
  const bundle = await verifyDesktopArtifactBundle(directory, {
    repository: 'owner/repository', runId: '100', attempt: '1', target: 'win-x64', preset: 'test',
    artifactName: built.artifactName,
  })
  expect(bundle.manifest.files.map(file => file.name)).toEqual([...built.inventory])
  const installer = bundle.manifest.files[0]!
  expect(installer.sha256).toBe(sha256(built.installerBytes))
  expect(installer.sha512).toBe(createHash('sha512').update(built.installerBytes).digest('base64'))
  expect(installer.size).toBe(built.installerBytes.length)
  expect(await readFile(join(bundle.releaseDirectory, installer.name))).toEqual(built.installerBytes)
  expect(bundle.publication.get('build-record.json')).toEqual({ schemaVersion: 1 })
  expect(bundle.evidence.size).toBe(0)
  expect(bundle.manifest.actions.runnerName).toBe('windows-runner')
})

it('keeps bundles atomic: an existing name is never replaced and a failed write leaves nothing behind', async () => {
  const built = await fixture()
  const directory = await built.write()
  await expect(built.write()).rejects.toThrow(/already exists/u)
  expect(await readFile(join(directory, 'release', built.installerName))).toEqual(built.installerBytes)
  await expect(built.write({ releaseFiles: [join(built.sources, built.installerName), join(built.root, 'missing.exe')] })).rejects.toThrow()
  await expect(verifyDesktopArtifactBundle(directory)).resolves.toBeDefined()
})

it('rejects duplicate, empty and non-absolute inventories and unknown artifact names', async () => {
  const built = await fixture()
  await expect(built.write({ releaseFiles: [] })).rejects.toThrow(/empty/u)
  await expect(built.write({ releaseFiles: [join(built.sources, built.installerName)] })).resolves.toBeDefined()
  await expect(built.write({ outputRoot: 'relative/bundles' })).rejects.toThrow(/absolute/u)
  await expect(built.write({ artifactName: 'not-a-bundle' })).rejects.toThrow(/does not name this build/u)
  const duplicate = await fixture()
  await expect(duplicate.write({ releaseFiles: [duplicate.sources, duplicate.sources] })).rejects.toThrow(/regular release file/u)
})

it('rejects a release inventory that no longer matches the manifest bytes', async () => {
  const built = await fixture()
  const directory = await built.write()
  const installer = join(directory, 'release', built.installerName)
  await writeFile(installer, Buffer.alloc(built.installerBytes.length))
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/does not match its manifest digests/u)
})

it('rejects release files added to or removed from the manifest inventory', async () => {
  const built = await fixture()
  const directory = await built.write()
  await writeFile(join(directory, 'release', 'extra.exe'), 'extra')
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/not in the manifest/u)
  await rm(join(directory, 'release', 'extra.exe'))
  await rm(join(directory, 'release', 'nightly.yml'))
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow()
})

it('rejects a manifest that names a file outside its release directory', async () => {
  const built = await fixture()
  const directory = await built.write()
  const path = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { files: { name: string }[] }
  manifest.files[0]!.name = '../installer.exe'
  await writeFile(path, JSON.stringify(manifest))
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow()
})

it('rejects identity, artifact name, version and target drift', async () => {
  const built = await fixture()
  const directory = await built.write()
  await expect(verifyDesktopArtifactBundle(directory, { runId: '101' })).rejects.toThrow(/run ID mismatch/u)
  await expect(verifyDesktopArtifactBundle(directory, { attempt: '2' })).rejects.toThrow(/run attempt mismatch/u)
  await expect(verifyDesktopArtifactBundle(directory, { target: 'mac-arm64' })).rejects.toThrow(/target mismatch/u)
  await expect(verifyDesktopArtifactBundle(directory, { preset: 'production' })).rejects.toThrow(/preset mismatch/u)
  await expect(verifyDesktopArtifactBundle(directory, { repository: 'other/repository' })).rejects.toThrow(/repository mismatch/u)
  await expect(verifyDesktopArtifactBundle(directory, { artifactName: `desktop-win-x64-signed-${VERSION}-100-1` }))
    .rejects.toThrow(/artifact name does not name this build/u)
  const path = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { build: DesktopArtifactBuild }
  await writeFile(path, JSON.stringify({ ...manifest, build: { ...manifest.build, version: '1.0.1' } }))
  await expect(verifyDesktopArtifactBundle(directory, { runId: '100', attempt: '1', artifactName: built.artifactName }))
    .rejects.toThrow(/artifact name does not name this build/u)
  expect(desktopArtifactManifestSchema.safeParse({ ...manifest, build: { ...manifest.build, platform: 'darwin' } }).success).toBe(false)
})

it('names bundles from their build identity and refuses unusable identifiers', async () => {
  const built = await fixture()
  expect(built.artifactName).toBe(`desktop-win-x64-unsigned-${VERSION}-100-1`)
  expect(() => desktopArtifactName({ target: 'win-x64', qualification: 'signed', version: '../1.0.0' }, '100', '1')).toThrow()
  expect(() => desktopArtifactName({ target: 'win-x64', qualification: 'signed', version: '1.0.0' }, '0', '1')).toThrow()
})

it('requires evidence covering the bundled installer for a signed or notarized bundle', async () => {
  const signed = await fixture({ qualification: 'signed' })
  const digest = signed.digests.get(signed.installerName)!
  const timestamp = { name: 'timestamp.json', evidence: evidenceDocument('windows-timestamp', signed.identity, signed.installerName, digest) }
  await expect(fixture({ qualification: 'signed' }).then(built => built.write({ evidence: [] })))
    .rejects.toThrow(/requires windows-authenticode evidence/u)
  await expect(signed.write({
    evidence: [{ name: 'authenticode.json', evidence: evidenceDocument('windows-authenticode', signed.identity, signed.installerName, sha256('other bytes')) }, timestamp],
  })).rejects.toThrow(/does not match the bundled bytes/u)
  await expect(signed.write({
    evidence: [{ name: 'authenticode.json', evidence: evidenceDocument('windows-authenticode', signed.identity, 'nightly.yml', signed.digests.get('nightly.yml')!) }, timestamp],
  })).rejects.toThrow(/covers no installer/u)
  const macos = await fixture({ qualification: 'notarized', target: 'mac-arm64', platform: 'darwin', arch: 'arm64' })
  const bundle = await verifyDesktopArtifactBundle(await macos.write())
  expect([...bundle.evidence.keys()].sort()).toEqual(['macos-codesign', 'macos-notarization'])
  expect(bundle.manifest.verification.macosNotarization).toBe(true)
})

it('rejects evidence that is unverified, duplicated or contradicts the qualified state', async () => {
  const signed = await fixture({ qualification: 'signed' })
  const digest = signed.digests.get(signed.installerName)!
  const authenticode = { name: 'authenticode.json', evidence: evidenceDocument('windows-authenticode', signed.identity, signed.installerName, digest) }
  const timestamp = { name: 'timestamp.json', evidence: evidenceDocument('windows-timestamp', signed.identity, signed.installerName, digest) }
  await expect(signed.write({ evidence: [{ ...authenticode, evidence: { ...authenticode.evidence, verified: false } }, timestamp] }))
    .rejects.toThrow(/unverified/u)
  await expect(fixture({ qualification: 'signed' }).then(built => built.write({ verification: { ...verificationFor(built.identity), windowsTimestamp: false } })))
    .rejects.toThrow(/must match the qualification/u)
  await expect(fixture({ qualification: 'signed' }).then(built => built.write({ verification: { ...verificationFor(built.identity), macosNotarization: true } })))
    .rejects.toThrow(/must match the qualification/u)
  await expect(signed.write({ evidence: [{ ...authenticode, evidence: { ...authenticode.evidence, target: 'mac-arm64' } }, timestamp] }))
    .rejects.toThrow()
  const directory = await signed.write({ evidence: [{ ...authenticode, name: 'first.json' }, timestamp] })
  await writeFile(join(directory, DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY, 'second.json'), JSON.stringify(authenticode.evidence))
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/duplicate windows-authenticode evidence/u)
})

it('rejects removed evidence and non-JSON verification files after download', async () => {
  const signed = await fixture({ qualification: 'signed' })
  const directory = await signed.write()
  const path = join(directory, DESKTOP_ARTIFACT_VERIFICATION_DIRECTORY)
  await rm(join(path, 'authenticode.json'))
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/requires windows-authenticode evidence/u)
  await writeFile(join(path, 'authenticode.json'), 'not json')
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/cannot read/u)
  await rm(join(path, 'authenticode.json'))
  await writeFile(join(path, 'README.txt'), 'evidence')
  await expect(verifyDesktopArtifactBundle(directory)).rejects.toThrow(/is not a JSON file/u)
})

it('binds production publication to a release branch or tag and permits test sources', async () => {
  const macos = { qualification: 'notarized' as const, target: 'mac-arm64' as const, platform: 'darwin' as const, arch: 'arm64' as const }
  await expect(fixture(macos, { ref: 'feature/desktop' }).then(built => built.write())).resolves.toBeDefined()
  await expect(fixture(macos, { ref: 'feature/desktop' }).then(built =>
    built.write({ build: { ...built.identity, preset: 'production' } }))).rejects.toThrow(/Production source/u)
  for (const ref of ['master', 'main', 'dsh-v1.0.0']) {
    await expect(fixture({ ...macos, preset: 'production' }, { ref }).then(built => built.write())).resolves.toBeDefined()
  }
  const windows = { qualification: 'unsigned' as const }
  await expect(fixture(windows, { ref: 'feature/desktop' }).then(built => built.write())).resolves.toBeDefined()
})

it('digests only regular non-empty files', async () => {
  const built = await fixture()
  const installer = join(built.sources, built.installerName)
  await expect(digestDesktopArtifact(installer)).resolves.toMatchObject({
    name: basename(installer), size: built.installerBytes.length,
  })
  await expect(digestDesktopArtifact(built.sources)).rejects.toThrow(/regular release file/u)
  const empty = join(built.sources, 'empty.exe')
  await writeFile(empty, '')
  await expect(digestDesktopArtifact(empty)).rejects.toThrow(/empty/u)
})
