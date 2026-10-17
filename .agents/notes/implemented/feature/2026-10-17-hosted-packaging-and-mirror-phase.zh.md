# Agent Note: 托管打包与镜像阶段

Status: implemented

[English](2026-10-17-hosted-packaging-and-mirror-phase.md) | 中文

## Problem

两处缺口把 Desktop 矩阵困在自托管签名机内。托管 `windows-latest` 与 `macos-14` 已可被路由到，但打包步骤仍要求机器配置目录里有 `presets/test.env` 和 `publishing/test.json`，因此未签名或未公证的托管运行在真正构建前就失败。发布侧结构相同：两个 `--check` 步骤都要解析部署目标，却没说目标从哪来，于是 publish 与 mirror job 无法校验它们没有拿到的信息。

GitHub Release 镜像原本是发布的一部分。`--publish` 在 COS、feed 和 tag 之后内联执行它，失败时写 `release-mirror-pending` 并置失败退出码。而 mirror job 要求 `needs.publish.result == 'success'`，于是镜像失败会让发布失败，并跳过唯一能重试它的 job。镜像对已存在资产只比 `size`，同名同大小会被当作 `present` 静默通过；镜像日志也是独立记录，原发布记录永远停在“待镜像”，不会被结算。

## Decision

托管未签名或未公证打包 job 自己生成配置。`apps/desktop/scripts/desktop-hosted-config.ts` 依据仓库内的公开值（测试源站、其 COS 桶、应用标识、本次 dispatch 的 release ID）生成 `presets/test.env` 与 `publishing/test.json`，`hosted-config-command.ts` 通过 `GITHUB_ENV` 把该目录导出为 `DSH_PACKAGING_CONFIG_DIR`。生成的 `publishing/test.json` 不含 `credentialsFile`，因此托管 job 能校验一个它永远无法上传的目标，且不生成、也不需要任何签名、公证或 COS 凭据。macOS 的 ad-hoc 签名是独立模式：`--ad-hoc-signing` 必须配合 `--skip-notarization`，使用 macOS 的 ad-hoc 身份签名，保留 hardened runtime 与强制签名，并产出分发目录布局。若跳过公证但仍存在 `CSC_LINK`，则保留 Developer ID 路径及其校验，ad-hoc 模式无法悄悄降低签名机的要求。

`--publish`、`--mirror` 与 `--check` 是输入各自明确的三个阶段。每个解析目标的步骤都声明 `DSH_PUBLISH_CONFIG_JSON`；只有发布步骤额外读取 `DSH_COS_CREDENTIALS_JSON` 与 App 私钥。`--publish` 写 COS、feed 与 tag，这些成功后把自身 journal 结算为 `complete` 并以 0 退出。`--mirror` 只在自己的 job 中运行，要求本次尝试已有完成发布的证据，并写入 `mirror-` 记录。成功时它会把同一次尝试中更早的镜像记录一并结算为 `complete`，被替换的判定保存为 `result.<状态>.json`，与保留的 `mirror-pending` 事件并列；因此镜像失败只让 mirror job 失败，重跑它不会重跑 COS 或 feed。镜像对已存在资产按 SHA-256 校验——资产列表给出 `digest` 时用 `digest`，否则下载后计算——并把同一摘要用于上传后的回读，同名同大小的替换会停止镜像而不会当作 `present`。

## Alternatives considered

**给托管 job 一个存放 preset 文件的屏蔽 Environment secret。** 否决：托管构建所需的值本来就是公开的——源站就是安装包更新地址，桶出现在每份审批摘要里——secret 只会为一个不存在的机密性代价加上审批门与形似凭据的产物。

**让托管未公证构建复用未签名 macOS 路径。** 否决：未签名构建不产出更新 feed、ZIP 与发布记录，而这些正是托管矩阵要交给发布的产物。

**保留内联镜像，让 mirror job 容忍发布失败。** 否决：这会在同一 Release 上留下两个写入方，并把镜像失败藏在发布失败之后，重试也就无法只针对镜像。

**把发布 journal 结算为 `release-mirror-pending`，之后改为 complete。** 否决：发布记录会声称一个它自身阶段从未产生的结果，且 runner 目录丢失时会让该次尝试的终态出错，而不只是信息缺失。

**用 size 加 HEAD 请求比对已存在资产。** 否决：GitHub 对 HEAD 不提供摘要，上传主机的 ETag 也不是文件 SHA-256，只有列表 `digest` 或字节本身能确立同一性。

## Consequences

托管 runner 现在可以在没有任何凭据的情况下构建并保留完整的未签名或未公证产物包，同一产物包之后可由签名或公证运行发布。代价是托管 macOS 构建为 ad-hoc 签名：Gatekeeper 仍会阻止下载副本，这些产物包只能是内部验收输入，不能发布。发布 job 现在只报告它自己做了什么，镜像结果要从 mirror job 的 summary 与记录中读取。

由于镜像不再能让发布失败，Release 缺失只会表现为 mirror job 失败。两个阶段都把记录放在 runner 临时目录下，runner 消失后重跑会按 manifest 与审批摘要重新校验产物包，并按 COS 字节重新核对目标，而不是依赖 journal 恢复；镜像不需要这种恢复，因为它每次都从头校验产物包。runner 消失后仍可信的证据是产物包及其 manifest 摘要、审批摘要、tag、COS 对象、Release 资产与上传的记录 artifact。

操作步骤由 [CI 发布参考](../../../../apps/desktop/publishing/ci/README.zh.md) 负责，托管打包模式由[打包参考](../../../../apps/desktop/packaging/README.zh.md) 负责。
