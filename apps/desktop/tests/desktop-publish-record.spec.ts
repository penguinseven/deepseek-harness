import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDesktopPublicationRecord, wasDesktopAttemptPublished, withDesktopChannelLock } from '../scripts/desktop-publish-record.ts'

it('excludes another process while a channel lock is held and admits it after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-process-lock-'))
  const script = `
    const { withDesktopChannelLock } = await import(process.argv[1]);
    try {
      await withDesktopChannelLock(process.argv[2], 'bucket/mac', async () => process.stdout.write('acquired'));
    } catch (error) {
      if (!error.message.includes('locked')) throw error;
      process.stdout.write('locked');
    }
  `
  const contender = () => promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script,
    new URL('../scripts/desktop-publish-record.ts', import.meta.url).href, root], { encoding: 'utf8' })
  try {
    await withDesktopChannelLock(root, 'bucket/mac', async () => {
      expect((await contender()).stdout).toBe('locked')
    })
    expect((await contender()).stdout).toBe('acquired')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('excludes overlapping writers of one channel but permits independent channels and releases after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-lock-'))
  try {
    await withDesktopChannelLock(root, 'bucket/mac', async () => {
      await expect(withDesktopChannelLock(root, 'bucket/mac', async () => {})).rejects.toThrow(/locked/u)
      await expect(withDesktopChannelLock(root, 'bucket/win', async () => 'independent')).resolves.toBe('independent')
    })
    await expect(withDesktopChannelLock(root, 'bucket/mac', async () => { throw new Error('fixture') })).rejects.toThrow('fixture')
    await expect(withDesktopChannelLock(root, 'bucket/mac', async () => 'recovered')).resolves.toBe('recovered')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('persists intent, before/after bytes and terminal state outside the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-audit-'))
  try {
    const record = await createDesktopPublicationRecord(root, { repository: 'owner/repo', runId: '1', attempt: '2',
      actor: 'operator', destination: 'bucket/feed/mac', operation: 'rollback', reason: 'restore previous release' })
    await record.record({ type: 'put-intent', key: 'feed/mac/nightly.yml', before: 'version: 2.0.0', after: 'version: 1.0.0' })
    await record.finish('complete')
    expect(JSON.parse(await readFile(join(record.directory, 'operation.json'), 'utf8'))).toMatchObject({ actor: 'operator', operation: 'rollback' })
    expect(JSON.parse((await readFile(join(record.directory, 'events.jsonl'), 'utf8')).trim())).toMatchObject({ before: 'version: 2.0.0', after: 'version: 1.0.0' })
    expect(JSON.parse(await readFile(join(record.directory, 'result.json'), 'utf8'))).toMatchObject({ status: 'complete' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('recognizes feed completion even when the later tag failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-recovery-'))
  try {
    const identity = { repository: 'owner/repo', runId: '12', attempt: '2', destination: 'bucket/mac' }
    const journal = await createDesktopPublicationRecord(root, { ...identity, actor: 'operator', operation: 'publish', reason: 'publish' })
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(false)
    await journal.record({ type: 'feeds-complete' })
    await journal.record({ type: 'tag-pending' })
    await journal.finish('published-tag-pending')
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(true)
    expect(await wasDesktopAttemptPublished(root, { ...identity, attempt: '1' })).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('ignores interrupted initialization before an audit directory becomes visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-init-'))
  try {
    await mkdir(join(root, '.initializing-interrupted'))
    await writeFile(join(root, '.initializing-interrupted/operation.json'), '{')
    const identity = { repository: 'owner/repo', runId: '1', attempt: '1', destination: 'bucket/mac' }
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(false)
    const record = await createDesktopPublicationRecord(root, { ...identity, actor: 'fixture', operation: 'publish', reason: 'fixture' })
    await record.record({ type: 'feeds-complete' })
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('settles a failed mirror as release-mirror-pending while keeping feed completion recoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-mirror-pending-'))
  try {
    const identity = { repository: 'owner/repo', runId: '30', attempt: '1', destination: 'bucket/win' }
    const journal = await createDesktopPublicationRecord(root, { ...identity, actor: 'operator', operation: 'publish', reason: 'publish' })
    await journal.record({ type: 'feeds-complete' })
    await journal.record({ type: 'mirror-pending', failure: { phase: 'GitHub Release mirroring', code: 'operation-failed', message: 'desktop mirror: cannot create the Release' } })
    await journal.finish('release-mirror-pending')
    expect(JSON.parse(await readFile(join(journal.directory, 'result.json'), 'utf8'))).toMatchObject({ status: 'release-mirror-pending' })
    const events = (await readFile(join(journal.directory, 'events.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(events.at(-1)!)).toMatchObject({ type: 'mirror-pending', failure: { phase: 'GitHub Release mirroring' } })
    // A pending mirror means every remote write already succeeded, so a retry must not republish the feeds.
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('records a completed mirror as the last recoverable state of the attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-mirror-complete-'))
  try {
    const identity = { repository: 'owner/repo', runId: '31', attempt: '1', destination: 'bucket/mac' }
    const journal = await createDesktopPublicationRecord(root, { ...identity, actor: 'operator', operation: 'mirror', reason: 'GitHub Release mirror retry' })
    await journal.record({ type: 'mirror-complete' })
    await journal.finish('complete')
    expect(JSON.parse(await readFile(join(journal.directory, 'operation.json'), 'utf8'))).toMatchObject({ operation: 'mirror' })
    expect(await wasDesktopAttemptPublished(root, identity)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
