# Agent Note: Desktop Artifact handoff

Status: implemented

English | [中文](2026-10-16-desktop-artifact-handoff.zh.md)

## Problem

Desktop publication read the packaging runner's local retained directory and selected that machine through the `DESKTOP_PUBLISH_RUNNERS` runner-name mapping. A successful packaging run was therefore not sufficient to publish: the original machine, its disk contents and its runner label all had to stay available. The retained files also carried no machine-readable record of the platform checks, so the publication job could not relate the bytes it uploaded to the checks the packaging machine had run.

## Decision

Each packaging run writes one immutable Artifact bundle for its target and uploads it under `desktop-<target>-<qualification>-<version>-<run-id>-<attempt>`. The bundle holds `manifest.json` beside `release/`, `verification/` and `publication/`; the manifest records the source ref and commit, the build and Actions identity, every release file's size, SHA-256 and SHA-512, and the platform verification flags. Publication downloads that bundle, and the `route`, `prepare` and `publish` jobs run on hosted Linux runners. `DSH_DESKTOP_RELEASES_DIR`, `DESKTOP_PUBLISH_RUNNERS` and runner-name routing leave the flow; the manifest's `runnerName` is audit data only. The [CI publication reference](../../../../apps/desktop/publishing/ci/README.md) owns the retention periods, the bundle layout and the operating steps.

`verification/*.json` evidence records the platform checks bound to the release files they covered: Windows Authenticode and timestamp, macOS code signature and notarization. The approval digest covers the manifest, the evidence and the upload plan, and is recomputed after approval, so changed bytes fail verification and require a new packaging run and attempt. Unsigned and unnotarized bundles may be generated and retained, but cannot be published to a machine preset destination.

Production publication keeps its `desktop-production` Environment approval, channel lock, publication journal, COS read-back, `published-tag-pending` recovery and `desktop-v<version>` tag. COS and the update feed remain the only automatic-update source; the GitHub Release mirror is a later stage and is not enabled by this decision.

Signing material never enters a bundle. The publication job reads its deployment configuration from the `DSH_PUBLISH_CONFIG_JSON` Environment secret, the COS credential pair from `DSH_COS_CREDENTIALS_JSON` and the GitHub App key from `DSH_GITHUB_APP_PRIVATE_KEY`. Signed and notarized packaging stays on the self-hosted Windows and macOS runners; migrating those packaging runners is separate work.

## Alternatives considered

**Keep the packaging runner's local directory as the publication input.** Rejected because publication then required one machine, its disk and its runner label to remain available, and the retained files could not establish that the published bytes were the bytes the packaging machine had checked.

**Copy retained files to a shared network location.** Rejected because it adds an always-on share with its own credentials and access control while keeping the same retention, immutability and evidence gaps.

**Download the Artifact bundle but keep runner-label routing.** Rejected because the bundle is portable and the publication work needs no native platform tooling, so a machine mapping would keep an operational dependency with no remaining function.

**Enable the GitHub Release mirror in the same change.** Deferred because the mirror needs its own conflict, retry and audit rules, and shipping it with the handoff would combine two independent risks.

## Consequences

Publication no longer depends on retained local files or a named runner: the Artifact bundle and the Environment secrets are the whole publication input. Because changed bundle bytes invalidate approval, a correction restarts at packaging rather than at upload. The platform checks run once on the packaging machine and are read back on a hosted runner, which holds no signing material. Migrating signed and notarized packaging to hosted runners and enabling the GitHub Release mirror remain separate decisions.
