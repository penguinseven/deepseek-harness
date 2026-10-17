---
description: "Operate Desktop package publication from an immutable packaging Artifact bundle on hosted runners."
---

# Desktop CI publication

English | [中文](README.zh.md)

## Summary

Publish a completed package from the Artifact bundle its packaging run uploaded; neither publication job reads the packaging machine. Both test and production publish binaries followed by update YAML. Both deployments require GitHub Environment approval; only production creates a GitHub App tag. Real COS, CDN and administrator-permission acceptance remain deployment checks; local fixtures do not establish those permissions. COS and the update feed remain the only automatic-update source; the GitHub Release is a mirror of the same approved bytes and never changes what clients install.

## Table of Contents

- [Machine setup](#machine-setup)
- [Package and publish](#package-and-publish)
- [Recovery and records](#recovery-and-records)
- [GitHub Release mirror](#release-mirror)
- [Restore a channel](#restore-a-channel)

<a id="machine-setup"></a>

## Machine setup

Each packaging run writes one immutable Artifact Bundle and uploads it under `desktop-<target>-<qualification>-<version>-<run-id>-<attempt>`, with target `win-x64` or `mac-arm64` and qualification `signed`, `unsigned`, `notarized` or `unnotarized`. The bundle holds `manifest.json` beside three directories: `release/` carries the installers, update archives, blockmaps, feed YAML and release record; `verification/` carries the platform evidence; `publication/` carries packaging records kept for audit and never uploaded to COS. The manifest records the source ref and commit, the build identity, the Actions identity, every release file's size, SHA-256 and SHA-512, and the platform verification flags. Publication downloads that bundle; `runnerName` in the manifest is audit data, not a publication machine.

GitHub keeps signed and notarized bundles for 90 days and unsigned or unnotarized bundles for 30 days; packaging logs stay at 14 days. Signed Windows bundles carry `windows-authenticode` and `windows-timestamp` evidence, and notarized macOS bundles carry `macos-codesign` and `macos-notarization`. Each evidence file names the release files it covered and their SHA-256 values, so a hosted publication runner binds the packaged bytes to the packaging machine's native checks instead of repeating them: changed bytes fail verification and require a new packaging run and attempt.

Create `publishing/test.json` and, when authorized, `publishing/production.json` below the configuration directory. Each declares `bucket`, HTTPS `origin` without a path, and an absolute `credentialsFile`. The credential file contains only `secretId` and `secretKey`. macOS also requires `macOS.signingIdentity` and `macOS.teamId`; Windows requires `windows.certificateThumbprint`. Production requires the exact origin `https://download.deepseek.com` and `githubApp.clientId` plus an absolute `githubApp.privateKeyFile`. These files stay outside Git. The uploader supports permanent COS credentials, not STS session credentials. Bucket versioning must be disabled for immutable binary writes. The CI jobs read the deployment configuration from the repository variable `DSH_PUBLISH_CONFIG_JSON` and the COS credential pair from the `DSH_COS_CREDENTIALS_JSON` Environment secret; local runs keep using these files. Every job that resolves a destination names that variable on the step, including the three `--check` steps, so `prepare` can verify the destination the approval will authorize without entering an approval Environment; only the approved publish step additionally reads the credential pair.

The publication jobs run on hosted Ubuntu runners, so `DESKTOP_PUBLISH_RUNNERS`, runner labels and `DSH_DESKTOP_RELEASES_DIR` are gone from the flow, and the packaging machines need no reachable disk or LAN path. Signing material never enters a bundle: the Windows EV token and PIN, the Apple signing and notarization keys and the COS credential pair stay on the packaging machine or in Environment secrets, and the publication runner carries none of them. The GitHub App key arrives as the `DSH_GITHUB_APP_PRIVATE_KEY` Environment secret.

An administrator must create `desktop-test` and `desktop-production`, each with required reviewers and an allowed deployment branch covering `master` and `main`. The workflow checks reviewers for either deployment. Test can allow self-approval. The GitHub App needs installation access to this repository and Contents write permission, plus permission under the `desktop-v*` tag ruleset to create release tags. Reviewer approval does not transfer the reviewer's tag permissions to the App. Missing configuration stops publication; there is no personal-token fallback. The App action creates and later revokes a short-lived token. Protect the App key and COS credentials wherever they are stored, as private files or as Environment secrets. The token action accepts key contents, so the masked PEM also passes through the runner's temporary `GITHUB_OUTPUT` file during the job; masking hides logs, not local file access.

Environment approval gates this workflow, not the packaging machines that produce its bundles. Keep existing release Environments unchanged. The test job uses its own reviewers and never creates a real release tag; local simulated transports exercise tag creation and recovery without verifying App permissions.

<a id="package-and-publish"></a>

## Package and publish

Select the platform's `Package Desktop` workflow, preset, source, channel and version mode. `source_ref` accepts repository branch names (for example `feature/desktop-update`) or `dsh-v*` tags for test; production accepts only `master` or `dsh-v*` tags. Names matching `dsh-v` followed by a digit and letters, digits, dots or hyphens are treated as tags, even if a branch has that name. Tags must match the selected product version. We recommend dispatching the packaging workflow from `master` and enter the source separately; raw commit SHAs, PR refs and fork repositories are not supported. The selected source must contain the CI adapters, so older sources fail before dependency installation. Only select trusted branches: their build code runs on the signing machine. This is an operating convention, not enforced workflow-origin or credential isolation. Publication uses the recorded commit and requires it to remain in the selected branch history; normal branch advances are allowed, deletion or a diverging force-push rejects. Tag publication requires the tag to still resolve to the recorded commit. Dispatch the publisher from `master` or `main`; its routing job rejects other refs before resolving the bundle. The packaged source commit is recorded separately. `version_mode=default` selects product for production and auto for test; product preserves the selected checkout version, auto appends date/run/attempt, and manual requires `build_version`. A latest package requires a stable version, so test/latest needs product or a stable manual version. The optional `test_release_id` is the test URL prefix: blank retains the machine default, successive upgrade tests on that platform need the same value, and defaults should be rotated periodically. It is not a GitHub run ID. See [packaging configuration](../../packaging/README.md#configuration-and-local-builds) for its validation and rotation limits.

Packaging only uploads the bundle. After success, open **Publish Desktop · COS → Run workflow** on `master` or `main`, enter `package_run_id` from the packaging run URL, and optionally enter `package_run_attempt`. Blank selects the latest attempt, which must have succeeded; it never falls back to an older success. An explicit attempt selects that exact successful build. Windows must be signed; macOS must finish notarization and stapling. The bundle manifest supplies the preset, version, source, channel and qualification before approval; an unsigned or unnotarized bundle cannot be published, and missing or altered bundle bytes stop publication.

Before uploading, the publisher hashes every release file in the bundle, checks version and destination metadata against the manifest, and confirms the evidence files cover those exact bytes. The platform checks themselves run on the packaging machine: macOS notarization and code signature, Windows Authenticode and timestamp. The preparation job emits an approval digest over the manifest, the verification evidence and the upload plan; publication recomputes that digest and stops when the bundle, its evidence or the destination changed after approval.

<a id="recovery-and-records"></a>

## Recovery and records

After resolving a failure, re-run the failed publishing job to keep its prepared bundle, or start a new publication with the explicit original package run and attempt. Re-running all jobs with a blank attempt resolves the latest package attempt again and requires a new approval. Do not rebuild solely to retry an upload. Missing objects are uploaded, identical objects are skipped, and conflicting same-name bytes stop the operation. Unknown write outcomes are reconciled by reading remote bytes. A newer channel version prevents a stale upload from replacing it. Each package updates only its embedded channel: nightly writes `nightly.yml` / `nightly-mac.yml`, latest writes `latest.yml` / `latest-mac.yml`. Latest binaries use a `latest/` subdirectory under the target binary prefix, separate from existing nightly objects. Publishing the same source/version to both channels requires two packages; an existing release tag is reused only for the same source commit.

Each phase owns its own record, so a retry of one never re-runs another. `--publish` writes COS, the feeds and the tag, settles its journal `complete` when those succeed, and exits 0; it never runs the Release mirror. `--mirror` runs in its own job and writes a `mirror-` record that settles `complete` or `release-mirror-pending`. When a mirror retry succeeds, it also settles every earlier mirror record of the same package attempt as `complete` — the failed attempt keeps its `mirror-pending` events and its replaced verdict is renamed to `result.release-mirror-pending.json` — so the attempt's audit shows one terminal mirror state per record and the history that produced it. Neither phase rewrites the other's records.

The `upload-records/` directory under the publication state root keeps an operation identity, newline-delimited events and terminal result; `DSH_DESKTOP_PUBLISH_STATE_DIR` selects that root and defaults to the runner's temporary directory. Feed-write intents retain both previous and requested YAML. Failures record their stage, safe error classification and diagnostic; raw provider responses are excluded. Audit initialization becomes visible only after its files are complete; abandoned `.initializing-*` directories are not scanned for completed publication. Writes and readback are recorded before proceeding; missing terminal results mean interruption, not success. Because that temporary root does not survive its hosted runner, Actions also keeps the operation record as a diagnostic artifact for 30 days. Losing it, as every hosted job does when it ends, costs three things: the completed-publication evidence that lets a retry skip COS and the feeds — the retry then reconciles the destination from COS bytes, which is correct but not tag-only — the record of which mirror retries ran, and per-attempt terminal states. What stays trustworthy is what the run itself proves: the immutable bundle and its manifest digests, the approval digest in the review panel, the tag on the packaged commit, the update feeds and installer bytes in COS, the Release assets, and the step summaries and uploaded record artifacts. The mirror job needs none of that state carried over: it re-verifies the bundle against the approved digest on every attempt. These local records are not tamper-proof. COS readback verifies storage bytes, not public CDN behavior; public download acceptance is separate.

If the feed completed but tagging failed, the result is `published-tag-pending` and the job fails visibly. On retry, durable feed-completion evidence permits only tag recovery, even if a later release has advanced the channel. It never re-publishes old YAML. An existing conflicting tag requires administrator investigation and is never moved automatically.

Publication takes a per-destination channel lock under the state root's `publish-locks/`, and the workflow's `desktop-publish-<preset>` concurrency group serializes one channel. A crash can leave a lock directory behind; verify no writer is running before removing it manually.

<a id="release-mirror"></a>

## GitHub Release mirror

A `mirror` job runs after `route`, `prepare` and `publish` all succeed — `--publish` exits 0 once COS, the feeds and the tag are done, so a mirror failure can never hide behind a failed publication — and only for a production preset whose tag was created. It downloads the same package Artifact and re-proves the bundle against the approved digest before reading the GitHub App key, so the mirror cannot start from unsigned, unnotarized or altered bytes. Its steps carry no `DSH_COS_CREDENTIALS_JSON`; only the verification step reads the repository variable holding `DSH_PUBLISH_CONFIG_JSON`, so it cannot re-upload COS or rewrite a feed; `publish-desktop-ci.ts --mirror` verifies the bundle and then uploads `release/` only.

Mirroring is idempotent and byte-exact. Each asset is rehashed against the manifest before upload; an asset already present is confirmed only when its size matches and its SHA-256 matches the manifest. GitHub's `digest` field supplies that SHA-256 when the listing reports it, and an older asset without one is downloaded and hashed. A different size or a different hash stops the mirror before any upload instead of overwriting published download bytes, and the read-back after upload requires the stored bytes to match the same digest. Repeating the mirror for one version therefore only adds what is missing.

A mirror failure does not fail or roll back the publication: COS, the feed and the tag already succeeded, and a rollback would break clients that already updated. The mirror record settles as `release-mirror-pending` and keeps the failure stage and safe error classification; the run's step summary names the pending state and the retry. Re-running only the failed `mirror` job is the retry entry — it reports its own record under `desktop-mirror-<run_id>-<run_attempt>`, settles at `complete` without repackaging, regenerating a bundle or re-uploading COS, and settles the earlier mirror records of the attempt as described under [Recovery and records](#recovery-and-records). `desktop-v<version>` in the approval panel names the Release the approval authorizes; the outcome appears only in the run's step summary and journal.

<a id="restore-a-channel"></a>

## Restore a channel

Run the repository script `apps/desktop/scripts/rollback-desktop-channel.ts` through `node --import tsx` from a checkout that can read COS. Keep `GITHUB_REPOSITORY`, `DESKTOP_PUBLISH_ROUTE` and the publication configuration (`DSH_PUBLISH_CONFIG_JSON` and `DSH_COS_CREDENTIALS_JSON`, or the configuration directory) in the environment as for a publication run; the route JSON supplies the package `runId` and `attempt`. Pass `--record` with that successful publication's audit directory, `--expected-version` with the version currently online, and `--reason` with the operational reason.

Without `--execute`, the script reads remote objects and prints the exact YAML change without writing. Preview requires COS read credentials. With `--execute`, it verifies historical files, preserves before/after YAML in a new audit record, checks the current channel again, and restores only YAML. It neither uploads binaries nor changes tags. A channel already matching the target bytes is skipped; other channels must match the expected current version. This permits recovery after one feed was restored before an interruption. A different current version aborts the operation. Restoration is not a multi-object transaction; inspect the audit after any partial failure before continuing.

The Desktop client disables automatic downgrade. Restoring an old feed can stop additional clients receiving a bad release; clients already on a newer version do not downgrade. A higher-version corrective release is a separate recovery path.

## Dev Note

None.
