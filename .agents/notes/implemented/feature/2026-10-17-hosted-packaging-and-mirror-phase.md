# Agent Note: Hosted desktop packaging and the release mirror phase

Status: implemented

English | [中文](2026-10-17-hosted-packaging-and-mirror-phase.zh.md)

## Problem

Two gaps kept the Desktop matrix inside the self-hosted signing machines. Hosted `windows-latest` and `macos-14` jobs could be routed to, but their packaging steps still required a machine configuration directory with a `presets/test.env` and a `publishing/test.json`, so an unsigned or unnotarized hosted run failed before it built anything. Publication had the same shape: both `--check` steps resolved the deployment destination without naming where it came from, so the publish and mirror jobs could not verify what they had not been given.

The GitHub Release mirror was also part publication. `--publish` ran it inline after COS, the feeds and the tag, wrote `release-mirror-pending` and set a failing exit code. The mirror job required `needs.publish.result == 'success'`, so a mirror failure made the publication fail and skipped the only job that could retry it. The mirror compared already present assets by size alone, so same-size bytes under an approved name passed as `present`, and the mirror's journal was a separate record that left the publication record claiming a pending Release it would never settle.

## Decision

A hosted unsigned or unnotarized packaging job writes its own configuration. `apps/desktop/scripts/desktop-hosted-config.ts` materializes `presets/test.env` and `publishing/test.json` from public values in repository code — the test origin, its COS bucket, the app identifier and the dispatched release ID — and `hosted-config-command.ts` exports that directory as `DSH_PACKAGING_CONFIG_DIR` through `GITHUB_ENV`. The generated `publishing/test.json` carries no `credentialsFile`, so a hosted job can verify a destination it can never upload to, and no signing, notarization or COS credential is generated or needed. macOS ad-hoc signing is a separate mode: `--ad-hoc-signing` requires `--skip-notarization`, signs with macOS's ad-hoc identity, keeps the hardened runtime and forced code signing, and prints the distribution layout. A skipped notarization that still finds a `CSC_LINK` keeps the Developer ID path and its checks, so the ad-hoc mode cannot silently weaken a signing machine.

`--publish`, `--mirror` and `--check` are three phases with three inputs. Every step that resolves a destination names `DSH_PUBLISH_CONFIG_JSON`; only the publish step additionally reads `DSH_COS_CREDENTIALS_JSON` and the App key. `--publish` writes COS, the feeds and the tag and settles its journal `complete` once those succeed, then exits 0. `--mirror` runs only in its own job, requires the attempt's completed publication evidence, and writes a `mirror-` record. On success it settles every earlier mirror record of the same attempt as `complete`, keeping each replaced verdict as `result.<status>.json` beside the preserved `mirror-pending` events; a mirror failure therefore fails only the mirror job, which is re-runnable without re-running COS or the feeds. The mirror verifies already present assets by SHA-256 — GitHub's `digest` when the listing reports it, a download otherwise — and applies the same digest to the read-back after upload, so a same-size substitution stops the mirror instead of passing as `present`.

## Alternatives considered

**Give the hosted job a masked Environment secret holding the preset file.** Rejected because the values a hosted build needs are already public — the origin is the installer update URL and the bucket appears in every approval summary — so a secret would add an approval gate and a credential-shaped artifact for no confidentiality.

**Reuse the unsigned macOS path for hosted unnotarized builds.** Rejected because an unsigned build omits update feeds, ZIPs and the release record, which is exactly what the hosted matrix is meant to produce and hand to publication.

**Keep the inline mirror and make the mirror job tolerate a failed publish.** Rejected because it leaves two writers of the same Release and hides a mirror failure behind a failed publication, so the retry could not be scoped to the mirror alone.

**Settle the publication journal as `release-mirror-pending` and mark it complete later.** Rejected because the publication record would then claim an outcome its own phase never produced, and a lost runner directory would leave the attempt's terminal state wrong rather than merely missing.

**Compare present assets by size plus a HEAD request.** Rejected because GitHub reports no digest for a HEAD and the upload host's ETag is not the file's SHA-256, so only the listing digest or the bytes themselves establish identity.

## Consequences

A hosted runner can build and retain a complete unsigned or unnotarized bundle with no credential of any kind, and the same bundle can be published by a signed or notarized run later. The cost is that hosted macOS builds are ad-hoc signed: Gatekeeper still blocks downloaded copies, so these bundles remain internal qualification input and cannot be published. The publish job now reports only what it did, so an operator reads the mirror result from the mirror job's summary and record.

Because the mirror can no longer fail a publication, a Release that stays absent is visible only as a failed mirror job. Both phases keep their records under the runner's temporary directory, so a rerun after the runner is gone re-verifies the bundle from its manifest and approval digest and reconciles the destination from COS bytes instead of recovering from the journal; the mirror needs no such recovery, because every attempt verifies the bundle from scratch. Durable evidence after a runner is gone is the bundle and its manifest digests, the approval digest, the tag, the COS objects, the Release assets, and the uploaded record artifacts.

The [CI publication reference](../../../../apps/desktop/publishing/ci/README.md) owns the operating steps and the [packaging reference](../../../../apps/desktop/packaging/README.md) owns the hosted packaging modes.
