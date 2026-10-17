/** Materialize the credential-free configuration a hosted unsigned or unnotarized packaging job reads. */
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeDesktopHostedConfig } from './desktop-hosted-config.ts'

/**
 * Write the hosted packaging settings and export the directory to the calling Actions job.
 * @param env Actions identity of the packaging job.
 * @returns The configuration directory, which the job exports as `DSH_PACKAGING_CONFIG_DIR`.
 * The release ID must be the one the run was dispatched with, so packaging and publication agree.
 */
export async function writeHostedPackagingConfig(env: NodeJS.ProcessEnv): Promise<string> {
  const testReleaseId = env.PACKAGE_TEST_RELEASE_ID?.trim() ?? ''
  if (!/^[a-f0-9]{32}$/u.test(testReleaseId)) {
    throw new Error('desktop hosted config: PACKAGE_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
  }
  const root = env.RUNNER_TEMP
  if (!root) throw new Error('desktop hosted config: RUNNER_TEMP is required')
  const config = await writeDesktopHostedConfig({ testReleaseId, root })
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `DSH_PACKAGING_CONFIG_DIR=${config.directory}\n`)
  process.stdout.write(`::add-mask::${config.directory}\n`)
  process.stdout.write(`desktop hosted config: wrote ${config.directory} for the ${config.environment} deployment\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `Hosted packaging configuration\n\nDeployment: ${config.environment}\n\nOrigin: ${config.origin}\n\nBucket: ${config.bucket}\n\nNo signing, notarization or upload credential is generated.\n`)
  }
  return config.directory
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await writeHostedPackagingConfig(process.env)
}
