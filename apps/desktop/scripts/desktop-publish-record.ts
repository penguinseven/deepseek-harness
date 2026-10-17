/** Machine-local channel exclusion and durable, credential-free publication records. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { DesktopPublishEvent } from './desktop-publish.ts'

/**
 * Execute one publication or rollback while excluding other writers of its exact destination.
 * @param root Machine-owned lock directory shared by automatic and manual entrypoints.
 * @param destination Bucket and channel prefix identifying the serialized destination.
 * @param operation Work to finish before releasing the lock.
 * @returns Operation result. A held or abandoned lock rejects; operators inspect stale locks explicitly.
 */
export async function withDesktopChannelLock<T>(root: string, destination: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${createHash('sha256').update(destination).digest('hex')}.lock`)
  try { await mkdir(path, { mode: 0o700 }) } catch (cause) {
    throw new Error(`desktop publish: channel is locked or inaccessible; inspect ${path}`, { cause })
  }
  try {
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid,
      startedAt: new Date().toISOString(), destination }), { flag: 'wx', mode: 0o600, flush: true })
    return await operation()
  } finally { await rm(path, { recursive: true }) }
}

/** Terminal states a journal can settle on; the two pending states name the only remaining recovery. */
export type DesktopPublicationStatus = 'complete' | 'preview' | 'failed' | 'published-tag-pending' | 'release-mirror-pending'

/** Terminal states a mirror record can settle on; `release-mirror-pending` waits for one more mirror retry. */
export type DesktopMirrorStatus = 'complete' | 'release-mirror-pending' | 'failed'

/**
 * Events that finish every remote write the automation owns, so only mirroring remains outstanding.
 * A journal carrying one of them can be retried without repackaging, re-uploading COS or touching the feeds.
 * Legacy journals named the mirror retry here before the mirror owned its record.
 */
const COMPLETED_WRITES = new Set(['feeds-complete', 'complete', 'mirror-pending', 'mirror-complete'])

/** An operation journal retained independently of disposable checkout and artifact files. */
export interface DesktopPublicationRecord<Status extends string = DesktopPublicationStatus> {
  readonly directory: string
  record(event: DesktopPublishEvent): Promise<void>
  finish(status: Status): Promise<void>
}

/**
 * Allocate a private journal before performing any remote writes.
 * @param root Persistent audit root, outside the build checkout.
 * @param identity Public source, actor and destination metadata; never pass credentials.
 * @returns Durable event writer and explicit terminal-status writer.
 */
export async function createDesktopPublicationRecord<Status extends string = DesktopPublicationStatus>(
  root: string,
  identity: { repository: string; runId: string; attempt: string; actor: string; destination: string; operation: 'publish' | 'rollback' | 'mirror'; reason: string },
): Promise<DesktopPublicationRecord<Status>> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(root, '.initializing-'))
  const directory = join(root, `${identity.operation}-${basename(staging).slice('.initializing-'.length)}`)
  const startedAt = new Date().toISOString()
  try {
    await writeFile(join(staging, 'operation.json'), `${JSON.stringify({ ...identity,
      startedAt }, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    await writeFile(join(staging, 'events.jsonl'), '', { flag: 'wx', mode: 0o600, flush: true })
    await rename(staging, directory)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return {
    directory,
    async record(event) {
      await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { flush: true })
    },
    async finish(status) {
      await writeTerminalResult(directory, status, startedAt)
    },
  }
}

/**
 * Replace the terminal state of this attempt's mirror record, keeping earlier attempts beside it.
 * @param root Persistent publication journal root; the same root that holds the publication records.
 * @param identity Exact source, destination and channel of the attempt whose mirror state is synchronised.
 * @param status New terminal state of the mirror: `complete`, `release-mirror-pending` or `failed`.
 * @returns Number of records whose state changed, so a caller can report an audit-only repair.
 * Each mirror directory keeps its own start time and events; `result.json` alone is rewritten in place, and the
 * replaced bytes are retained as `result.<previous-status>.json` so the earlier verdict remains readable.
 */
export async function settleDesktopMirrorRecords(root: string, identity: {
  repository: string
  runId: string
  attempt: string
  destination: string
}, status: DesktopMirrorStatus): Promise<number> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
    throw error
  }
  let settled = 0
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('mirror-')) continue
    const directory = join(root, entry.name)
    const operation = await readOptionalJson(join(directory, 'operation.json'))
    if (operation === undefined) continue
    const parsed = z.object({ operation: z.literal('mirror'), repository: z.string(), runId: z.string(),
      attempt: z.string(), destination: z.string(), startedAt: z.string() }).parse(operation)
    if (parsed.repository !== identity.repository || parsed.runId !== identity.runId
      || parsed.attempt !== identity.attempt || parsed.destination !== identity.destination) continue
    const previous = z.object({ status: z.string() }).safeParse(await readOptionalJson(join(directory, 'result.json')))
    if (previous.success && previous.data.status === status) continue
    if (previous.success) {
      // Rename, not overwrite: the superseded verdict stays auditable under its own status name.
      await rename(join(directory, 'result.json'), join(directory, `result.${previous.data.status}.json`))
    }
    await writeTerminalResult(directory, status, parsed.startedAt)
    settled += 1
  }
  return settled
}

async function readOptionalJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Write the terminal state of one attempt so a later writer can replace it without touching its events. */
async function writeTerminalResult(directory: string, status: string, startedAt: string): Promise<void> {
  await writeFile(join(directory, 'result.json'), `${JSON.stringify({ status,
    startedAt, finishedAt: new Date().toISOString() })}\n`, { mode: 0o600, flush: true })
}

/**
 * Find durable evidence that this immutable attempt finished updating its feeds.
 * @param root Persistent publication journal root.
 * @param expected Exact source and destination for the current retained package.
 * @returns True permits tag-only recovery; false requires normal remote reconciliation.
 */
export async function wasDesktopAttemptPublished(root: string, expected: {
  repository: string
  runId: string
  attempt: string
  destination: string
}): Promise<boolean> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('publish-')) continue
    const directory = join(root, entry.name)
    let operation
    try { operation = JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    const parsed = z.object({ operation: z.string(), repository: z.string(),
      runId: z.string(), attempt: z.string(), destination: z.string() }).parse(operation)
    if (parsed.operation !== 'publish' || parsed.repository !== expected.repository || parsed.runId !== expected.runId
      || parsed.attempt !== expected.attempt || parsed.destination !== expected.destination) continue
    let events
    try { events = await readFile(join(directory, 'events.jsonl'), 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    // Only newline-terminated entries were completely appended before an interruption.
    for (const line of events.split('\n').slice(0, -1)) {
      if (COMPLETED_WRITES.has(z.object({ type: z.string() }).parse(JSON.parse(line)).type)) return true
    }
  }
  return false
}
