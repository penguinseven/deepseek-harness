import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/desktop-publish.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, {
    name?: string
    defaults?: unknown
    needs?: string | string[]
    env?: Record<string, string>
    outputs?: Record<string, string>
    if?: string
    environment?: string
    concurrency?: { group: string; 'cancel-in-progress': boolean }
    'runs-on': string | string[]
    steps: Array<{
      id?: string
      name?: string
      if?: string
      uses?: string
      run?: string
      env?: Record<string, string>
      with?: Record<string, unknown>
    }>
  }>
}

it('selects packages manually and gates production secrets with the production Environment', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
    package_run_id: { type: 'string', required: true },
    package_run_attempt: { type: 'string', required: false, default: '' },
  } })
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
  const publish = workflow.jobs.publish!
  expect(publish.defaults).toBeUndefined()
  expect(publish.steps.find(step => step.id === 'key')?.run).toBe('node apps/desktop/scripts/read-desktop-app-key.mjs')
  expect(publish.if).toBeUndefined()
  expect(publish.environment).toBe("${{ needs.prepare.outputs.preset == 'production' && 'desktop-production' || 'desktop-test' }}")
  expect(publish.concurrency).toEqual({ group: 'desktop-publish-${{ needs.prepare.outputs.preset }}', 'cancel-in-progress': false })
  const ids = publish.steps.map(step => step.id)
  expect(ids.indexOf('check')).toBeLessThan(ids.indexOf('key'))
  expect(ids.indexOf('key')).toBeLessThan(ids.indexOf('app'))
  expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('publish'))
  for (const id of ['key', 'app']) expect(publish.steps.find(step => step.id === id)?.if)
    .toBe("needs.prepare.outputs.preset == 'production'")
  expect(publish.steps.find(step => step.id === 'app')?.with).toMatchObject({ 'permission-contents': 'write' })
  expect(publish.steps.find(step => step.id === 'publish')?.env?.DESKTOP_TAG_TOKEN).toBe('${{ steps.app.outputs.token }}')
})

it('resolves the packaged artifact instead of a machine and runs every job on hosted Linux', () => {
  const route = workflow.jobs.route!
  expect(route.if).toBeUndefined()
  expect(route.outputs).toEqual({
    selection: '${{ steps.route.outputs.selection }}',
    'artifact-id': '${{ steps.route.outputs.artifact-id }}',
    'artifact-name': '${{ steps.route.outputs.artifact-name }}',
    'workflow-sha': '${{ steps.route.outputs.workflow-sha }}',
  })
  const resolved = route.steps.find(step => step.id === 'route')!
  expect(resolved.run).toBe('node --import tsx apps/desktop/scripts/resolve-desktop-artifact-ci.ts')
  expect(resolved.env?.GH_TOKEN).toBe('${{ github.token }}')
  expect(route.steps.indexOf(resolved)).toBe(route.steps.length - 1)
  for (const job of Object.values(workflow.jobs)) expect(job['runs-on']).toBe('ubuntu-latest')
  expect(source).not.toContain('self-hosted')
  expect(source).not.toContain('DESKTOP_PUBLISH_RUNNERS')
  expect(source).not.toContain('DSH_DESKTOP_RELEASES_DIR')
})

it('downloads the selected artifact before verifying it without an Environment', () => {
  const prepare = workflow.jobs.prepare!
  const download = {
    name: '${{ needs.route.outputs.artifact-name }}',
    'run-id': '${{ inputs.package_run_id }}',
    'github-token': '${{ github.token }}',
    path: 'desktop-publisher/artifact-bundle',
  }
  for (const job of [prepare, workflow.jobs.publish!]) {
    const steps = job.steps
    const fetched = steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!
    expect(fetched.name).toBe('Download the selected package bundle')
    expect(fetched.with).toEqual(download)
    const checkout = steps.findIndex(step => step.uses?.startsWith('actions/checkout@'))
    const install = steps.findIndex(step => step.uses?.startsWith('pnpm/action-setup@'))
    const check = steps.findIndex(step => step.id === 'check')
    expect(checkout).toBeLessThan(steps.indexOf(fetched))
    expect(steps.indexOf(fetched)).toBeLessThan(install)
    expect(install).toBeLessThan(check)
  }
  expect(prepare.needs).toBe('route')
  expect(prepare.environment).toBeUndefined()
  expect(prepare.outputs).toEqual({
    route: '${{ steps.check.outputs.route }}',
    preset: '${{ steps.check.outputs.preset }}',
    approval: '${{ steps.check.outputs.approval }}',
    version: '${{ steps.check.outputs.version }}',
    label: '${{ steps.check.outputs.label }}',
  })
  const check = prepare.steps.find(step => step.id === 'check')!
  expect(check.run).toBe('node --import tsx apps/desktop/scripts/publish-desktop-ci.ts --check')
  expect(check.env).toEqual({
    DESKTOP_PUBLISH_ROUTE: '${{ needs.route.outputs.selection }}',
    DESKTOP_ARTIFACT_BUNDLE_DIR: '${{ github.workspace }}/desktop-publisher/artifact-bundle',
  })
  expect(prepare.steps.some(step => step.id === 'key' || step.id === 'app')).toBe(false)
  expect(workflow.jobs.publish!.needs).toEqual(['route', 'prepare'])
  expect(workflow.jobs.publish!.env?.DESKTOP_APPROVED_PACKAGE).toBe('${{ needs.prepare.outputs.approval }}')
  expect(workflow.jobs.publish!.env?.DESKTOP_PUBLISH_ROUTE).toBe('${{ needs.prepare.outputs.route }}')
})

