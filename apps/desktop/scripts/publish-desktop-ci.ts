/**
 * Publish the package Artifact the routing job selected, and mirror the published bytes into a GitHub Release.
 *
 * Each mode owns one phase. `--check` reads no upload credential and contacts no COS; `--publish` writes COS, the
 * update feeds and the release tag, and settles its own journal `complete` when those succeed; `--mirror` copies the
 * same approved bytes into `desktop-v<version>` and owns a separate journal, so retrying the mirror never re-runs
 * COS or the feeds, and a mirror failure never fails the publication.
 */
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  desktopArtifactQualificationSchema,
  desktopArtifactTargetSchema,
  verifyDesktopArtifactBundle,
  type DesktopArtifactBundle,
  type DesktopArtifactManifest,
} from './desktop-artifact-bundle.ts'
import {
  desktopPublishSecrets,
  readDesktopPublishConfig,
  readDesktopUploadCredentials,
  type DesktopPublishConfig,
} from './desktop-publish-config.ts'
import { createDesktopUploadPlan, type DesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopPublishCos } from './desktop-publish-cos.ts'
import { createDesktopPublicationRecord, settleDesktopMirrorRecords, wasDesktopAttemptPublished,
  withDesktopChannelLock, type DesktopMirrorStatus, type DesktopPublicationStatus } from './desktop-publish-record.ts'
import { desktopReleaseAssets, mirrorDesktopRelease } from './desktop-release-mirror.ts'
import { publishDesktopRelease } from './desktop-publish.ts'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'
import { desktopMirrorOutcomeSummary, desktopPublicationOutcomeSummary, desktopPublicationSummary,
  type DesktopMirrorOutcome } from './desktop-publication-summary.ts'
import { publishDesktopTag } from './desktop-publish-tag.ts'
import { desktopPublishApi, type DesktopArtifactSelection } from './resolve-desktop-artifact-ci.ts'

/** Identity the routing job resolved from GitHub; every later phase re-proves it against its own download. */
const selectionSchema = z.object({
  runId: z.string().regex(/^[1-9]\d*$/u),
  attempt: z.string().regex(/^[1-9]\d*$/u),
  artifactId: z.string().regex(/^[1-9]\d*$/u),
  artifactName: z.string().min(1),
  workflowSha: z.string().regex(/^[a-f0-9]{40}$/u),
  target: desktopArtifactTargetSchema,
  qualification: desktopArtifactQualificationSchema,
  version: z.string().min(1),
})

/** Verified publication inputs shared by the publication job and manual channel restoration. */
export interface DesktopPublicationPreparation {
  /** Routed identity this preparation re-proved against the downloaded bundle. */
  readonly selection: DesktopArtifactSelection
  /** Bundle whose release directory is the complete upload set. */
  readonly bundle: DesktopArtifactBundle
  readonly manifest: DesktopArtifactManifest
  /** Public deployment configuration of the preset the manifest selected. */
  readonly config: DesktopPublishConfig
  /** Validated upload plan; its YAML contents are the bytes publication writes. */
  readonly plan: DesktopUploadPlan
  /** Directory holding this runner's channel lock and publication journal. */
  readonly stateRoot: string
  /** Digest the reviewer approves; publication recomputes it and stops on any change. */
  readonly approval: string
}

/**
 * Select the state root holding the channel lock and the publication journal.
 * @param env Publication environment; a hosted runner supplies its disposable temporary directory.
 * @returns Absolute state root, which never survives its runner.
 */
function publicationStateRoot(env: NodeJS.ProcessEnv): string {
  return env.DSH_DESKTOP_PUBLISH_STATE_DIR || env.RUNNER_TEMP || tmpdir()
}

/**
 * Verify the downloaded bundle against the routed identity and plan its upload.
 * @param env Routed selection, downloaded bundle directory, Actions identity and deployment settings.
 * @returns Bundle, manifest, upload plan and approval digest.
 * No upload credential is read, no COS request is sent, and altered or substituted bytes reject.
 */
