# 任务：开发一个 DeepSeek Harness 插件

[English](MISSION.md) | 中文

## 原因

我希望从运行 DeepSeek Harness 进阶到可以安全扩展它。实际目标是能够选择正确的扩展点、实现一个插件，并在组装后的应用中验证它的效果。

## 成功标准

- 解释 profile 如何将组合包组装为 Cordis plugin tree。
- 追踪一项模型可见事实如何从事件生产方经过会话事件日志到达 Web UI 或模型请求。
- 在需要这些角色时，实现包含 Service Definition、Service Provider 和 Consumer 的小型插件。
- 运行聚焦测试和组装后的 Web UI，验证插件行为。

## 约束

- 课程应当简短、可练习，并使用中文编写。
- 运行时练习在 Vagrant 客体的 `/data/wwwroot/deepseek-harness` 中进行。
- 使用仓库架构文档和包文档作为主要来源。

## 范围外内容

- 重新学习通用 TypeScript 语法。
- 实现生产级模型提供方或替换 Cordis 框架。
