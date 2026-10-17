/**
 * Mirror the bytes one approved publication already uploaded into a GitHub Release.
 *
 * COS and the update feeds stay the only source automatic updates read. The Release is a second copy of the same
 * package attempt, written after COS, the feeds and the tag succeeded, so nothing here can change what clients
 * install. A mirror failure is therefore recorded as `release-mirror-pending` and retried through this module alone:
 * it never repackages, regenerates or re-uploads COS bytes.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { DesktopArtifactManifest } from './desktop-artifact-bundle.ts'
import { desktopReleaseTag } from './desktop-release-tag.ts'

/** One release asset the mirror either uploads or confirms, carrying the digests the bundle recorded. */
export interface DesktopReleaseAsset {
  /** File name inside `release/`, which becomes the asset name. */
  readonly name: string
  /** Absolute path to the approved bytes; rehashed before any upload. */
  readonly path: string
  /** Byte length the manifest recorded for these bytes. */
  readonly size: number
  /** Lowercase hexadecimal SHA-256 the manifest recorded. */
  readonly sha256: string
}

/** Facts the mirrored Release states about the approved publication it copies. */
export interface DesktopReleaseNotes {
  /** Package target named by the bundle manifest. */
  readonly target: string
  /** Commit the approved bytes were packaged from. */
  readonly sourceSha: string
  /** Approval digest covering the manifest, its evidence and the upload plan. */
  readonly approvalDigest: string
  /** Public URL of the update feed this publication replaced. */
  readonly feedUrl: string
}

/** Result of mirroring one publication; `complete` also covers a Release that already held every asset. */
export interface DesktopReleaseMirrorResult {
  readonly status: 'complete'
  readonly url: string
  /** Assets this invocation uploaded; empty when a retry only confirmed earlier uploads. */
  readonly uploaded: readonly string[]
  /** Assets that were already present with matching bytes. */
  readonly present: readonly string[]
}

const releaseSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.string().min(1),
  upload_url: z.string().min(1),
  body: z.string().nullish(),
})
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u)
const releaseNotesSchema = z.strictObject({
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  approvalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  feedUrl: z.string().min(1),
})
/** One listed asset; GitHub reports `digest` as `sha256:<hex>` for assets uploaded since 2025. */
const assetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullish(),
})
const assetsSchema = z.object({ assets: z.array(assetSchema) })
/** One listed asset whose identity the mirror compares against the approved bytes. */
type ReleaseAsset = z.infer<typeof assetSchema>

/** One Release identity, including the upload host that creation or lookup reported for it. */
interface ReleaseTarget {
  readonly id: number
  readonly htmlUrl: string
  readonly uploadUrl: string
  /** Notes GitHub currently stores for the Release, or null when it has none. */
  readonly body: string | null
}

/** Release lookup result: an existing Release, or confirmation GitHub holds none for this tag yet. */
type ReleaseLookup = { present: true; target: ReleaseTarget } | { present: false }

function api(repository: string, path: string): string {
  return `https://api.github.com/repos/${repository}/${path}`
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel()
}

/**
 * Find the Release one tag already carries.
 * @param repository Owner/name of the release repository.
 * @param tag Release tag name.
 * @param token Installation token limited to release contents.
 * @param request HTTP implementation; tests inject an isolated fake.
 * @returns The Release identity, or `present: false` when GitHub reports 404 for this tag.
 * Any other response rejects, because an unreadable Release cannot be safely created again.
 */
async function findRelease(
  repository: string, tag: string, token: string, request: typeof fetch,
): Promise<ReleaseLookup> {
  const response = await request(api(repository, `releases/tags/${encodeURIComponent(tag)}`),
    { headers: headers(token), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) { await discard(response); return { present: false } }
  if (!response.ok) { await discard(response); throw new Error(`desktop mirror: cannot read the Release for ${tag} (HTTP ${response.status})`) }
  return { present: true, target: releaseTarget(await response.json()) }
}

/** Read one Release identity from a GitHub Release body. */
function releaseTarget(body: unknown): ReleaseTarget {
  const release = releaseSchema.parse(body)
  return { id: release.id, htmlUrl: release.html_url, uploadUrl: release.upload_url, body: release.body ?? null }
}

/**
 * Render the deterministic notes one mirrored Release carries.
 * @param version Published version shown in the Release title.
 * @param facts Target, source commit, approval digest and update feed of the approved publication.
 * @returns Markdown whose only variable input is the validated publication identity.
 * Every fact is validated first, so a value cannot inject markup or change with the runner that wrote it.
 */
export function desktopReleaseBody(version: string, facts: DesktopReleaseNotes): string {
  const notes = releaseNotesSchema.parse(facts)
  const publishedVersion = versionSchema.parse(version)
  const feed = new URL(notes.feedUrl)
  if (feed.protocol !== 'https:' || /[\s<>`|]/u.test(notes.feedUrl)) {
    throw new Error('desktop mirror: release notes require an https update feed URL without markup characters')
  }
  return [
    `DeepSeek Harness Desktop ${publishedVersion}`,
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Version | \`${publishedVersion}\` |`,
    `| Target | \`${notes.target}\` |`,
    `| Source SHA | \`${notes.sourceSha}\` |`,
    `| Approved artifact SHA-256 | \`${notes.approvalDigest}\` |`,
    `| Update feed | <${notes.feedUrl}> |`,
    '',
    'The attached assets are the bytes this publication uploaded to COS. The update feed above remains the only source automatic updates read.',
    '',
  ].join('\n')
}

/**
 * Hash the approved bytes again immediately before upload.
 * @param asset Release asset to hash.
 * @returns Size and SHA-256 of the file on disk.
 * A file that changed after approval rejects instead of uploading different bytes under an approved name.
 */
async function digest(asset: DesktopReleaseAsset): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of createReadStream(asset.path)) {
    size += bytes.length
    hash.update(bytes)
  }
  return { size, sha256: hash.digest('hex') }
}

