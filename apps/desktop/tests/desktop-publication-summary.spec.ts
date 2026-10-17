import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { DesktopArtifactManifest } from '../scripts/desktop-artifact-bundle.ts'
import { desktopMirrorOutcomeSummary, desktopPublicationOutcomeSummary, desktopPublicationSummary } from '../scripts/desktop-publication-summary.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

const manifest: DesktopArtifactManifest = {
  schemaVersion: 1,
  repository: 'owner/repo',
  source: { ref: 'dsh-v1.0.0', sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), dirty: false },
  build: {
    productVersion: '1.0.0', version: '1.0.0', target: 'win-x64', platform: 'win32', arch: 'x64',
    channel: 'latest', preset: 'production', qualification: 'signed', testReleaseId: null,
  },
  actions: {
    workflowRunId: '20', workflowAttempt: '3', runnerName: 'windows-publisher', workflowName: 'windows-package',
  },
  files: [{
    name: 'deepseek-harness-1.0.0-win-x64.exe', size: 15,
    sha256: 'd'.repeat(64), sha512: `${'e'.repeat(86)}==`,
  }],
  verification: {
    windowsAuthenticode: true, windowsTimestamp: true,
    macosCodeSignature: false, macosNotarization: false, feedValidated: true,
  },
}
const plan: DesktopUploadPlan = {
  environment: 'production', target: 'win-x64', version: '1.0.0', bucket: 'production-1234567890',
  publicUrl: 'https://download.example.com/dsh-desk/feeds/win-x64/', secretIdEnvName: 'SECRET_ID', secretKeyEnvName: 'SECRET_KEY',
  artifacts: [
    { path: '/not-read/installer.exe', filename: 'deepseek-harness-1.0.0-win-x64.exe', key: 'dsh-desk/bin/win-x64/latest/deepseek-harness-1.0.0-win-x64.exe',
      contents: 'installer bytes', contentType: 'application/octet-stream', channelMetadata: false },
    { path: '/not-read/latest.yml', filename: 'latest.yml', key: 'dsh-desk/feeds/win-x64/latest.yml',
      contents: 'version: 1.0.0\n', contentType: 'application/yaml', channelMetadata: true },
  ],
}

it('shows production destinations and tag after approval with upload-byte fingerprints', async () => {
  const summary = await desktopPublicationSummary(manifest, plan, 'c'.repeat(64))
  await expect(summary).toMatchFileSnapshot('./expected/publication-production.md')
  expect(summary).toContain('/latest/deepseek-harness-1.0.0-win-x64.exe')
  expect(summary).toContain('https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml')
  expect(summary).toContain(createHash('sha256').update('version: 1.0.0\n').digest('hex'))
  expect(summary).not.toContain('测试 release ID |')
  expect(summary).not.toContain('SECRET_KEY')
  expect(summary).not.toContain('/not-read/')
})

it('escapes runner display text without adding Markdown rows or HTML elements', async () => {
  const summary = await desktopPublicationSummary({
    ...manifest,
    actions: { ...manifest.actions, runnerName: 'runner|\n<script>\`&"__win__![x](https://example.com/x.png)' },
  }, plan, 'c'.repeat(64))
  expect(summary).toContain('runner&#124;&#10;&#60;script&#62;&#96;&#38;&#34;')
  expect(summary).not.toContain('<script>')
  expect(summary).toContain('&#95;&#95;win&#95;&#95;&#33;&#91;x&#93;&#40;https&#58;//example.com/x.png&#41;')
})

it('fails instead of rendering success when an upload file cannot be read', async () => {
  await expect(desktopPublicationSummary(manifest, { ...plan,
    artifacts: [{ path: '/missing-desktop-summary-artifact/installer.exe', filename: 'installer.exe',
      key: 'installer.exe', contentType: 'application/octet-stream', channelMetadata: false }],
  }, 'c'.repeat(64))).rejects.toThrow()
})

it('reports COS, feed, tag and the separate mirror phase after publication', () => {
  const complete = desktopPublicationOutcomeSummary(plan, { runId: '20', attempt: '3' }, 'complete', 'production')
  expect(complete).toContain('Status: **complete**')
  expect(complete).toContain('COS + update feed: **complete**')
  expect(complete).toContain('desktop-v1.0.0')
  expect(complete).toContain('独立 mirror job')
  expect(complete).toContain('https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml')

  const pending = desktopPublicationOutcomeSummary(plan, { runId: '20', attempt: '3' }, 'published-tag-pending', 'production')
  expect(pending).toContain('Git tag: **pending**')
  expect(pending).toContain('COS + update feed: **complete**（Git tag 待补）')
})

it('distinguishes a completed mirror from release-mirror-pending', () => {
  const complete = desktopMirrorOutcomeSummary(plan, manifest, {
    status: 'complete', releaseUrl: 'https://github.com/owner/repo/releases/tag/desktop-v1.0.0',
    uploaded: 2, present: 1, repaired: 1,
  })
  expect(complete).toContain('Status: **complete**')
  expect(complete).toContain('Uploaded this run: 2')
  expect(complete).toContain('Earlier mirror records settled: 1')
  expect(complete).toContain('were not modified')

  const pending = desktopMirrorOutcomeSummary(plan, manifest, {
    status: 'release-mirror-pending',
    failure: { phase: 'GitHub Release mirroring', code: 'validation', message: 'desktop mirror: <script> cannot upload' },
  })
  expect(pending).toContain('Status: **release-mirror-pending**')
  expect(pending).toContain('GitHub Release mirroring')
  expect(pending).toContain('Retry the `mirror` job only')
  expect(pending).not.toContain('<script>')
  expect(pending).toContain('&#60;script&#62;')
})