export async function prepareDesktopPublication(env: NodeJS.ProcessEnv): Promise<DesktopPublicationPreparation> {
  const repository = env.GITHUB_REPOSITORY
  if (!repository) throw new Error('desktop publish: GITHUB_REPOSITORY is required')
  const directory = env.DESKTOP_ARTIFACT_BUNDLE_DIR
  if (!directory) throw new Error('desktop publish: DESKTOP_ARTIFACT_BUNDLE_DIR is required')
  const selection = selectionSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  const bundle = await verifyDesktopArtifactBundle(directory, { repository, runId: selection.runId,
    attempt: selection.attempt, artifactName: selection.artifactName, target: selection.target })
  const { manifest } = bundle
  if (manifest.build.qualification !== selection.qualification || manifest.build.version !== selection.version
    || manifest.source.workflowSha !== selection.workflowSha) {
    throw new Error('desktop publish: the downloaded bundle differs from the routed package')
  }
  // Only a signed Windows build or a notarized macOS build carries the evidence production distribution requires.
  if (manifest.build.qualification !== (manifest.build.target === 'win-x64' ? 'signed' : 'notarized')) {
    throw new Error('desktop publish: an unsigned or unnotarized bundle cannot be published')
  }
  const buildRecord = bundle.publication.get('build-record.json')
  if (buildRecord === undefined) throw new Error('desktop publish: the bundle carries no packaging completion record')
  const config = await readDesktopPublishConfig(env.DSH_PACKAGING_CONFIG_DIR, manifest.build.preset, desktopPublishSecrets(env))
  const environment = manifest.build.preset === 'test'
    ? { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: config.origin,
      DOWNLOAD_TEST_RELEASE_ID: manifest.build.testReleaseId ?? '', DOWNLOAD_TEST_COS_BUCKET: config.bucket }
    : { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: config.bucket }
  const plan = await createDesktopUploadPlan(manifest.build.target, { artifactsRoot: bundle.releaseDirectory,
    buildRecord, packagedProductVersion: manifest.build.productVersion,
    environment: { ...environment, DSH_DESKTOP_UPDATE_CHANNEL: manifest.build.channel } })
  if (plan.version !== manifest.build.version || plan.commit !== manifest.source.sha || plan.dirty !== false) {
    throw new Error('desktop publish: the bundle records a different version, commit or dirty checkout than the upload plan')
  }
  const approval = createHash('sha256')
    .update(JSON.stringify({ manifest, evidence: [...bundle.evidence], plan })).digest('hex')
  if (env.DESKTOP_APPROVED_PACKAGE && env.DESKTOP_APPROVED_PACKAGE !== approval) {
    throw new Error('desktop publish: package or destination changed after approval')
  }
  return { selection, bundle, manifest, config, plan, stateRoot: publicationStateRoot(env), approval }
}

/**
 * Require the packaged commit to remain in this repository under the ref the manifest names.
 * @param manifest Verified bundle manifest carrying the packaged commit and ref.
 * @param api Read-only GitHub JSON request.
 * Branch advances are allowed; deletion, a force-push out of the branch and a moved source tag reject.
 */
export function verifyDesktopSource(
  manifest: DesktopArtifactManifest, api: (path: string, paginate?: boolean) => unknown,
): void {
  const { repository, source } = manifest
  const commit = z.object({ sha: z.string() }).parse(api(`repos/${repository}/commits/${source.sha}`))
  if (commit.sha !== source.sha) throw new Error('desktop publish: the packaged commit is not in this repository')
  if (!/^dsh-v[0-9][0-9A-Za-z.-]*$/u.test(source.ref)) {
    const comparison = z.object({ status: z.string() })
      .parse(api(`repos/${repository}/compare/${source.sha}...${encodeURIComponent(`refs/heads/${source.ref}`)}`))
    if (!['ahead', 'identical'].includes(comparison.status)) {
      throw new Error('desktop publish: the packaged source left its branch history')
    }
    return
  }
  const tag = z.object({ sha: z.string() })
    .parse(api(`repos/${repository}/commits/${encodeURIComponent(`refs/tags/${source.ref}`)}`))
  if (tag.sha !== source.sha) throw new Error('desktop publish: the packaged source tag no longer names its commit')
}

/**
 * Require the deployment Environment that gates this publication to keep its reviewers.
 * @param manifest Verified bundle manifest naming the preset.
 * @param api Read-only GitHub JSON request.
 * A missing review rule cannot approve itself, so publication stops before it does anything.
 */
export function verifyDesktopApprovalEnvironment(
  manifest: DesktopArtifactManifest, api: (path: string, paginate?: boolean) => unknown,
): void {
  const name = `desktop-${manifest.build.preset}`
  const environment = z.object({ protection_rules: z.array(z.object({
    type: z.string(), reviewers: z.array(z.unknown()).optional(),
  })) }).parse(api(`repos/${manifest.repository}/environments/${name}`))
  if (!environment.protection_rules.some(rule => rule.type === 'required_reviewers' && (rule.reviewers?.length ?? 0) > 0)) {
    throw new Error(`desktop publish: ${name} requires configured reviewers`)
  }
}