/**
 * Create the Release for one tag when COS, the feeds and the tag are already published.
 * @param repository Owner/name of the release repository.
 * @param tag Release tag, which the publication already created against the packaged commit.
 * @param version Published version, used only for the Release title.
 * @param body Deterministic notes describing the approved publication.
 * @param token Installation token limited to release contents.
 * @param request HTTP implementation.
 * @returns The new Release identity.
 */
async function createRelease(
  repository: string, tag: string, version: string, body: string, token: string, request: typeof fetch,
): Promise<ReleaseTarget> {
  const response = await request(api(repository, 'releases'), {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `DeepSeek Harness Desktop ${version}`, body, draft: false, prerelease: false }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 201) return releaseTarget(await response.json())
  await discard(response)
  // A parallel run may have created the same Release after this one's lookup.
  if (response.status === 422) {
    const existing = await findRelease(repository, tag, token, request)
    if (existing.present) return existing.target
  }
  throw new Error(`desktop mirror: cannot create the Release for ${tag} (HTTP ${response.status})`)
}

/**
 * Store the deterministic notes on a Release that was created with other or missing notes.
 * @param repository Owner/name of the release repository.
 * @param target Release the mirror is about to fill.
 * @param body Notes rendered from the approved publication.
 * @param token Installation token limited to release contents.
 * @param request HTTP implementation.
 * @returns Nothing; unchanged notes cost no request, and a rejected or discarded update fails the mirror.
 * Updating is how a repeated mirror converges on one Release body instead of leaving the first attempt's text.
 */
