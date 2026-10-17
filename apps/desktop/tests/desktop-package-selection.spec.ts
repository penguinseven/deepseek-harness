import { expect, it } from 'vitest'
import type { DesktopArtifactManifest } from '../scripts/desktop-artifact-bundle.ts'
import { verifyDesktopApprovalEnvironment, verifyDesktopSource } from '../scripts/publish-desktop-ci.ts'
import { selectDesktopArtifact } from '../scripts/resolve-desktop-artifact-ci.ts'

type Api = (path: string, paginate?: boolean) => unknown
type Fixture = ReturnType<typeof fixture>

/** Package run, jobs and artifacts one publication dispatch can select from. */
function fixture() {
  const run = { id: 42, run_attempt: 2, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success',
    event: 'workflow_dispatch', path: '.github/workflows/macos-package.yml', repository: { full_name: 'owner/repo' } }
  const jobs = [{ name: 'package', conclusion: 'success' }]
  const artifacts = [{ id: 7, name: 'desktop-mac-arm64-notarized-1.0.0-42-2', expired: false }]
  const calls: string[] = []
  const api: Api = (path, paginate) => {
    calls.push(path)
    if (path.endsWith('/jobs?per_page=100')) { expect(paginate).toBe(true); return [{ jobs: [] }, { jobs }] }
    if (path.endsWith('/artifacts?per_page=100')) { expect(paginate).toBe(true); return [{ artifacts }] }
    if (path.endsWith('/42')) return { run_attempt: 2 }
    return run
  }
  return { run, jobs, artifacts, calls, api }
}

it('pins the latest successful attempt and finds the package artifact across pages', () => {
  const f = fixture()
  expect(selectDesktopArtifact('owner/repo', { package_run_id: '42' }, f.api)).toEqual({
    runId: '42', attempt: '2', artifactId: '7', artifactName: 'desktop-mac-arm64-notarized-1.0.0-42-2',
    workflowSha: 'a'.repeat(40), target: 'mac-arm64', qualification: 'notarized', version: '1.0.0',
  })
  expect(f.calls).toEqual([
    'repos/owner/repo/actions/runs/42',
    'repos/owner/repo/actions/runs/42/attempts/2',
    'repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100',
    'repos/owner/repo/actions/runs/42/artifacts?per_page=100',
  ])
})

it('selects an explicit old attempt without consulting the latest attempt', () => {
  const f = fixture()
  f.run.run_attempt = 1
  f.artifacts[0]!.name = 'desktop-mac-arm64-notarized-1.0.0-42-1'
  expect(selectDesktopArtifact('owner/repo', { package_run_id: '42', package_run_attempt: '1' }, f.api))
    .toMatchObject({ attempt: '1', artifactId: '7' })
  expect(f.calls).not.toContain('repos/owner/repo/actions/runs/42')
  expect(f.calls).toContain('repos/owner/repo/actions/runs/42/attempts/1')
})

it('reads a version carrying dashes out of the artifact name', () => {
  const f = fixture()
  f.artifacts[0]!.name = 'desktop-mac-arm64-notarized-0.2.1-alpha.4-42-2'
  expect(selectDesktopArtifact('owner/repo', { package_run_id: '42' }, f.api))
    .toMatchObject({ target: 'mac-arm64', qualification: 'notarized', version: '0.2.1-alpha.4' })
})

it.each(['desktop-mac-arm64-attested-1.0.0-42-2', 'desktop-linux-x64-signed-1.0.0-42-2', 'desktop-mac-arm64-1.0.0-42-2'])(
  'rejects the unrecognized artifact name %s', (name) => {
    const f = fixture()
    f.artifacts[0]!.name = name
    expect(() => selectDesktopArtifact('owner/repo', { package_run_id: '42' }, f.api))
      .toThrow('desktop publish: expected one package artifact for this attempt')
  },
)

const rejections: readonly [name: string, mutate: (fixture: Fixture) => void, message: string | undefined][] = [
  ['a run that has not completed', (f) => { f.run.status = 'in_progress' }, undefined],
  ['an unsuccessful run', (f) => { f.run.conclusion = 'failure' }, undefined],
  ['a run dispatched by another event', (f) => { f.run.event = 'push' }, undefined],
  ['a run of an unrelated workflow', (f) => { f.run.path = '.github/workflows/ci.yml' }, undefined],
  ['a run from another repository', (f) => { f.run.repository.full_name = 'other/repo' },
    'desktop publish: selected run or attempt does not match GitHub evidence'],
  ['a run ID that does not match the dispatch', (f) => { f.run.id = 50 },
    'desktop publish: selected run or attempt does not match GitHub evidence'],
  ['an attempt the dispatch did not name', (f) => { f.run.run_attempt = 1 },
    'desktop publish: selected run or attempt does not match GitHub evidence'],
  ['no successful package job', (f) => { f.jobs[0]!.conclusion = 'failure' },
    'desktop publish: expected one successful package job'],
  ['two successful package jobs', (f) => { f.jobs.push({ name: 'package', conclusion: 'success' }) },
    'desktop publish: expected one successful package job'],
  ['the artifact of another attempt', (f) => { f.artifacts[0]!.name = 'desktop-mac-arm64-notarized-1.0.0-42-1' },
    'desktop publish: expected one package artifact for this attempt'],
  ['two artifacts of this attempt', (f) => { f.artifacts.push({ ...f.artifacts[0]!, id: 8 }) },
    'desktop publish: expected one package artifact for this attempt'],
  ['an expired artifact', (f) => { f.artifacts[0]!.expired = true },
    'desktop publish: the package artifact has expired'],
]

