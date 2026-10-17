import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { desktopReleaseAssets, mirrorDesktopRelease, type DesktopReleaseAsset } from '../scripts/desktop-release-mirror.ts'
import type { DesktopArtifactManifest } from '../scripts/desktop-artifact-bundle.ts'

/** Complete manifest identity used by the bundle-inventory test; only `files` differs per case. */
const manifestIdentity: Omit<DesktopArtifactManifest, 'files'> = {
  schemaVersion: 1,
  repository: 'owner/repo',
  source: { ref: 'dsh-v1.0.0', sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), dirty: false },
  build: {
    productVersion: '1.0.0', version: '1.0.0', target: 'win-x64', platform: 'win32', arch: 'x64',
    channel: 'latest', preset: 'production', qualification: 'signed', testReleaseId: null,
  },
  actions: { workflowRunId: '20', workflowAttempt: '3', runnerName: 'windows-publisher', workflowName: 'windows-package' },
  verification: {
    windowsAuthenticode: true, windowsTimestamp: true,
    macosCodeSignature: false, macosNotarization: false, feedValidated: true,
  },
}

const bytes = (name: string): Buffer => Buffer.from(`payload of ${name}`)
const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

/** Approved release files written to one temporary `release/` directory. */
async function releaseDirectory(names: readonly string[]): Promise<{ root: string; assets: DesktopReleaseAsset[] }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-mirror-'))
  const assets: DesktopReleaseAsset[] = []
  for (const name of names) {
    const content = bytes(name)
    await writeFile(join(root, name), content)
    assets.push({ name, path: join(root, name), size: content.length, sha256: sha256(content) })
  }
  return { root, assets }
}

/** GitHub stub whose Release and asset state persists across calls, so a retry sees the first attempt's uploads. */
function githubStub(options: { releases?: 'absent' | 'present'; foreignAssets?: Record<string, number> } = {}) {
  const assets = new Map<string, number>(Object.entries(options.foreignAssets ?? {}))
  const calls: string[] = []
  let created = false
  const respond = (status: number, body?: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const request: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.replace('https://api.github.com/repos/owner/repo', '')}`)
    if (method === 'GET' && url.includes('/releases/tags/')) {
      if (options.releases === 'absent' && !created) return respond(404, { message: 'Not Found' })
      created = true
      return respond(200, { id: 7, html_url: 'https://github.com/owner/repo/releases/tag/desktop-v1.0.0',
        upload_url: 'https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}' })
    }
    if (method === 'POST' && url.endsWith('/releases')) {
      created = true
      return respond(201, { id: 7, html_url: 'https://github.com/owner/repo/releases/tag/desktop-v1.0.0',
        upload_url: 'https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}' })
    }
    if (method === 'GET' && url.endsWith('/releases/7/assets')) {
      return respond(200, { assets: [...assets].map(([name, size], index) => ({ id: index + 1, name, size })) })
    }
    if (method === 'POST' && url.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets')) {
      const name = new URL(url).searchParams.get('name')!
      assets.set(name, Buffer.from(init!.body as Buffer).length)
      return respond(201, { id: assets.size + 10, name, size: assets.get(name) })
    }
    return respond(500, { message: 'unexpected request' })
  }
  return { request, calls, assets }
}

it('creates the Release for the published tag and uploads every approved file once', async () => {
  const { root, assets } = await releaseDirectory(['deepseek-harness-1.0.0-win-x64.exe', 'latest.yml'])
  try {
    const github = githubStub({ releases: 'absent' })
    const result = await mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request })
    expect(result).toEqual({ status: 'complete', url: 'https://github.com/owner/repo/releases/tag/desktop-v1.0.0',
      uploaded: ['deepseek-harness-1.0.0-win-x64.exe', 'latest.yml'], present: [] })
    expect(github.calls[0]).toBe('GET /releases/tags/desktop-v1.0.0')
    expect(github.calls[1]).toBe('POST /releases')
    expect([...github.assets.keys()]).toEqual(['deepseek-harness-1.0.0-win-x64.exe', 'latest.yml'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retries idempotently: a second run confirms existing assets and uploads only what is missing', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe', 'latest.yml', 'installer.exe.blockmap'])
  try {
    const github = githubStub({ releases: 'absent', foreignAssets: { 'installer.exe': bytes('installer.exe').length } })
    const first = await mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request })
    expect(first.uploaded).toEqual(['latest.yml', 'installer.exe.blockmap'])
    expect(first.present).toEqual(['installer.exe'])
    github.calls.length = 0
    const second = await mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request })
    expect(second.uploaded).toEqual([])
    expect(second.present).toEqual(['installer.exe', 'latest.yml', 'installer.exe.blockmap'])
    expect(github.calls.filter(call => call.startsWith('POST'))).toEqual([])
    expect(github.assets.size).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an existing asset of a different size instead of overwriting published bytes', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    const github = githubStub({ foreignAssets: { 'installer.exe': 1 } })
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request }))
      .rejects.toThrow('already exists with 1 bytes instead of the approved')
    expect(github.assets.get('installer.exe')).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects bytes that changed after approval before uploading anything', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    await writeFile(join(root, 'installer.exe'), 'tampered')
    const github = githubStub()
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request })).rejects.toThrow('no longer matches the approved bytes')
    expect(github.calls.some(call => call.startsWith('POST'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires a token, a version and at least one approved asset', async () => {
  const github = githubStub()
  await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets: [],
    token: 'app-token', request: github.request })).rejects.toThrow('carries no release files')
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: ' ', request: github.request })).rejects.toThrow('installation token is required')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('binds the approved assets to the manifest inventory of the bundle', async () => {
  const { root } = await releaseDirectory(['installer.exe', 'latest.yml'])
  try {
    const manifest: DesktopArtifactManifest = {
      ...manifestIdentity,
      files: [
        { name: 'installer.exe', size: bytes('installer.exe').length, sha256: sha256(bytes('installer.exe')), sha512: `${'a'.repeat(86)}==` },
        { name: 'latest.yml', size: bytes('latest.yml').length, sha256: sha256(bytes('latest.yml')), sha512: `${'b'.repeat(86)}==` },
      ],
    }
    expect(desktopReleaseAssets(manifest, root).map(asset => [asset.name, asset.path])).toEqual([
      ['installer.exe', join(root, 'installer.exe')],
      ['latest.yml', join(root, 'latest.yml')],
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})
