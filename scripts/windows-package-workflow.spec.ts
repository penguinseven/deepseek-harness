import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const RELEASE_ID = '0123456789abcdef0123456789abcdef'
type Step = {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')) as {
  on: Record<string, { inputs: Record<string, { required?: boolean; default?: string; description?: string }> }>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    needs?: string | string[]
    'runs-on': string
    'timeout-minutes'?: number
    outputs?: Record<string, string>
    env?: Record<string, string>
    steps: Step[]
  }>
}
const job = workflow.jobs.package!
const qualify = workflow.jobs.qualify!

/**
 * Run the qualification step exactly as Actions would, with the signing selection and repository variable it reads.
 * @param signing Selected signing mode.
 * @param signedRunner Repository variable holding the signing machine's labels.
 * @param releaseId Test release ID dispatched with the run.
 * @returns Recorded step output and the failure message, if the step refused the selection.
 */
function route(signing: string, signedRunner: string, releaseId = RELEASE_ID): { output: string; failure: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'windows-qualify-'))
  try {
    const outputPath = resolve(directory, 'output')
    const invocation = 'node -e "'
    const result = spawnSync(process.execPath, ['-e', qualify.steps[0]!.run!.slice(invocation.length, -1)], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath, PACKAGE_SIGNING: signing, SIGNED_RUNNER: signedRunner, TEST_RELEASE_ID: releaseId },
    })
    return {
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
      failure: result.status === 0 ? '' : result.stderr,
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

it.skipIf(process.platform !== 'win32')('resets only the allocated checkout without following dependency junctions', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'windows-checkout-'))
  try {
    const parent = resolve(directory, 'runner-workspace')
    const workspace = resolve(parent, 'repository')
    const external = resolve(directory, 'external')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(external)
    writeFileSync(resolve(external, 'keep.txt'), 'keep')
    symlinkSync(external, resolve(workspace, 'node_modules'), 'junction')
    const script = resolve(directory, 'reset.ps1')
    writeFileSync(script, job.steps.find(step => step.name === 'Reset packaging checkout')!.run!)
    const run = (target: string) => execFileSync('pwsh', ['-NoProfile', '-File', script], {
      cwd: directory,
      env: { ...process.env, RUNNER_WORKSPACE: parent, GITHUB_WORKSPACE: target },
      stdio: 'pipe',
    })
    run(workspace)
    expect(existsSync(workspace)).toBe(true)
    expect(existsSync(resolve(workspace, 'node_modules'))).toBe(false)
    expect(readFileSync(resolve(external, 'keep.txt'), 'utf8')).toBe('keep')
    expect(() => run(external)).toThrow()
    rmSync(workspace, { recursive: true })
    symlinkSync(external, workspace, 'junction')
    expect(() => run(workspace)).toThrow()
    expect(readFileSync(resolve(external, 'keep.txt'), 'utf8')).toBe('keep')
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

it('routes manual packaging to a hosted or signing runner without naming either machine', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.jobs.package).not.toHaveProperty('name')
  expect(job.needs).toBe('qualify')
  expect(job['runs-on']).toBe('${{ fromJSON(needs.qualify.outputs.runs-on) }}')
  expect(qualify['runs-on']).toBe('ubuntu-latest')
  expect(qualify.outputs).toEqual({
    qualification: '${{ steps.qualify.outputs.qualification }}',
    'runs-on': '${{ steps.qualify.outputs.runs-on }}',
  })
  const source = readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')
  for (const machine of ['dsh-win-package-trial', 'SIGNED_RUNNER is hardcoded']) expect(source).not.toContain(machine)
  expect(source).toContain('${{ vars.DESKTOP_WIN_SIGNED_RUNNER }}')
  expect(workflow.concurrency).toEqual({ group: 'windows-desktop-package', 'cancel-in-progress': false })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(workflow.on.workflow_dispatch!.inputs).sort()).toEqual([
    'build_version', 'preset', 'signing', 'source_ref', 'test_release_id', 'update_channel', 'version_mode',
  ])
  expect(workflow.on.workflow_dispatch!.inputs.signing!.default).toBe('unsigned')
  expect(workflow.on.workflow_dispatch!.inputs.build_version!.required).toBe(false)
  expect(workflow.on.workflow_dispatch!.inputs.version_mode!.default).toBe('default')
  expect(workflow.on.workflow_dispatch!.inputs.source_ref!.default).toBe('master')
  expect(workflow.on.workflow_dispatch!.inputs.update_channel!.default).toBe('nightly')
  expect(job.env).toMatchObject({
    PACKAGE_VERSION_MODE: '${{ inputs.version_mode }}',
    PACKAGE_SOURCE_REF: '${{ inputs.source_ref }}',
    DSH_DESKTOP_UPDATE_CHANNEL: '${{ inputs.update_channel }}',
    DSH_PACKAGING_PRESET: '${{ inputs.preset }}',
    PACKAGE_SIGNING: '${{ inputs.signing }}',
  })
  expect(job.steps.find(step => step.id === 'checkout')!.with).toMatchObject({ clean: true, 'persist-credentials': false, ref: '${{ inputs.source_ref }}' })
  expect(job.steps.find(step => step.uses?.startsWith('pnpm/action-setup@'))?.with?.dest)
    .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}')
})