it.each(rejections)('rejects %s without falling back to another attempt', (_name, mutate, message) => {
  const f = fixture()
  mutate(f)
  const select = () => selectDesktopArtifact('owner/repo', { package_run_id: '42' }, f.api)
  if (message === undefined) expect(select).toThrow()
  else expect(select).toThrow(message)
  expect(f.calls.some(path => path.includes('/attempts/1'))).toBe(false)
})

it('rejects a Windows package workflow that uploaded a macOS artifact', () => {
  const f = fixture()
  f.run.path = '.github/workflows/windows-package.yml'
  expect(() => selectDesktopArtifact('owner/repo', { package_run_id: '42' }, f.api))
    .toThrow('desktop publish: the package workflow does not build the selected target')
})

it.each(['0', '../42', '1\nrunner=x', 'abc'])('rejects malformed package ID %s before API access', (id) => {
  const f = fixture()
  expect(() => selectDesktopArtifact('owner/repo', { package_run_id: id }, f.api)).toThrow()
  expect(f.calls).toEqual([])
})

it('rejects a repository that is not owner/name before API access', () => {
  const f = fixture()
  expect(() => selectDesktopArtifact('owner/repo/../other', { package_run_id: '42' }, f.api))
    .toThrow('desktop publish: invalid repository')
  expect(f.calls).toEqual([])
})

const commit = 'a'.repeat(40)

/** Verified manifest whose source ref is the only field these source checks read besides the commit. */
function manifestFor(ref: string): DesktopArtifactManifest {
  return {
    schemaVersion: 1,
    repository: 'owner/repo',
    source: { ref, sha: commit, workflowSha: 'b'.repeat(40), dirty: false },
    build: {
      productVersion: '1.0.0', version: '1.0.0', target: 'mac-arm64', platform: 'darwin', arch: 'arm64',
      channel: 'nightly', preset: 'test', qualification: 'notarized', testReleaseId: 'c'.repeat(32),
    },
    actions: { workflowRunId: '42', workflowAttempt: '2', runnerName: 'mini', workflowName: 'macos-package' },
    files: [{
      name: 'deepseek-harness-1.0.0-mac-arm64.dmg', size: 11,
      sha256: 'd'.repeat(64), sha512: `${'e'.repeat(86)}==`,
    }],
    verification: {
      windowsAuthenticode: false, windowsTimestamp: false,
      macosCodeSignature: true, macosNotarization: true, feedValidated: true,
    },
  }
}

/**
 * Answer the source queries a publication run makes.
 * @param responses Answers the fixture overrides; each default names the packaged commit.
 * @param calls Recorded request paths.
 * @returns Read-only API stub.
 */
function sourceApi(
  responses: { readonly commit?: unknown; readonly compare?: unknown; readonly tag?: unknown } = {},
  calls: string[] = [],
): Api {
  return (path) => {
    calls.push(path)
    if (path.includes('/compare/')) return responses.compare ?? { status: 'identical' }
    if (path.includes('/commits/refs%2Ftags%2F')) return responses.tag ?? { sha: commit }
    return responses.commit ?? { sha: commit }
  }
}

it('accepts a branch that still contains the packaged commit', () => {
  const calls: string[] = []
  expect(() =>{  verifyDesktopSource(manifestFor('master'), sourceApi({ compare: { status: 'ahead' } }, calls)) })
    .not.toThrow()
  expect(calls).toEqual([
    `repos/owner/repo/commits/${commit}`,
    `repos/owner/repo/compare/${commit}...refs%2Fheads%2Fmaster`,
  ])
})

it('rejects a packaged source that left its branch history', () => {
  expect(() =>{  verifyDesktopSource(manifestFor('master'), sourceApi({ compare: { status: 'diverged' } })) })
    .toThrow('desktop publish: the packaged source left its branch history')
})

it('rejects a commit this repository does not hold', () => {
  expect(() =>{  verifyDesktopSource(manifestFor('master'), sourceApi({ commit: { sha: 'f'.repeat(40) } })) })
    .toThrow('desktop publish: the packaged commit is not in this repository')
})

it('accepts a release tag that still names the packaged commit', () => {
  const calls: string[] = []
  expect(() =>{  verifyDesktopSource(manifestFor('dsh-v1.0.0'), sourceApi({}, calls)) }).not.toThrow()
  expect(calls).toEqual([
    `repos/owner/repo/commits/${commit}`,
    'repos/owner/repo/commits/refs%2Ftags%2Fdsh-v1.0.0',
  ])
})

it('rejects a release tag that moved to another commit', () => {
  expect(() =>{  verifyDesktopSource(manifestFor('dsh-v1.0.0'), sourceApi({ tag: { sha: 'f'.repeat(40) } })) })
    .toThrow('desktop publish: the packaged source tag no longer names its commit')
})

it('accepts the preset environment while it keeps configured reviewers', () => {
  const calls: string[] = []
  const api: Api = (path) => {
    calls.push(path)
    return { protection_rules: [{ type: 'required_reviewers', reviewers: [{ login: 'reviewer' }] }] }
  }
  expect(() =>{  verifyDesktopApprovalEnvironment(manifestFor('master'), api) }).not.toThrow()
  expect(calls).toEqual(['repos/owner/repo/environments/desktop-test'])
})

const unprotected: readonly (readonly [name: string, rules: readonly unknown[]])[] = [
  ['no protection rule', []],
  ['a reviewer rule without reviewers', [{ type: 'required_reviewers', reviewers: [] }]],
  ['a wait timer alone', [{ type: 'wait_timer' }]],
]

it.each(unprotected)('rejects %s because desktop-test cannot approve itself', (_name, rules) => {
  expect(() =>{  verifyDesktopApprovalEnvironment(manifestFor('master'), () => ({ protection_rules: rules })) })
    .toThrow('desktop publish: desktop-test requires configured reviewers')
})
