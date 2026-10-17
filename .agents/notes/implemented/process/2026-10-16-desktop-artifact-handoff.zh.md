# Agent Note: Desktop Artifact 交接

Status: implemented

[English](2026-10-16-desktop-artifact-handoff.md) | 中文

## 问题

Desktop 发布读取打包机器本地留存的目录，并通过 `DESKTOP_PUBLISH_RUNNERS` 的 runner 名称映射选中该机器。因此打包运行成功并不足以发布：原机器、其磁盘内容及其 runner 标签都必须保持可用。留存文件也不包含平台校验的机器可读记录，发布 job 无法把上传的字节与打包机器执行过的校验关联起来。

## 决策

每次打包运行针对其目标生成一个不可变的产物包，并以 `desktop-<target>-<qualification>-<version>-<run-id>-<attempt>` 上传。产物包在 `manifest.json` 之外包含 `release/`、`verification/` 和 `publication/`；manifest 记录源码 ref 与 commit、构建与 Actions 标识、每个发布文件的大小、SHA-256 与 SHA-512，以及平台校验标志。发布下载该产物包，其 `route`、`prepare` 和 `publish` job 在托管 Linux runner 上运行。`DSH_DESKTOP_RELEASES_DIR`、`DESKTOP_PUBLISH_RUNNERS` 和 runner 名称路由退出流程；manifest 中的 `runnerName` 只是审计数据。[CI 发布参考](../../../../apps/desktop/publishing/ci/README.zh.md)负责留存期限、产物包布局和操作步骤。

`verification/*.json` 证据记录与所覆盖发布文件绑定的平台校验：Windows Authenticode 与时间戳，macOS 代码签名与公证。审批摘要覆盖 manifest、证据和上传计划，并在审批后重新计算，因此字节变动会导致校验失败，需要重新打包并获得新的 attempt。未签名和未公证的产物包可以生成并留存，但不能发布到机器 preset 目标。

正式发布保留 `desktop-production` Environment 审批、频道锁、发布日志、COS 回读、`published-tag-pending` 恢复和 `desktop-v<version>` tag。COS 和更新 feed 仍是唯一的自动更新来源；GitHub Release 镜像是后续阶段，本决策不启用它。

签名材料从不进入产物包。发布 job 从 `DSH_PUBLISH_CONFIG_JSON` Environment secret 读取部署配置，从 `DSH_COS_CREDENTIALS_JSON` 读取 COS 凭据对，从 `DSH_GITHUB_APP_PRIVATE_KEY` 读取 GitHub App 私钥。签名与公证打包仍留在自托管 Windows 和 macOS runner 上；迁移这些打包 runner 属于独立工作。

## 曾考虑的替代方案

**继续把打包机器本地目录作为发布输入。** 不予采纳：发布将要求同一台机器、其磁盘和 runner 标签始终可用，而且留存文件无法确认发布的字节就是打包机器校验过的字节。

**将留存文件复制到共享网络位置。** 不予采纳：这会增加一个始终在线的共享位置及其凭据与访问控制，同时保留相同的留存、不可变和证据缺口。

**下载产物包但仍保留 runner 标签路由。** 不予采纳：产物包可移植，发布工作不需要原生平台工具，机器映射只会留下一个不再有功能的运维依赖。

**在同一次变更中启用 GitHub Release 镜像。** 延后处理：镜像需要自己的冲突、重试和审计规则，与交接一起上线会把两个独立风险合并。

## 后果

发布不再依赖本地留存文件或指定 runner：产物包和 Environment secret 就是发布输入的全部。由于产物包字节变化会使审批失效，修正需要从打包重新开始，而不是从上传重新开始。平台校验在打包机器上执行一次，由托管 runner 读取；托管 runner 不持有签名材料。将签名与公证打包迁移到托管 runner，以及启用 GitHub Release 镜像，仍是独立的决策。
