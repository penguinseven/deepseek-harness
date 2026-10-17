---
description: "在托管 runner 上从不可变的打包产物包发布 Desktop 安装包。"
---

# Desktop CI 发布

[English](README.md) | 中文

## 概述

从打包运行上传的产物包发布完整安装包；两个发布 job 都不读取打包机器。test 和 production 都先发布二进制文件，再更新 YAML。两种环境都需要 GitHub Environment 审批；只有 production 通过 GitHub App 创建 tag。真实 COS、CDN 和管理员权限仍需部署验收；本地 fixture 不证明这些权限可用。COS 与更新 feed 仍是唯一的自动更新来源；GitHub Release 只是同一批已审批字节的镜像，不改变客户端实际安装的内容。

## 目录

- [机器配置](#machine-setup)
- [打包与发布](#package-and-publish)
- [恢复与记录](#recovery-and-records)
- [GitHub Release 镜像](#release-mirror)
- [恢复频道](#restore-a-channel)

<a id="machine-setup"></a>

## 机器配置

每次打包运行生成一个不可变的产物包（Artifact bundle），并以 `desktop-<target>-<qualification>-<version>-<run-id>-<attempt>` 上传，其中 target 为 `win-x64` 或 `mac-arm64`，qualification 为 `signed`、`unsigned`、`notarized` 或 `unnotarized`。产物包在 `manifest.json` 之外包含三个目录：`release/` 存放安装包、更新归档、blockmap、清单 YAML 和发布记录；`verification/` 存放平台证据；`publication/` 存放仅供审计、从不上传到 COS 的打包记录。manifest 记录源码 ref 与 commit、构建标识、Actions 标识、每个发布文件的大小、SHA-256 与 SHA-512，以及平台校验标志。发布下载该产物包；manifest 中的 `runnerName` 只是审计数据，不再指定发布机器。

GitHub 将已签名和已公证的产物包保留 90 天，未签名或未公证的产物包保留 30 天；打包日志仍保留 14 天。已签名的 Windows 产物包带有 `windows-authenticode` 和 `windows-timestamp` 证据，已公证的 macOS 产物包带有 `macos-codesign` 和 `macos-notarization`。每个证据文件列出其覆盖的发布文件及其 SHA-256，托管发布 runner 由此把打包字节绑定到打包机器的原生校验结果，而不必重复校验：字节变动会导致校验失败，需要重新打包并获得新的 attempt。

在配置目录下创建 `publishing/test.json`，获得授权后再创建 `publishing/production.json`。每份配置声明 `bucket`、不带路径的 HTTPS `origin` 和绝对路径 `credentialsFile`。凭据文件只包含 `secretId` 和 `secretKey`。macOS 还需 `macOS.signingIdentity` 和 `macOS.teamId`；Windows 需要 `windows.certificateThumbprint`。production 必须使用 origin `https://download.deepseek.com`，并提供 `githubApp.clientId` 和绝对路径 `githubApp.privateKeyFile`。这些文件不进入 Git。上传器支持长期 COS 凭据，不支持 STS 会话凭据。不可覆盖的二进制写入要求 bucket 版本控制关闭。CI job 从 `DSH_PUBLISH_CONFIG_JSON` Environment secret 读取部署配置，从 `DSH_COS_CREDENTIALS_JSON` 读取 COS 凭据对；本地运行仍使用这些文件。每个要解析发布目标的 job 都在对应步骤上声明该 secret，两个 `--check` 步骤也包含在内：校验读取的正是审批将要授权的目标，只有发布步骤额外读取凭据对。

发布 job 在托管的 Ubuntu runner 上运行，因此流程中不再有 `DESKTOP_PUBLISH_RUNNERS`、runner 标签和 `DSH_DESKTOP_RELEASES_DIR`，打包机器也不需要可访问的磁盘或局域网路径。签名材料从不进入产物包：Windows EV token 与 PIN、Apple 签名和公证密钥以及 COS 凭据对留在打包机器或 Environment secret 中，发布 runner 不携带其中任何一项。GitHub App 私钥通过 `DSH_GITHUB_APP_PRIVATE_KEY` Environment secret 提供。

管理员必须创建 `desktop-test` 和 `desktop-production`，分别设置必需审批人，并允许覆盖 `master` 和 `main` 的部署分支。工作流会检查两种环境的审批人配置。test 可允许发起者自行审批。GitHub App 需要安装到本仓库、具有 Contents write 权限，并获准在 `desktop-v*` tag ruleset 下创建发布 tag。审批不会把审批人的 tag 权限传给 App。缺少配置会停止发布，不回退到个人 token。App action 创建短期 token，并在结束后撤销。请在使用 Environment secret 或私有文件保存 App 私钥和 COS 凭据的位置妥善保护它们。token action 需要密钥内容，因此已屏蔽日志的 PEM 在 job 期间也会经过 runner 临时 `GITHUB_OUTPUT` 文件；日志屏蔽不限制本地文件访问。

Environment 审批限制此工作流，不限制产出其产物包的打包机器。保持现有发布 Environment 不变。test job 使用自己的审批人，不创建真实发布 tag；本地模拟接口覆盖 tag 创建与恢复，但不验证 App 权限。

<a id="package-and-publish"></a>

## 打包与发布

选择对应平台的 `Package Desktop` 工作流、preset、源码、通道和版本模式。test 的 `source_ref` 接受仓库内分支名（如 `feature/desktop-update`）或 `dsh-v*` tag；production 仅接受 `master` 或 `dsh-v*` tag。符合 `dsh-v` 后接数字、其余为字母、数字、点或连字符的名称按 tag 处理，即使存在同名分支。tag 必须与所选产品版本一致。建议从 `master` 启动打包工作流，再单独填写打包源码；不支持直接填写 commit SHA、PR ref 或 fork 仓库。源码必须包含 CI 适配脚本，旧源码会在安装依赖前失败。仅选择可信分支：其构建代码将在签名机器上执行。这是操作约定，不提供工作流来源强制限制或凭据隔离。发布使用记录的 commit，并要求该提交仍在所选分支历史中；正常追加提交不影响发布，删除分支或导致历史分叉的强推会拒绝。tag 发布要求 tag 仍指向记录的提交。从 `master` 或 `main` 发起发布；其路由 job 会在解析产物包前拒绝其他 ref。实际打包源码提交单独记录。`version_mode=default` 对 production 选择 product，对 test 选择 auto；product 保留所选源码版本，auto 追加日期/run/attempt，manual 要求填写 `build_version`。latest 包要求稳定版本，因此 test/latest 需选择 product 或稳定的手填版本。可选 `test_release_id` 是测试 URL 前缀：留空沿用机器默认值，同一平台连续升级测试需保持同一值，默认值应定期轮换。它不是 GitHub run ID。其校验与轮换限制见[打包配置](../../packaging/README.zh.md#configuration-and-local-builds)。

打包只上传产物包。成功后，在 `master` 或 `main` 上打开 **Publish Desktop · COS → Run workflow**，填写打包运行 URL 中的 `package_run_id`，可选填写 `package_run_attempt`。留空选择最新一次成功尝试；它不会回退到更早的成功尝试。显式填写 attempt 会选择该次成功构建。Windows 必须完成签名，macOS 必须完成公证和 stapling。产物包 manifest 在审批前提供 preset、版本、源码、通道和 qualification；未签名或未公证的产物包不能发布，产物包字节缺失或变化会停止发布。

上传前，发布器对产物包中的每个发布文件计算哈希，按 manifest 核对版本与目标元数据，并确认证据文件覆盖的正是这些字节。平台校验本身在打包机器上执行：macOS 公证与代码签名，Windows Authenticode 与时间戳。准备 job 基于 manifest、验证证据和上传计划生成审批摘要；发布时重新计算该摘要，产物包、证据或目标在审批后发生变化即停止发布。

<a id="recovery-and-records"></a>

## 恢复与记录

解决故障后重跑失败的发布 job，以保持在准备阶段选定的产物包；也可显式填写原打包运行和尝试，发起新的发布。尝试留空时重跑所有 job 会重新解析最新打包尝试，并需要重新审批。不要仅为重试上传而重新打包。缺失对象会上传，相同对象跳过，同名但字节不同的对象会停止操作。写入结果不明时通过读取远端字节核对。频道已有更高版本时，旧上传不能替换它。每个包只更新自身内置通道：nightly 写入 `nightly.yml` / `nightly-mac.yml`，latest 写入 `latest.yml` / `latest-mac.yml`。latest 二进制位于目标二进制前缀下的 `latest/` 子目录，与已有 nightly 对象分离。同一源码和版本发布到两个通道需要分别打包；已有发布 tag 仅在源码提交相同时复用。

每个阶段各自拥有日志，重试其中一个阶段不会重跑另一个。`--publish` 写 COS、feed 和 tag，这些成功后把自身的 journal 结算为 `complete` 并以 0 退出，从不内联执行 Release 镜像。`--mirror` 在自己的 job 中运行，写入 `mirror-` 记录，结算为 `complete` 或 `release-mirror-pending`。镜像重试成功时，它还会把同一次打包尝试中更早的镜像记录一并结算为 `complete`：失败的尝试保留其 `mirror-pending` 事件，被替换的判定改名为 `result.release-mirror-pending.json`，因此该次尝试的审计中每条记录都只有一个终态，并留有产生该终态的历史。两个阶段都不会改写对方的记录。

发布状态根目录下的 `upload-records/` 目录保留操作标识、逐行事件和最终结果；`DSH_DESKTOP_PUBLISH_STATE_DIR` 选择该根目录，默认使用 runner 的临时目录。频道写入意图同时记录先前和目标 YAML。失败记录阶段、安全错误分类与诊断，不保存原始服务响应。审计初始化在文件完整后才可见；遗留的 `.initializing-*` 目录不参与已完成发布的扫描。写入和回读在继续操作前落盘；没有最终结果代表中断，不代表成功。由于该临时根目录不会随托管 runner 保留，Actions 还会将操作记录保存为诊断 artifact，保留 30 天。丢失该目录（每个托管 job 结束时都会发生）会损失三样东西：让重试可以跳过 COS 与 feed 的“已完成发布”证据——此时重试改为按 COS 中的字节重新核对目标，结果正确但不再是仅补 tag——镜像重试的执行记录，以及各次尝试的终态。仍然可信的是运行本身能证明的东西：不可变产物包及其 manifest 摘要、审批面板中的审批摘要、打包提交上的 tag、COS 中的更新 feed 与安装包字节、Release 资产，以及 step summary 和上传的记录 artifact。镜像 job 完全不需要这些状态承接：它每次都会按审批摘要重新校验产物包。这些本地记录不防篡改。COS 回读验证存储字节，不代表公开 CDN 行为；公开下载需单独验收。

频道更新完成但 tag 失败时，结果为 `published-tag-pending`，job 明确失败。重试时，已落盘的频道完成证据只允许恢复 tag，即使后来发布已推进频道，也不会重新发布旧 YAML。已有冲突 tag 需要管理员调查，不会自动移动。

发布会在状态根的 `publish-locks/` 下获取目标频道锁，工作流的 `desktop-publish-<preset>` concurrency 组串行化同一频道。崩溃可能留下锁目录；手动删除前确认没有写入任务运行。

<a id="release-mirror"></a>

## GitHub Release 镜像

`mirror` job 在 `route`、`prepare`、`publish` 全部成功后才运行（`--publish` 在 COS、feed 与 tag 完成后即以 0 退出，镜像失败不可能藏在发布失败后面），且只针对 tag 已创建的 production。它下载同一个打包产物包，并在读取 GitHub App 私钥之前重新用审批摘要校验产物包，因此未签名、未公证或已被改动的字节无法进入镜像。该 job 的所有步骤都不带 `DSH_COS_CREDENTIALS_JSON` 与 `DSH_PUBLISH_CONFIG_JSON`，结构上无法重传 COS 或改写 feed；`publish-desktop-ci.ts --mirror` 只校验产物包并上传 `release/`。

镜像幂等且逐字节一致。每个资产在上传前按 manifest 重新计算哈希；已存在的文件只有在大小与 SHA-256 都与 manifest 一致时才直接确认。GitHub 在资产列表给出 `digest` 时以它为准，没有该字段的旧资产则下载后计算哈希。大小或哈希不一致都会在任何上传前停止镜像，而不是覆盖已发布的下载字节；上传后的回读同样要求存储字节匹配该摘要。同一版本重复执行只会补齐缺失项。

镜像失败不会让发布失败，也不会回滚：COS、feed 与 tag 已经成功，回滚反而会破坏已经升级的客户端。镜像记录结算为 `release-mirror-pending`，保留失败阶段与安全错误分类；该次运行的 step summary 标注待重试状态与重试入口。只重跑失败的 `mirror` job 是唯一的重试方式——它把自己的记录归档到 `desktop-mirror-<run_id>-<run_attempt>`，结算为 `complete`，全程不重新打包、不重新生成产物包、不重新上传 COS，并按[恢复与记录](#recovery-and-records)所述结算该次尝试更早的镜像记录。审批面板中的 `desktop-v<version>` 只声明本次审批授权的目标 Release；真实结果只出现在运行期 step summary 与 journal。

<a id="restore-a-channel"></a>

## 恢复频道

在能读取 COS 的 checkout 中通过 `node --import tsx` 运行仓库脚本 `apps/desktop/scripts/rollback-desktop-channel.ts`。像发布运行一样在环境中保持 `GITHUB_REPOSITORY`、`DESKTOP_PUBLISH_ROUTE` 和发布配置（`DSH_PUBLISH_CONFIG_JSON` 和 `DSH_COS_CREDENTIALS_JSON`，或配置目录）；route JSON 提供打包 `runId` 和 `attempt`。`--record` 指定该次成功发布的审计目录，`--expected-version` 指定当前线上版本，`--reason` 填写操作原因。

不带 `--execute` 时，脚本读取远端对象并打印确切 YAML 变更，不执行写入。预览需要 COS 读取凭据。带 `--execute` 时，脚本校验历史文件，将前后 YAML 保存在新的审计记录中，再次检查当前频道，然后仅恢复 YAML。它不上传二进制文件，也不改变 tag。已经与目标字节完全相同的频道会跳过，其余频道必须匹配预期当前版本，因此可以恢复写完一个 feed 后中断的操作。其他当前版本会中止操作。恢复不是多对象事务；部分失败后需先检查审计记录再继续。

Desktop 客户端禁用自动降级。恢复旧 feed 可以阻止更多客户端获得问题版本，已经安装更高版本的客户端不会降级。发布更高版本号的修正版是独立恢复方式。

## 开发备注

无。