/**
 * Report the publication phase in the run's step summary.
 * @param env Actions environment carrying the summary path.
 * @param plan Validated upload plan naming the target, version and deployment.
 * @param selection Routed package identity the summary cross-checks.
 * @param status Terminal publication state reached by this invocation.
 * @param preset Packaging preset the bundle declared; only production publishes a Release to mirror.
 * @returns Nothing; a run without a summary path writes none.
 * The Release outcome is a separate phase's result, so this summary names only what COS, the feeds and the tag did.
 */
async function appendPublicationSummary(
  env: NodeJS.ProcessEnv, plan: DesktopUploadPlan, selection: DesktopArtifactSelection,
  status: DesktopPublicationStatus, preset: 'test' | 'production',
): Promise<void> {
  if (!env.GITHUB_STEP_SUMMARY) return
  try {
    await appendFile(env.GITHUB_STEP_SUMMARY, desktopPublicationOutcomeSummary(plan, selection, status, preset))
  } catch (error) {
    // The release already happened; a summary write must not turn it into a failed publication.
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'publication summary'))}\n`)
  }
}

/**
 * Report one mirror invocation and, when it settles the attempt, the records it synchronised.
 * @param env Actions environment carrying the summary path.
 * @param plan Validated upload plan naming the target and version being mirrored.
 * @param manifest Verified bundle manifest naming the channel.
 * @param outcome Terminal mirror state, including the failure that leaves `release-mirror-pending`.
 * @returns Nothing; a run without a summary path writes none.
 */
async function appendMirrorSummary(
  env: NodeJS.ProcessEnv, plan: DesktopUploadPlan, manifest: DesktopArtifactManifest,
  outcome: DesktopMirrorOutcome,
): Promise<void> {
  if (!env.GITHUB_STEP_SUMMARY) return
  try {
    await appendFile(env.GITHUB_STEP_SUMMARY, desktopMirrorOutcomeSummary(plan, manifest, outcome))
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'mirror summary'))}\n`)
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  let phase = 'downloaded package, source and destination verification'
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--publish' && mode !== '--mirror')) {
      throw new Error('Usage: publish-desktop-ci.ts --check|--publish|--mirror')
    }
    const env = process.env
    const { selection, bundle, manifest, config, plan, stateRoot, approval } = await prepareDesktopPublication(env)
    verifyDesktopSource(manifest, desktopPublishApi)
    verifyDesktopApprovalEnvironment(manifest, desktopPublishApi)
    if (mode !== '--check' && !env.DESKTOP_APPROVED_PACKAGE) {
      throw new Error('desktop publish: approved package digest is required')
    }
    if (mode === '--check') {
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, [
        `approval=${approval}`,
        `route=${JSON.stringify(selection)}`,
        `preset=${manifest.build.preset}`,
        `version=${plan.version}`,
        `label=${plan.version} → ${manifest.build.channel} / ${plan.target} / ${plan.environment}`,
        '',
      ].join('\n'))
      if (env.GITHUB_STEP_SUMMARY && !env.DESKTOP_APPROVED_PACKAGE) {
        await appendFile(env.GITHUB_STEP_SUMMARY, await desktopPublicationSummary(manifest, plan, approval))
      }
      if (env.GITHUB_OUTPUT && config.githubApp) {
        await appendFile(env.GITHUB_OUTPUT, `app-client-id=${config.githubApp.clientId}\n`)
      }
      process.stdout.write(`desktop publish: verified ${plan.target} ${plan.version}; no upload credential read and no COS request made\n`)
    } else if (mode === '--mirror') {
      // Separate phase: the release files here are the ones COS already serves, so nothing is re-uploaded or rewritten.
      if (plan.environment !== 'production') throw new Error('desktop publish: only a production release has a GitHub Release to mirror')
      const mirrorToken = env.DESKTOP_TAG_TOKEN
      if (!mirrorToken) throw new Error('desktop publish: GitHub App token is required to mirror a release')
      const recordsRoot = join(stateRoot, 'upload-records')
      const destination = `${plan.bucket}/${plan.publicUrl}${manifest.build.channel}`
      // Actions re-runs only the failed mirror job after publish succeeded; the workflow gate still sees that
      // success and its outputs. Publication journals live in a runner's temporary directory, so this fresh
      // runner cannot require that journal; the workflow gate and the approval digest prove the published attempt.
      const record = await createDesktopPublicationRecord<DesktopMirrorStatus>(recordsRoot, {
        repository: manifest.repository, runId: selection.runId, attempt: selection.attempt,
        actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown',
        destination, operation: 'mirror', reason: 'GitHub Release mirror',
      })
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `record=${record.directory}\n`)
      let status: DesktopMirrorStatus = 'failed'
      try {
        phase = 'GitHub Release mirroring'
        const feed = plan.artifacts.find(artifact => artifact.channelMetadata)
        if (feed === undefined) throw new Error('desktop publish: the upload plan carries no update feed')
        const feedUrl = `${new URL(plan.publicUrl).origin}/${feed.key.split('/').map(encodeURIComponent).join('/')}`
        const result = await mirrorDesktopRelease({ repository: manifest.repository, version: plan.version,
          notes: { target: manifest.build.target, sourceSha: manifest.source.sha, approvalDigest: approval, feedUrl },
          assets: desktopReleaseAssets(manifest, bundle.releaseDirectory), token: mirrorToken })
        await record.record({ type: 'mirror-complete' })
        status = 'complete'
        const repaired = await settleDesktopMirrorRecords(recordsRoot, {
          repository: manifest.repository, runId: selection.runId, attempt: selection.attempt, destination }, status)
        await appendMirrorSummary(env, plan, manifest, {
          status: 'complete', releaseUrl: result.url,
          uploaded: result.uploaded.length, present: result.present.length, repaired,
        })
      } catch (error) {
        const failure = desktopPublicationFailure(error, phase)
        await record.record({ type: 'mirror-pending', failure })
        status = 'release-mirror-pending'
        await appendMirrorSummary(env, plan, manifest, { status: 'release-mirror-pending', failure })
        throw error
      } finally { await record.finish(status) }
    } else {
      if (plan.environment === 'production' && !env.DESKTOP_TAG_TOKEN) {
        throw new Error('desktop publish: GitHub App token is required before production upload')
      }
      phase = 'upload credential loading'
      const credentials = await readDesktopUploadCredentials(config, desktopPublishSecrets(env))
      const destination = `${plan.bucket}/${plan.publicUrl}${manifest.build.channel}`
      const recordsRoot = join(stateRoot, 'upload-records')
      phase = 'channel lock and publication journal acquisition'
      await withDesktopChannelLock(join(stateRoot, 'publish-locks'), destination, async () => {
        const published = await wasDesktopAttemptPublished(recordsRoot,
          { repository: manifest.repository, runId: selection.runId, attempt: selection.attempt, destination })
        const journal = await createDesktopPublicationRecord(recordsRoot, {
          repository: manifest.repository, runId: selection.runId, attempt: selection.attempt,
          actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown',
          destination, operation: 'publish', reason: 'Actions publication',
        })
        if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `record=${journal.directory}\n`)
        let status: DesktopPublicationStatus = 'failed'
        try {
          phase = 'remote object reconciliation and publication'
          const tag = async () => { await publishDesktopTag(manifest.repository,
            plan.version, manifest.source.sha, env.DESKTOP_TAG_TOKEN || '') }
          const result = published
            ? await (async () => {
              await journal.record({ type: 'feeds-complete' })
              if (plan.environment === 'production') {
                try { await tag() } catch (cause) {
                  await journal.record({ type: 'tag-pending' })
                  return { status: 'published-tag-pending' as const, cause }
                }
              }
              await journal.record({ type: 'complete' })
              return { status: 'complete' as const }
            })()
            : await publishDesktopRelease(plan, {
              transport: desktopPublishCos(plan, credentials), record: event => journal.record(event),
              tag,
            })
          status = result.status
          if (result.status === 'published-tag-pending') {
            const failure = desktopPublicationFailure(result.cause, 'release tag creation')
            await journal.record({ type: 'failed', failure })
            process.stderr.write(`${JSON.stringify(failure)}\n`)
            process.exitCode = 1
          }
          // The publication journal owns COS, the feeds and the tag; the Release is a later, separate phase.
          await appendPublicationSummary(env, plan, selection, status, manifest.build.preset)
        } catch (error) {
          await journal.record({ type: 'failed', failure: desktopPublicationFailure(error, phase) })
          throw error
        } finally { await journal.finish(status) }
      })
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, phase))}\n`)
    process.exitCode = 1
  }
}
