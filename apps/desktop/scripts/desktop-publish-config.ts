/** Read public deployment settings independently from upload and GitHub App secrets. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

const singleLine = z.string().min(1).regex(/^[^\r\n\0]+$/u, 'expected a single-line value')
const absolutePath = singleLine.refine(isAbsolute, 'expected an absolute path')
const schema = z.strictObject({
  bucket: z.string().regex(/^[a-z0-9-]+-\d+$/u),
  origin: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash }, 'expected an HTTPS origin'),
  // Machine configuration stores the credential pair in a file; hosted runners carry it as an Environment secret instead.
  credentialsFile: absolutePath.optional(),
  macOS: z.strictObject({ signingIdentity: z.string().min(1), teamId: z.string().regex(/^[A-Z0-9]{10}$/u) }).optional(),
  windows: z.strictObject({ certificateThumbprint: z.string().regex(/^[A-Fa-f0-9]{40}$/u) }).optional(),
  githubApp: z.strictObject({ clientId: singleLine, privateKeyFile: absolutePath.optional() }).optional(),
})
/** Public deployment configuration; secrets are file references or Environment-supplied JSON. */
export type DesktopPublishConfig = z.infer<typeof schema>

/** Environment secrets that replace machine configuration files on a hosted runner. */
export interface DesktopPublishSecrets {
  /** Deployment settings JSON, normally `DSH_PUBLISH_CONFIG_JSON`. */
  readonly configJson?: string | undefined
  /** COS credential pair JSON, normally `DSH_COS_CREDENTIALS_JSON`. */
  readonly credentialsJson?: string | undefined
}

/**
 * Collect the Environment-supplied secrets a hosted publication job can provide.
 * @param env Process environment of the publication job.
 * @returns Secret values; empty strings are treated as absent by their readers.
 */
export function desktopPublishSecrets(env: NodeJS.ProcessEnv): DesktopPublishSecrets {
  return { configJson: env.DSH_PUBLISH_CONFIG_JSON, credentialsJson: env.DSH_COS_CREDENTIALS_JSON }
}

function parseConfig(text: string, label: string): DesktopPublishConfig {
  try {
    return schema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`desktop publish: cannot read valid deployment settings from ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read one named deployment from Environment JSON, falling back to the machine configuration file.
 * @param configRoot Absolute machine packaging configuration directory, absent on a hosted runner.
 * @param preset Selected deployment from the verified bundle manifest.
 * @param secrets Environment-supplied settings that take precedence over the configuration file.
 * @returns Validated public configuration; production requires its fixed origin and App configuration.
 */
export async function readDesktopPublishConfig(
  configRoot: string | undefined, preset: 'test' | 'production', secrets: DesktopPublishSecrets = {},
): Promise<DesktopPublishConfig> {
  let config: DesktopPublishConfig
  if (secrets.configJson !== undefined && secrets.configJson.trim() !== '') {
    config = parseConfig(secrets.configJson, 'DSH_PUBLISH_CONFIG_JSON')
  } else {
    if (configRoot === undefined || !isAbsolute(configRoot)) throw new Error('desktop publish: configuration root must be absolute')
    const path = join(configRoot, 'publishing', `${preset}.json`)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error(`desktop publish: cannot read deployment settings at ${path}`)
    }
    config = parseConfig(text, `${preset} deployment settings`)
  }
  if (preset === 'production' && (config.origin !== 'https://download.deepseek.com' || !config.githubApp)) {
    throw new Error('desktop publish: production requires its fixed origin and GitHub App configuration')
  }
  return config
}

/**
 * Read the upload credential pair after authorization and local validation have passed.
 * @param config Previously validated public deployment configuration.
 * @param secrets Environment-supplied credentials that take precedence over the configured file.
 * @returns Explicit COS credential pair; contents never enter audit records.
 */
export async function readDesktopUploadCredentials(
  config: DesktopPublishConfig, secrets: DesktopPublishSecrets = {},
): Promise<{ secretId: string; secretKey: string }> {
  const field = z.strictObject({ secretId: z.string().min(1), secretKey: z.string().min(1) })
  try {
    const text = secrets.credentialsJson !== undefined && secrets.credentialsJson.trim() !== ''
      ? secrets.credentialsJson
      : config.credentialsFile === undefined ? undefined : await readFile(config.credentialsFile, 'utf8')
    if (text === undefined) throw new Error('no configured source')
    return field.parse(JSON.parse(text))
  } catch {
    throw new Error('desktop publish: cannot read a valid upload credential pair from the configured source')
  }
}
