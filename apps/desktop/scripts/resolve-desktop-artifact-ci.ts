/** Select the immutable package Artifact one publication run publishes, without downloading it. */
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  desktopArtifactName,
  desktopArtifactQualificationSchema,
  desktopArtifactTargetSchema,
  type DesktopArtifactQualification,
  type DesktopArtifactTarget,
} from './desktop-artifact-bundle.ts'

const positiveId = z.string().regex(/^[1-9]\d*$/u)
const inputsSchema = z.object({
  package_run_id: positiveId,
  package_run_attempt: z.union([positiveId, z.literal('')]).optional(),
})
const runSchema = z.object({
  id: z.number().int().positive(), run_attempt: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  status: z.literal('completed'), conclusion: z.literal('success'), event: z.literal('workflow_dispatch'),
  path: z.enum(['.github/workflows/macos-package.yml', '.github/workflows/windows-package.yml']),
  repository: z.object({ full_name: z.string() }),
})
const jobsSchema = z.object({
  jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
})
const artifactsSchema = z.object({
  artifacts: z.array(z.object({ id: z.number().int().positive(), name: z.string(), expired: z.boolean() })),
})

/**
 * Package Artifact identity a publication run resolves before it downloads any bytes.
 * Every field comes from GitHub's own record of the package attempt, never from the bundle it selects.
 */
export interface DesktopArtifactSelection {
  /** Packaging workflow run that uploaded the artifact. */
  readonly runId: string
  /** Successful attempt of that run. */
  readonly attempt: string
  /** Artifact ID, retained for audit and for download-step diagnostics. */
  readonly artifactId: string
  /** Exact artifact name, which is also the bundle directory name. */
  readonly artifactName: string
  /** Commit the packaging workflow ran from; the bundle must record it as its workflow commit. */
  readonly workflowSha: string
  readonly target: DesktopArtifactTarget
  readonly qualification: DesktopArtifactQualification
  /** Build version the artifact name carries. */
  readonly version: string
}

/**
 * Read the build identity an artifact name records for one exact attempt.
 * The target and qualification are read as the schema's own members, because a version may contain
 * dashes and any general split of the name would then misread it.
 * @param name Artifact name as GitHub reports it.
 * @param runId Packaging run the name must carry.
 * @param attempt Packaging attempt the name must carry.
 * @returns Parsed build identity, or undefined when the name describes unreadable or other evidence.
 */
function packagedBuild(
  name: string, runId: string, attempt: string,
): { target: DesktopArtifactTarget; qualification: DesktopArtifactQualification; version: string } | undefined {
  const prefix = 'desktop-'
  const suffix = `-${runId}-${attempt}`
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) return undefined
  const identity = name.slice(prefix.length, name.length - suffix.length)
  for (const target of desktopArtifactTargetSchema.options) {
    for (const qualification of desktopArtifactQualificationSchema.options) {
      const heading = `${target}-${qualification}-`
      if (!identity.startsWith(heading)) continue
      const build = { target, qualification, version: identity.slice(heading.length) }
      try {
        if (desktopArtifactName(build, runId, attempt) === name) return build
      } catch { continue }
    }
  }
  return undefined
}

/**
 * Resolve the Artifact uploaded by one successful package attempt without downloading it.
 * @param repository Repository containing the package workflow; never a value the caller can redirect.
 * @param inputsValue Manual dispatch inputs naming the package run and an optional attempt.
 * @param api Read-only GitHub JSON request; pagination is requested for the list endpoints.
 * @returns Selected run, attempt, workflow commit and artifact identity.
 * Failed, cancelled, foreign, expired or ambiguous evidence rejects before any download.
 */
export function selectDesktopArtifact(
  repository: string,
  inputsValue: unknown,
  api: (path: string, paginate?: boolean) => unknown,
): DesktopArtifactSelection {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('desktop publish: invalid repository')
  const inputs = inputsSchema.parse(inputsValue)
  const base = `repos/${repository}/actions/runs/${inputs.package_run_id}`
  const attempt = inputs.package_run_attempt
    || String(z.object({ run_attempt: z.number().int().positive() }).parse(api(base)).run_attempt)
  const run = runSchema.parse(api(`${base}/attempts/${attempt}`))
  if (String(run.id) !== inputs.package_run_id || String(run.run_attempt) !== attempt
    || run.repository.full_name !== repository) {
    throw new Error('desktop publish: selected run or attempt does not match GitHub evidence')
  }
  const jobs = z.array(jobsSchema).parse(api(`${base}/attempts/${attempt}/jobs?per_page=100`, true)).flatMap(page => page.jobs)
  if (jobs.filter(job => job.name === 'package' && job.conclusion === 'success').length !== 1) {
    throw new Error('desktop publish: expected one successful package job')
  }
  const artifacts = z.array(artifactsSchema).parse(api(`${base}/artifacts?per_page=100`, true)).flatMap(page => page.artifacts)
  const matches = artifacts.flatMap((artifact) => {
    const build = packagedBuild(artifact.name, inputs.package_run_id, attempt)
    return build === undefined ? [] : [{ artifact, build }]
  })
  if (matches.length !== 1) throw new Error('desktop publish: expected one package artifact for this attempt')
  const selected = matches[0]!
  if (selected.artifact.expired) throw new Error('desktop publish: the package artifact has expired')
  if ((run.path === '.github/workflows/windows-package.yml') !== (selected.build.target === 'win-x64')) {
    throw new Error('desktop publish: the package workflow does not build the selected target')
  }
  return {
    runId: inputs.package_run_id, attempt, artifactId: String(selected.artifact.id), artifactName: selected.artifact.name,
    workflowSha: run.head_sha, target: selected.build.target, qualification: selected.build.qualification,
    version: selected.build.version,
  }
}

/**
 * Read GitHub JSON with bounded execution and output size.
 * @param path Repository API path.
 * @param paginate Whether to return all pages as an array.
 * @returns Parsed JSON, validated by the caller before use.
 */
export function desktopPublishApi(path: string, paginate = false): unknown {
  return JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT) {
    throw new Error('desktop publish: Actions context required')
  }
  const event = z.object({ inputs: inputsSchema })
    .parse(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')))
  const selection = selectDesktopArtifact(env.GITHUB_REPOSITORY, event.inputs, desktopPublishApi)
  await appendFile(env.GITHUB_OUTPUT, [
    `selection=${JSON.stringify(selection)}`,
    `artifact-id=${selection.artifactId}`,
    `artifact-name=${selection.artifactName}`,
    `workflow-sha=${selection.workflowSha}`,
    '',
  ].join('\n'))
}
