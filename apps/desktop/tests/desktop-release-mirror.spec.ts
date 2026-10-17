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

/**
 * GitHub stub whose Release and asset state persists across calls, so a retry sees the first attempt's uploads.
 * `foreignAssets` plants files under approved names; `digests` controls whether the listing reports `digest`,
 * and `downloads` records which assets were read back because their listing carried none.
 */
function githubStub(options: {
  releases?: 'absent' | 'present'
  foreignAssets?: Record<string, Buffer | number>
  digests?: 'reported' | 'absent'
} = {}) {
  const digests = options.digests ?? 'reported'
  const assets = new Map<string, Buffer>(Object.entries(options.foreignAssets ?? {})
    .map(([name, value]) => [name, typeof value === 'number' ? Buffer.alloc(value) : value]))
  const downloads: string[] = []
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
      return respond(200, { assets: [...assets].map(([name, content], index) => ({
        id: index + 1, name, size: content.length,
        ...digests === 'reported' ? { digest: `sha256:${sha256(content)}` } : {},
      })) })
    }
    if (method === 'GET' && url.includes('/releases/assets/')) {
      const id = Number(url.slice(url.lastIndexOf('/') + 1))
      const entry = [...assets.entries()][id - 1]
      if (entry === undefined) return respond(404, { message: 'Not Found' })
      downloads.push(entry[0])
      return new Response(new Uint8Array(entry[1]), { status: 200 })
    }
    if (method === 'POST' && url.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets')) {
      const name = new URL(url).searchParams.get('name')!
      assets.set(name, Buffer.from(init!.body as Buffer))
      return respond(201, { id: assets.size + 10, name, size: assets.get(name)!.length })
    }
    return respond(500, { message: 'unexpected request' })
  }
  return { request, calls, assets, downloads }
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
    // The planted file holds the approved bytes, so only the digest makes it trustworthy.
    const github = githubStub({ releases: 'absent', foreignAssets: { 'installer.exe': bytes('installer.exe') } })
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
    expect(github.assets.get('installer.exe')).toEqual(Buffer.alloc(1))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a same-size asset whose reported digest differs instead of confirming it', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    const impostor = Buffer.from('payload of installer.exE')
    // Same byte length as the approved file, different contents: only the digest exposes the substitution.
    expect(impostor.length).toBe(bytes('installer.exe').length)
    const github = githubStub({ foreignAssets: { 'installer.exe': impostor } })
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request }))
      .rejects.toThrow(`already exists with SHA-256 sha256:${sha256(impostor)} instead of the approved ${sha256(bytes('installer.exe'))}`)
    expect(github.assets.get('installer.exe')).toEqual(impostor)
    expect(github.calls.some(call => call.startsWith('POST'))).toBe(false)
    expect(github.downloads).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reads a same-size asset back when the listing reports no digest', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    const impostor = Buffer.from('payload of installer.exE')
    const github = githubStub({ foreignAssets: { 'installer.exe': impostor }, digests: 'absent' })
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request }))
      .rejects.toThrow(`already exists with SHA-256 ${sha256(impostor)} instead of the approved`)
    expect(github.downloads).toEqual(['installer.exe'])
    expect(github.calls.some(call => call.startsWith('POST'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('confirms an older same-size asset by reading identical bytes back', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    const github = githubStub({ foreignAssets: { 'installer.exe': bytes('installer.exe') }, digests: 'absent' })
    const result = await mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request: github.request })
    expect(result.uploaded).toEqual([])
    expect(result.present).toEqual(['installer.exe'])
    expect(github.downloads).toEqual(['installer.exe', 'installer.exe'])
    expect(github.calls.some(call => call.startsWith('POST'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an upload that stored other bytes than the approved file', async () => {
  const { root, assets } = await releaseDirectory(['installer.exe'])
  try {
    const upload = githubStub()
    const request: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if ((init?.method ?? 'GET') === 'POST' && url.startsWith('https://uploads.github.com/')) {
        // A truncated upload reports 201; only the read-back digest catches it.
        upload.assets.set(new URL(url).searchParams.get('name')!, Buffer.from('payload of installer.exE'))
        return new Response(JSON.stringify({ id: 99 }), { status: 201 })
      }
      return upload.request(input, init)
    }
    await expect(mirrorDesktopRelease({ repository: 'owner/repo', version: '1.0.0', assets,
      token: 'app-token', request }))
      .rejects.toThrow('already exists with SHA-256')
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