async function ensureReleaseBody(
  repository: string, target: ReleaseTarget, body: string, token: string, request: typeof fetch,
): Promise<void> {
  if (target.body === body) return
  const response = await request(api(repository, `releases/${target.id}`), {
    method: 'PATCH',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    await discard(response)
    throw new Error(`desktop mirror: cannot update the notes of the Release for ${target.htmlUrl} (HTTP ${response.status})`)
  }
  const updated = releaseTarget(await response.json())
  if (updated.body !== body) throw new Error(`desktop mirror: GitHub discarded the notes of the Release for ${target.htmlUrl}`)
}

/**
 * Upload one approved asset.
 * @param repository Owner/name of the release repository.
 * @param uploadUrl Upload host GitHub reported for this Release, without its URI template.
 * @param asset Asset to upload, already rehashed.
 * @param token Installation token limited to release contents.
 * @param request HTTP implementation.
 * @returns Uploaded asset name.
 */
async function uploadAsset(
  repository: string, uploadUrl: string, asset: DesktopReleaseAsset, token: string, request: typeof fetch,
): Promise<string> {
  const response = await request(`${uploadUrl.replace(/\{\?[^}]*\}$/u, '')}?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) },
    body: await readFile(asset.path),
    redirect: 'error',
    signal: AbortSignal.timeout(600_000),
  })
  if (response.status !== 201) {
    await discard(response)
    throw new Error(`desktop mirror: cannot upload ${asset.name} to ${repository} (HTTP ${response.status})`)
  }
  await discard(response)
  return asset.name
}

/**
 * Require an already published asset to hold the approved bytes before leaving it untouched.
 * @param repository Owner/name of the release repository.
 * @param approved Approved asset, whose SHA-256 the bundle manifest recorded.
 * @param existing Asset GitHub listed under the approved name.
 * @param token Installation token limited to release contents.
 * @param request HTTP implementation.
 * @returns Nothing; a name already published with other bytes rejects.
 * GitHub's SHA-256 asset digest is authoritative when present; otherwise the asset is downloaded and hashed.
 */
async function confirmPublishedAsset(
  repository: string, approved: DesktopReleaseAsset, existing: ReleaseAsset, token: string, request: typeof fetch,
): Promise<void> {
  const mismatch = (found: string) => new Error(
    `desktop mirror: ${approved.name} already exists with ${found} instead of the approved ${approved.sha256}; inspect the Release before retrying`)
  // Approved bytes have a fixed length, so a different size is a different file under a published name.
  if (existing.size !== approved.size) throw mismatch(`${existing.size} bytes`)
  if (existing.digest !== null && existing.digest !== undefined) {
    if (existing.digest.slice('sha256:'.length) !== approved.sha256) throw mismatch(`SHA-256 ${existing.digest}`)
    return
  }
  // Assets uploaded before GitHub reported digests can only be compared by reading them back.
  const response = await request(api(repository, `releases/assets/${existing.id}`), {
    headers: { ...headers(token), Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) {
    await discard(response)
    throw new Error(`desktop mirror: cannot read the published ${approved.name} to compare its bytes (HTTP ${response.status})`)
  }
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of response.body ?? []) { size += bytes.length; hash.update(bytes) }
  const actual = hash.digest('hex')
  if (size !== approved.size || actual !== approved.sha256) throw mismatch(`SHA-256 ${actual}`)
}

/**
 * Mirror every approved asset of one publication into its `desktop-v<version>` Release.
 *
 * The operation is idempotent: an asset already present with the approved name, size and SHA-256 is left untouched,
 * and only missing assets are uploaded. A Release holding other bytes under an approved name stops the mirror
 * before any upload instead of overwriting published download bytes.
 * @param options Release repository, published version, release notes, approved assets and the token scoped to release contents.
 * @returns Terminal `complete` state, the Release URL and which assets this invocation uploaded or confirmed.
 * A conflicting Release, a changed asset and any transport failure reject without touching COS or the feeds.
 */
export async function mirrorDesktopRelease(options: {
  readonly repository: string
  readonly version: string
  readonly notes: DesktopReleaseNotes
  readonly assets: readonly DesktopReleaseAsset[]
  readonly token: string
  readonly request?: typeof fetch
}): Promise<DesktopReleaseMirrorResult> {
  const { repository, version, assets, token } = options
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('desktop mirror: invalid repository')
  if (assets.length === 0) throw new Error('desktop mirror: the approved package carries no release files')
  if (token.trim() === '') throw new Error('desktop mirror: GitHub App installation token is required')
  const tag = desktopReleaseTag(version)
  const body = desktopReleaseBody(version, options.notes)
  const request = options.request ?? fetch
  const names = new Set<string>()
  for (const asset of assets) {
    if (basename(asset.name) !== asset.name) throw new Error(`desktop mirror: ${asset.name} must be a file name`)
    if (names.has(asset.name)) throw new Error(`desktop mirror: duplicate release asset ${asset.name}`)
    names.add(asset.name)
  }
  const release = await findRelease(repository, tag, token, request)
  const target = release.present
    ? release.target
    : await createRelease(repository, tag, version, body, token, request)
  await ensureReleaseBody(repository, target, body, token, request)
  const listing = await request(api(repository, `releases/${target.id}/assets`),
    { headers: headers(token), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!listing.ok) {
    await discard(listing)
    throw new Error(`desktop mirror: cannot list the assets of ${tag} (HTTP ${listing.status})`)
  }
  const listed = new Map(assetsSchema.parse(await listing.json()).assets.map(asset => [asset.name, asset]))
  const absent: DesktopReleaseAsset[] = []
  for (const asset of assets) {
    const existing = listed.get(asset.name)
    if (existing === undefined) { absent.push(asset); continue }
    await confirmPublishedAsset(repository, asset, existing, token, request)
  }
  const confirmed = assets.filter(asset => !absent.includes(asset))
  for (const asset of absent) {
    const actual = await digest(asset)
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) {
      throw new Error(`desktop mirror: ${asset.name} no longer matches the approved bytes`)
    }
  }
  const uploaded: string[] = []
  for (const asset of absent) {
    uploaded.push(await uploadAsset(repository, target.uploadUrl, asset, token, request))
  }
  const after = await request(api(repository, `releases/${target.id}/assets`),
    { headers: headers(token), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!after.ok) {
    await discard(after)
    throw new Error(`desktop mirror: cannot confirm the assets of ${tag} (HTTP ${after.status})`)
  }
  const final = new Map(assetsSchema.parse(await after.json()).assets.map(asset => [asset.name, asset]))
  for (const asset of assets) {
    const stored = final.get(asset.name)
    if (stored === undefined) throw new Error(`desktop mirror: ${asset.name} is missing from the Release after mirroring`)
    // Reading the stored bytes back is the only confirmation that the upload stored the approved file.
    await confirmPublishedAsset(repository, asset, stored, token, request)
  }
  return { status: 'complete', url: target.htmlUrl, uploaded, present: confirmed.map(asset => asset.name) }
}

/**
 * Bind the approved release files to the manifest that produced them.
 * @param manifest Verified bundle manifest of the publication being mirrored.
 * @param releaseDirectory Directory holding exactly the manifest inventory.
 * @returns One asset per release file, in manifest order.
 */
export function desktopReleaseAssets(
  manifest: DesktopArtifactManifest, releaseDirectory: string,
): readonly DesktopReleaseAsset[] {
  return manifest.files.map(file => ({
    name: file.name, path: join(releaseDirectory, file.name), size: file.size, sha256: file.sha256,
  }))
}
