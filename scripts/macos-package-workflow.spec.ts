import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/macos-package.yml')
const RELEASE_ID = '0123456789abcdef0123456789abcdef'
const workflow = yaml.load(readFileSync(workflowPath, 'utf8')) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    needs?: string | string[]
    'runs-on': string | string[]
    outputs?: Record<string, string>
    steps: Array<{ id?: string; name?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> }>
  }>
}

/**
 * Run the qualification step exactly as Actions would, with the notarization selection and repository variable it reads.
 * @param skipNotarization Selected debugging option, as Actions renders a boolean input.
 * @param signedRunner Repository variable holding the signing machine's labels.
 * @param releaseId Test release ID dispatched with the run.
 * @returns Recorded step output and the failure message, if the step refused the selection.
 */
function route(skipNotarization: string, signedRunner: string, releaseId = RELEASE_ID): { output: string; failure: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'macos-qualify-'))
  try {
    const outputPath = resolve(directory, 'output')
    const invocation = 'node -e "'
    const result = spawnSync(process.execPath, ['-e', workflow.jobs.qualify!.steps[0]!.run!.slice(invocation.length, -1)], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath,
        PACKAGE_SKIP_NOTARIZATION: skipNotarization, SIGNED_RUNNER: signedRunner, TEST_RELEASE_ID: releaseId },
    })
    return {
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
      failure: result.status === 0 ? '' : result.stderr,
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

it('confines Mac packaging to manual dispatch and chooses the runner from the notarization selection', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.jobs.package).not.toHaveProperty('name')
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { test_release_id: { type: 'string', default: '', required: false } } })
  expect(workflow.on.workflow_dispatch).not.toHaveProperty('inputs.publish')
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.concurrency).toEqual({ group: 'macos-desktop-package', 'cancel-in-progress': false })
  expect(workflow.jobs.package!.needs).toBe('qualify')
  expect(workflow.jobs.package!['runs-on']).toBe('${{ fromJSON(needs.qualify.outputs.runs-on) }}')
  expect(workflow.jobs.qualify!['runs-on']).toBe('ubuntu-latest')
  expect(workflow.jobs.qualify!.outputs).toEqual({
    qualification: '${{ steps.qualify.outputs.qualification }}',
    'runs-on': '${{ steps.qualify.outputs.runs-on }}',
  })
  const source = readFileSync(workflowPath, 'utf8')
  expect(source).not.toContain('dsh-mac-package-trial')
  expect(source).toContain('${{ vars.DESKTOP_MAC_SIGNED_RUNNER }}')
  const steps = workflow.jobs.package!.steps
  expect(steps.find(step => step.id === 'checkout')?.with).toMatchObject({ 'persist-credentials': false, clean: true })
  for (const step of steps) expect(step.run ?? '').not.toContain('${{ inputs.')
  const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(2)
  expect(uploads[0]?.if).toBe("always() && steps.checkout.outcome == 'success'")
  expect(uploads[0]?.with).toMatchObject({ path: 'apps/desktop/.desktop-build/packaging-runs/', 'retention-days': 14 })
  expect(uploads[1]?.if).toBe('success()')
  expect(uploads[1]?.with).toMatchObject({
    name: '${{ steps.retained.outputs.artifact-name }}',
    path: '${{ steps.retained.outputs.directory }}',
    'include-hidden-files': true,
    'if-no-files-found': 'error',
    'retention-days': '${{ inputs.skip_notarization && 30 || 90 }}',
  })
})

it('defaults to notarization and labels the explicit debugging option', () => {
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { skip_notarization: {
    type: 'boolean', default: false,
    description: '跳过公证和 stapling：仅限内部调试，不可用于发布或自动更新',
  } } })
  const steps = workflow.jobs.package!.steps
  expect(steps.filter(step => step.run?.includes('args+=(--skip-notarization)'))).toHaveLength(2)
  expect(steps.find(step => step.name === 'Retain verified artifact bundle')?.with?.name).toBe('${{ steps.retained.outputs.artifact-name }}')
})

it('sends unnotarized builds to a hosted runner and notarized builds to the configured signing labels', () => {
  expect(route('true', '')).toEqual({ output: 'qualification=unnotarized\nruns-on=["macos-14"]\n', failure: '' })
  expect(route('false', 'self-hosted, macOS, ARM64, my-signer')).toEqual({
    output: 'qualification=notarized\nruns-on=["self-hosted","macOS","ARM64","my-signer"]\n', failure: '',
  })
})

it('refuses a hosted build without the release ID its configuration requires', () => {
  for (const releaseId of ['', 'not-a-release-id']) {
    const { output, failure } = route('true', '', releaseId)
    expect(output).toBe('')
    expect(failure).toContain('test_release_id must contain 32 lowercase hexadecimal characters for hosted unnotarized packaging')
  }
})

it('refuses a notarized build before a runner is allocated when no signing machine is configured', () => {
  for (const selection of ['false', 'maybe']) {
    const { output, failure } = route(selection, '')
    expect(output).toBe('')
    expect(failure).toContain(selection === 'false'
      ? 'DESKTOP_MAC_SIGNED_RUNNER is not set; notarized macOS packaging needs the self-hosted signing machine'
      : 'Unknown notarization selection')
  }
})
