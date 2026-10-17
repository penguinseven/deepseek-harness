/** Render verified publication plans, approval details and terminal outcomes for GitHub summaries. */
import type { DesktopArtifactManifest } from './desktop-artifact-bundle.ts'
import type { DesktopPublicationStatus } from './desktop-publish-record.ts'
import { desktopReleaseTag } from './desktop-release-tag.ts'
import { digestDesktopUploadArtifacts, type DesktopUploadPlan } from './desktop-upload-plan.ts'

function text(value: string): string {
  return value.replace(/[&<>"'|`\r\n\\*_\[\]()!~:]/gu, character => `&#${character.charCodeAt(0)};`)
}

function code(value: string): string { return `<code>${text(value)}</code>` }
function row(label: string, value: string): string { return `| ${label} | ${value} |` }
function link(url: string, label = url): string { return `<a href="${text(url)}">${text(label)}</a>` }

/** Routed package identity a post-publication summary cross-checks. */
export interface DesktopPublicationOutcomeSource {
  readonly runId: string
  readonly attempt: string
}

/** Terminal mirror outcome a run summary reports; only `release-mirror-pending` needs a retry. */
export type DesktopMirrorOutcome =
  | {
    readonly status: 'complete'
    readonly releaseUrl: string
    readonly uploaded: number
    readonly present: number
    /** Earlier mirror records this retry settled in the same persistent root. */
    readonly repaired?: number
  }
  | {
    readonly status: 'release-mirror-pending'
    readonly failure: { readonly phase: string; readonly code: string; readonly message: string }
  }

/**
 * Render what COS, the update feed and the tag did after publication finishes.
 * @param plan Validated upload plan naming the target, version and deployment.
 * @param selection Routed package identity the publication used.
 * @param status Terminal publication state reached by this invocation.
 * @param preset Packaging preset the bundle declared; only production publishes a Release to mirror.
 * @returns Markdown that names the completed writes and leaves the mirror to its own job summary.
 * A mirror failure is reported by the mirror job, so this summary never claims its result.
 */
export function desktopPublicationOutcomeSummary(
  plan: DesktopUploadPlan, selection: DesktopPublicationOutcomeSource,
  status: DesktopPublicationStatus, preset: 'test' | 'production',
): string {
  const origin = new URL(plan.publicUrl).origin
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
    .map(file => `${origin}/${file.key.split('/').map(encodeURIComponent).join('/')}`)
  const writes = status === 'complete' || status === 'release-mirror-pending'
    ? '**complete**'
    : status === 'published-tag-pending' ? '**complete**（Git tag 待补）' : `**${status}**`
  const tag = plan.environment === 'test'
    ? '不创建（test 环境）'
    : status === 'published-tag-pending' ? `**pending**（${code(`desktop-v${plan.version}`)}）` : code(`desktop-v${plan.version}`)
  const mirror = preset === 'test'
    ? '不创建（test 环境）'
    : status === 'release-mirror-pending'
      ? '**release-mirror-pending**（见 mirror journal）'
      : '独立 mirror job；结果见该 job 的 step summary 与 journal'
  return [
    '', '## Desktop publication', '',
    `- Status: **${status}**`,
    `- Target: ${code(plan.target)} ${code(plan.version)}`,
    `- Source: run ${code(selection.runId)}, attempt ${code(selection.attempt)}`,
    `- COS + update feed: ${writes}`,
    ...(feeds.length > 0 ? [`- Feed: ${feeds.map(url => link(url)).join('<br>')}`] : []),
    `- Git tag: ${tag}`,
    `- GitHub Release: ${mirror}`, '',
  ].join('\n')
}

/**
 * Render one mirror invocation, including the pending state a failed retry leaves behind.
 * @param plan Validated upload plan naming the target, version and deployment.
 * @param manifest Verified bundle manifest naming the channel.
 * @param outcome Terminal state and either the Release URL or the failure that needs a retry.
 * @returns Markdown that distinguishes completion from `release-mirror-pending` and its retry.
 * COS, the feed and the tag are named as untouched because this phase must never rewrite them.
 */
export function desktopMirrorOutcomeSummary(
  plan: DesktopUploadPlan, manifest: DesktopArtifactManifest, outcome: DesktopMirrorOutcome,
): string {
  const lines = [
    '', '## Desktop release mirror', '',
    `${code(plan.target)} ${code(plan.version)} → ${code(desktopReleaseTag(plan.version))}（通道 ${code(manifest.build.channel)}）`, '',
    `- Status: **${outcome.status}**`,
  ]
  if (outcome.status === 'complete') {
    lines.push(
      `- GitHub Release: ${link(outcome.releaseUrl)}`,
      `- Uploaded this run: ${outcome.uploaded}`,
      `- Already present: ${outcome.present}`,
      ...(outcome.repaired === undefined ? [] : [`- Earlier mirror records settled: ${outcome.repaired}`]), '',
      'COS, the update feed and the Git tag were not modified by this step.', '',
    )
  } else {
    lines.push(
      `- Phase: ${code(outcome.failure.phase)}`,
      `- Code: ${code(outcome.failure.code)}`,
      `- Message: ${text(outcome.failure.message)}`, '',
      'Retry the `mirror` job only. COS, the update feed and the Git tag remain published and must not be rewritten or rolled back.', '',
    )
  }
  return lines.join('\n')
}

/**
 * Render Chinese approval details after bundle, destination and evidence verification succeeds.
 * @param manifest Verified bundle manifest that fixes the release identity shown to the reviewer.
 * @param plan Validated upload plan; YAML contents are the bytes that will be uploaded.
 * @param approval Digest bound to the approved manifest, evidence and upload plan.
 * File SHA-256 hex supports `shasum -a 256` on downloads; upload reconciliation separately uses SHA-512 base64.
 * @returns GitHub-flavored Markdown with final URLs and upload-byte fingerprints, without credentials or local paths.
 * The GitHub Release row authorizes mirroring; the outcome reaches the run's step summary and journal instead.
 */
export async function desktopPublicationSummary(
  manifest: DesktopArtifactManifest, plan: DesktopUploadPlan, approval: string,
): Promise<string> {
  const origin = new URL(plan.publicUrl).origin
  const url = (key: string) => `${origin}/${key.split('/').map(encodeURIComponent).join('/')}`
  const digests = await digestDesktopUploadArtifacts(plan)
  const files = plan.artifacts.map((file) => {
    const digest = digests.get(file.key)!
    return row(link(url(file.key), file.filename), `${digest.size} 字节 | ${code(digest.sha256)}`)
  })
  const installerExtension = plan.target === 'win-x64' ? '.exe' : '.dmg'
  const installers = plan.artifacts.filter(file => !file.channelMetadata && file.filename.endsWith(installerExtension))
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
  const runUrl = `https://github.com/${manifest.repository}/actions/runs/${manifest.actions.workflowRunId}/attempts/${manifest.actions.workflowAttempt}`
  const environment = plan.environment === 'test' ? 'desktop-test' : 'desktop-production'
  const tag = plan.environment === 'production' ? code(`desktop-v${plan.version}`) : '不创建（test 环境）'
  return [
    '', '## 发布前确认', '',
    `核对以下信息后，点击 **Review deployments**，选择 ${code(environment)} 并点击 **Approve and deploy**；信息有误请点击 **Reject**。`, '',
    '| 项目 | 发布信息 |', '| --- | --- |',
    row('发布环境', code(plan.environment)),
    row('版本号', code(plan.version)),
    row('升级通道', code(manifest.build.channel)),
    row('平台', code(plan.target)),
    ...(plan.environment === 'test' ? [row('测试 release ID', `${code(manifest.build.testReleaseId!)}<br>测试下载路径的随机前缀，用于降低地址被猜到的可能性；连续升级测试需使用相同值。`)] : []),
    row('下载地址预览', `${installers.map(file => link(url(file.key))).join('<br>')}<br>发布后的目标地址，审批前不保证可下载。`),
    row('升级 YAML', `${feeds.map(file => link(url(file.key))).join('<br>')}<br>本次发布将更新此文件；审批前可能不存在或仍指向旧版本。`),
    row('打包来源', `${link(runUrl, `查看打包运行 #${manifest.actions.workflowRunId} · 第 ${manifest.actions.workflowAttempt} 次尝试`)}<br>源码：${code(`${manifest.source.ref} @ ${manifest.source.sha}`)}<br>打包机器：${code(manifest.actions.runnerName)}`),
    row('签名与公证', plan.target === 'win-x64' ? 'EXE 签名校验通过' : 'DMG 校验通过<br>ZIP 内应用校验通过'),
    row('Git tag', tag),
    // The approval panel renders before anything runs, so it names the mirror it authorizes rather than a result.
    row('GitHub Release', plan.environment === 'production'
      ? `${code(`desktop-v${plan.version}`)}<br>在 COS、升级 YAML 与 Git tag 全部成功后，把同一批已审批字节镜像到该 Release；镜像结果写入运行日志，不改变本次发布结论。`
      : '不创建（test 环境）'),
    '', '### 批准后将执行', '',
    '1. 重新校验产物与发布目标；若与审批摘要不一致则停止。',
    '2. 上传缺少的文件，跳过内容一致的已有文件；发现内容冲突则停止。',
    '3. 更新上述升级 YAML，并保存发布记录。',
    ...(plan.environment === 'production' ? [
      '4. 为实际打包提交创建上述 Git tag；若 tag 创建失败，记录“已发布，待补 tag”。',
      '5. 镜像上述 GitHub Release；若镜像失败，记录 `release-mirror-pending`，只重试镜像，不回滚已完成的 COS 与升级 YAML。',
    ] : []), '',
    ...(plan.environment === 'test' ? ['**本次只发布 test，不修改 production。**', ''] : []),
    '<details>', '<summary>技术详情与文件清单</summary>', '',
    `COS 存储桶：${code(plan.bucket)}`, '',
    ...(plan.environment === 'test' ? [
      'release ID 取自原打包产物清单。打包时优先使用表单 `test_release_id`；hosted 构建必须填写，自托管签名构建留空则使用机器 `presets/test.env` 中的 `DOWNLOAD_TEST_RELEASE_ID`。发布时不重新选择。', '',
    ] : []),
    `审批摘要 SHA-256：${code(approval)}`, '',
    `共 ${plan.artifacts.length} 个文件；大小及 SHA-256 对应实际上传字节，包括更新后的 YAML 内容。`, '',
    '| 文件 | 大小 | SHA-256 |', '| --- | --- | --- |', ...files, '', '</details>', '',
    '若仓库为公开仓库，此摘要中的下载路径及 test 发布的 release ID 也会公开。随机前缀不能替代访问鉴权。', '',
  ].join('\n')
}
