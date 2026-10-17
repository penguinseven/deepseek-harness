import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { loadDesktopPackageEnvironment } from '../apps/desktop/scripts/desktop-package-environment.mjs'
import { readDesktopPublishConfig } from '../apps/desktop/scripts/desktop-publish-config.ts'

const root = resolve(import.meta.dirname, '..')
const RELEASE_ID = '0123456789abcdef0123456789abcdef'

type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string> }

/** Generated publication settings; the file carries no credential reference. */
const publishingSchema = z.strictObject({ bucket: z.string(), origin: z.string() })

type Job = { env?: Record<string, string>; steps: Step[] }

function workflow(path: string): { jobs: Record<string, Job> } {
  return yaml.load(readFileSync(resolve(root, '.github/workflows', path), 'utf8')) as { jobs: Record<string, Job> }
}

/**
 * Run the hosted configuration step the way Actions would: it writes the directory into `GITHUB_ENV`.
 * @param environment Extra step environment, normally the dispatch inputs the workflow forwards.
 * @returns The materialized configuration directory and everything the step wrote.
 */
function writeHostedConfig(environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-'))
  const envFile = join(directory, 'env')
  writeFileSync(envFile, '')
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/desktop/scripts/hosted-config-command.ts'], {
    cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH!, RUNNER_TEMP: directory, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      PACKAGE_TEST_RELEASE_ID: RELEASE_ID, ...environment },
  })
  const configRoot = parseEnv(readFileSync(envFile, 'utf8')).DSH_PACKAGING_CONFIG_DIR ?? ''
  return { directory, envFile, result, configRoot }
}

it.each(['windows-package.yml', 'macos-package.yml'])(
  '%s writes its hosted configuration from repository code before the preset is validated', (path) => {
    const job = workflow(path).jobs.package!
    const steps = job.steps
    const hosted = steps.findIndex(step => step.name === 'Write the hosted packaging configuration')
    const settings = steps.findIndex(step => step.id === 'settings')
    const checkout = steps.findIndex(step => step.uses?.startsWith('actions/checkout@'))
    expect(hosted).toBeGreaterThan(checkout)
    expect(hosted).toBeLessThan(settings)
    // The hosted mode is the mode that owns no machine preset: unsigned Windows, unnotarized macOS.
    expect(steps[hosted]!.if).toBe(path === 'windows-package.yml' ? "inputs.signing == 'unsigned'" : 'inputs.skip_notarization')
    expect(steps[hosted]!.run).toBe('node --import tsx apps/desktop/scripts/hosted-config-command.ts')
    // Only the dispatch selector reaches the step; no environment secret does.
    for (const step of steps) {
      for (const name of Object.keys(step.env ?? {})) expect(name).not.toMatch(/SECRET|APPLE_|CSC_|TOKEN|PASSWORD/u)
    }
    expect(job.env?.PACKAGE_TEST_RELEASE_ID).toBe('${{ inputs.test_release_id }}')
    expect(job.env?.DSH_PACKAGING_PRESET).toBe('${{ inputs.preset }}')
    const source = readFileSync(resolve(root, '.github/workflows', path), 'utf8')
    expect(source).not.toContain('secrets.')
  },
)

it('materializes a credential-free configuration that both hosted platforms accept', async () => {
  const hosted = writeHostedConfig()
  try {
    expect(hosted.result.stderr).toBe('')
    expect(hosted.result.status).toBe(0)
    const preset = parseEnv(readFileSync(join(hosted.configRoot, 'presets', 'test.env'), 'utf8'))
    expect(preset).toMatchObject({
      DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
      DOWNLOAD_TEST_ORIGIN: 'https://download-test.deepseek.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    })
    // No signing, notarization or upload credential is written anywhere in the directory.
    const publishing = publishingSchema.parse(JSON.parse(readFileSync(join(hosted.configRoot, 'publishing', 'test.json'), 'utf8')))
    expect(publishing).toEqual({ bucket: 'bj-toc-download-test-1320056602', origin: 'https://download-test.deepseek.com/' })
    expect(existsSync(join(hosted.configRoot, 'secrets'))).toBe(false)

    const selection = { DSH_PACKAGING_PRESET: 'test', DSH_PACKAGING_CONFIG_DIR: hosted.configRoot }
    const windows = loadDesktopPackageEnvironment('win32', selection, root, { unsigned: true })
    expect(windows.DSH_DESKTOP_WINDOWS_CER_FILE).toBeUndefined()
    const macos = loadDesktopPackageEnvironment('darwin', selection, root, { skipNotarization: true, adHocSigning: true })
    expect(macos.CSC_LINK).toBeUndefined()
    expect(macos.APPLE_API_KEY).toBeUndefined()
    // The hosted destination is verifiable without any credential, which is all a hosted job may do.
    await expect(readDesktopPublishConfig(hosted.configRoot, 'test', {})).resolves.toMatchObject({
      bucket: 'bj-toc-download-test-1320056602',
    })
  } finally { rmSync(hosted.directory, { recursive: true, force: true }) }
})

it('refuses a hosted configuration without the release ID the run was dispatched with', () => {
  const hosted = writeHostedConfig({ PACKAGE_TEST_RELEASE_ID: 'not-a-release-id' })
  try {
    expect(hosted.result.status).toBe(1)
    expect(hosted.result.stderr).toContain('PACKAGE_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
    expect(readFileSync(hosted.envFile, 'utf8')).toBe('')
  } finally { rmSync(hosted.directory, { recursive: true, force: true }) }
})
