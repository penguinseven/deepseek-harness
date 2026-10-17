/**
 * Materialize the credential-free packaging and publication settings a hosted runner needs.
 *
 * A self-hosted packaging machine owns `presets/<preset>.env`, `secrets/<platform>-signing.env` and
 * `publishing/<preset>.json` outside Git. A hosted unsigned or unnotarized job owns none of them, so it
 * writes only the public settings its mode reads and never writes a signing, notarization or COS credential.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Deployment a hosted run packages and plans publication for. */
export type DesktopHostedEnvironment = 'test'

/** Absolute configuration directory plus the public deployment identity it declares. */
export interface DesktopHostedConfig {
  /** Directory to export as `DSH_PACKAGING_CONFIG_DIR`. */
  readonly directory: string
  /** Deployment the generated preset and publication settings declare. */
  readonly environment: DesktopHostedEnvironment
  /** Public update origin written to both files. */
  readonly origin: string
  /** COS bucket the publication settings name; hosted jobs never receive its credentials. */
  readonly bucket: string
}

/**
 * Public deployment identity of each hosted mode.
 *
 * Both values are already public: the origin is the installer update URL and the bucket is copied into
 * every publication plan and approval summary. Hosted packaging therefore needs no secret to build.
 */
export const DESKTOP_HOSTED_DEPLOYMENT = {
  test: {
    origin: 'https://download-test.deepseek.com',
    bucket: 'bj-toc-download-test-1320056602',
    // The identifier every test installer carries; local unsigned macOS builds use the same default.
    appId: 'com.deepseek.harness',
    // Mandatory-update policy pages of the test deployment; the test policy also authenticates through it.
    policyOrigins: ['https://download-test.deepseek.com'],
  },
} as const satisfies Record<DesktopHostedEnvironment, {
  readonly origin: string
  readonly bucket: string
  readonly appId: string
  readonly policyOrigins: readonly string[]
}>

/**
 * Write the settings a hosted unsigned or unnotarized packaging run reads.
 *
 * `presets/test.env` declares the test deployment, its public origin, its COS bucket and the release ID the
 * packaging run was dispatched with; `publishing/test.json` repeats the bucket and origin without
 * `credentialsFile`, so every later step in the hosted job verifies a destination it cannot upload to.
 * @param options Release ID for the test batch and the directory to create the settings under.
 * @returns Absolute configuration directory and the deployment it declares.
 * A directory that already holds a preset rejects, so no caller silently overwrites machine settings.
 */
export async function writeDesktopHostedConfig(options: {
  readonly testReleaseId: string
  readonly root: string
}): Promise<DesktopHostedConfig> {
  const { origin, bucket, appId, policyOrigins } = DESKTOP_HOSTED_DEPLOYMENT.test
  const directory = join(options.root, 'dsh-packaging-config')
  await mkdir(join(directory, 'presets'), { recursive: true, mode: 0o700 })
  await mkdir(join(directory, 'publishing'), { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'presets', 'test.env'), [
    `DSH_DESKTOP_APP_ID=${appId}`,
    'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
    `DOWNLOAD_TEST_ORIGIN=${origin}`,
    `DOWNLOAD_TEST_RELEASE_ID=${options.testReleaseId}`,
    `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=${origin}`,
    `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG=${JSON.stringify({ allowedPageOrigins: policyOrigins, allowedAuthOrigins: policyOrigins })}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'publishing', 'test.json'),
    `${JSON.stringify({ bucket, origin: `${origin}/` }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { directory, environment: 'test', origin, bucket }
}