it('validates before building and passes the same mode and version to checks and packaging', () => {
  const settings = job.steps.find(step => step.id === 'settings')!
  expect(settings.env).toEqual({ PACKAGE_BUILD_VERSION: '${{ inputs.build_version }}' })
  const commands = job.steps.filter(step => step.run?.includes('package:desktop:win:x64'))
  expect(commands).toHaveLength(2)
  expect(commands[0]!.run).toContain("'--check'")
  for (const step of commands) {
    expect(step.env?.PACKAGE_VERSION).toBe('${{ steps.settings.outputs.version }}')
    expect(step.run).toContain("if ($env:PACKAGE_SIGNING -eq 'unsigned') { $packageArgs += '--unsigned' }")
    expect(step.run).toContain('exit $LASTEXITCODE')
  }
  for (const step of job.steps) expect(step.run ?? '').not.toContain('${{ inputs.')
  expect(job.steps.indexOf(settings)).toBeLessThan(job.steps.indexOf(commands[0]!))
  expect(job.steps.some(step => step.run?.includes('.env.windows'))).toBe(false)
})

it('retains failure diagnostics and uploads the verified bundle for the selected mode', () => {
  const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(3)
  expect(uploads[0]!.if).toBe("always() && steps.checkout.outcome == 'success'")
  expect(uploads[0]!.with).toMatchObject({
    path: 'apps/desktop/.desktop-build/packaging-runs/', 'include-hidden-files': true, 'retention-days': 14,
  })
  for (const [mode, retention] of [['unsigned', 30], ['signed', 90]] as const) {
    const upload = uploads.find(step => step.if === `success() && inputs.signing == '${mode}'`)!
    expect(upload.name).toBe(`Retain verified ${mode} artifact bundle`)
    expect(upload.with).toMatchObject({
      name: '${{ steps.retained.outputs.artifact-name }}',
      path: '${{ steps.retained.outputs.directory }}',
      'include-hidden-files': true,
      'if-no-files-found': 'error',
      'retention-days': retention,
    })
  }
})

it('sends unsigned builds to a hosted runner and signed builds to the configured signing labels', () => {
  expect(route('unsigned', '')).toEqual({ output: 'qualification=unsigned\nruns-on=["windows-latest"]\n', failure: '' })
  expect(route('signed', 'self-hosted, Windows, X64, my-signer')).toEqual({
    output: 'qualification=signed\nruns-on=["self-hosted","Windows","X64","my-signer"]\n', failure: '',
  })
})

it('refuses a hosted build without the release ID its configuration requires', () => {
  for (const releaseId of ['', 'not-a-release-id']) {
    const { output, failure } = route('unsigned', '', releaseId)
    expect(output).toBe('')
    expect(failure).toContain('test_release_id must contain 32 lowercase hexadecimal characters for hosted unsigned packaging')
  }
})

it('refuses a signed build before a runner is allocated when no signing machine is configured', () => {
  for (const signing of ['signed', 'unknown']) {
    const { output, failure } = route(signing, '')
    expect(output).toBe('')
    expect(failure).toContain(signing === 'signed'
      ? 'DESKTOP_WIN_SIGNED_RUNNER is not set; signed Windows packaging needs the self-hosted signing machine'
      : 'Unknown signing mode')
  }
})