it('loads upload credentials only in the approved publish job', () => {
  expect(workflow.jobs.route!.env).toBeUndefined()
  expect(workflow.jobs.prepare!.env).toEqual({ DSH_TELEMETRY_DISABLED: '1' })
  const publish = workflow.jobs.publish!
  expect(publish.env).toEqual({
    DESKTOP_APPROVED_PACKAGE: '${{ needs.prepare.outputs.approval }}',
    DESKTOP_PUBLISH_ROUTE: '${{ needs.prepare.outputs.route }}',
    DESKTOP_ARTIFACT_BUNDLE_DIR: '${{ github.workspace }}/desktop-publisher/artifact-bundle',
    DSH_TELEMETRY_DISABLED: '1',
  })
  expect(publish.steps.find(step => step.id === 'publish')?.env).toEqual({
    DESKTOP_TAG_TOKEN: '${{ steps.app.outputs.token }}',
    DSH_PUBLISH_CONFIG_JSON: '${{ secrets.DSH_PUBLISH_CONFIG_JSON }}',
    DSH_COS_CREDENTIALS_JSON: '${{ secrets.DSH_COS_CREDENTIALS_JSON }}',
    DSH_DESKTOP_PUBLISH_STATE_DIR: '${{ runner.temp }}',
  })
  const audit = publish.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))!
  expect(audit.if).toBe("always() && steps.publish.outputs.record != ''")
  expect(audit.with).toMatchObject({
    name: 'desktop-publication-${{ github.run_id }}-${{ github.run_attempt }}',
    path: '${{ steps.publish.outputs.record }}/',
    'if-no-files-found': 'error',
  })
})

it('accepts master or main dispatch and rejects other refs', () => {
  const command = workflow.jobs.route!.steps[0]!.run!
  expect(command.startsWith('node -e "')).toBe(true)
  const program = command.slice('node -e "'.length, -1)
  for (const ref of ['refs/heads/master', 'refs/heads/main', 'refs/heads/stale-feature']) {
    const result = spawnSync(process.execPath, ['-e', program], { env: { ...process.env, GITHUB_REF: ref }, encoding: 'utf8' })
    expect(result.signal).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(ref === 'refs/heads/stale-feature' ? 1 : 0)
    if (result.status !== 0) expect(result.stderr).toContain('must be dispatched from')
  }
})

it('mirrors the approved bytes after publication without any upload credential', () => {
  const mirror = workflow.jobs.mirror!
  expect(mirror.needs).toEqual(['route', 'prepare', 'publish'])
  // A failed mirror must never be reported as a failed publication: it runs only when every prior job succeeded.
  expect(mirror.if).toBe("always() && needs.route.result == 'success' && needs.prepare.result == 'success' && needs.publish.result == 'success'")
  expect(mirror['runs-on']).toBe('ubuntu-latest')
  expect(mirror.environment).toBe("${{ needs.prepare.outputs.preset == 'production' && 'desktop-production' || 'desktop-test' }}")
  expect(mirror.concurrency).toEqual({ group: 'desktop-mirror-${{ needs.prepare.outputs.preset }}', 'cancel-in-progress': false })
  expect(mirror.env).toEqual({
    DESKTOP_APPROVED_PACKAGE: '${{ needs.prepare.outputs.approval }}',
    DESKTOP_PUBLISH_ROUTE: '${{ needs.prepare.outputs.route }}',
    DESKTOP_ARTIFACT_BUNDLE_DIR: '${{ github.workspace }}/desktop-publisher/artifact-bundle',
    DSH_TELEMETRY_DISABLED: '1',
  })
  const fetched = mirror.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!
  expect(fetched.with).toEqual({
    name: '${{ needs.route.outputs.artifact-name }}',
    'run-id': '${{ inputs.package_run_id }}',
    'github-token': '${{ github.token }}',
    path: 'desktop-publisher/artifact-bundle',
  })
  const run = mirror.steps.find(step => step.id === 'mirror')!
  expect(run.run).toBe('node --import tsx apps/desktop/scripts/publish-desktop-ci.ts --mirror')
  expect(run.if).toBe("needs.prepare.outputs.preset == 'production'")
  // The mirror reads only the release token; COS credentials are absent, so it cannot re-upload or rewrite feeds.
  expect(run.env).toEqual({
    DESKTOP_TAG_TOKEN: '${{ steps.app.outputs.token }}',
    DSH_DESKTOP_PUBLISH_STATE_DIR: '${{ runner.temp }}',
  })
  for (const step of mirror.steps) {
    expect(Object.keys(step.env ?? {})).not.toContain('DSH_COS_CREDENTIALS_JSON')
    expect(Object.keys(step.env ?? {})).not.toContain('DSH_PUBLISH_CONFIG_JSON')
  }
  expect(mirror.steps.find(step => step.id === 'app')?.with).toMatchObject({ 'permission-contents': 'write' })
})

it('keeps one publish-phase flag per job so a mirror retry never republishes', () => {
  for (const name of ['route', 'prepare', 'publish', 'mirror']) {
    expect(workflow.jobs[name]!['runs-on']).toBe('ubuntu-latest')
  }
  const publish = workflow.jobs.publish!.steps.find(step => step.id === 'publish')!
  expect(publish.run).toBe('node --import tsx apps/desktop/scripts/publish-desktop-ci.ts --publish')
  const mirror = workflow.jobs.mirror!.steps.find(step => step.id === 'mirror')!
  expect(mirror.run).not.toContain('--publish')
  expect(workflow.jobs.mirror!.steps.some(step => step.id === 'publish')).toBe(false)
})
