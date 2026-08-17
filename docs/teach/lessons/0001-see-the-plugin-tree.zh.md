# 第 1 课：阅读 Plugin Tree

[English](0001-see-the-plugin-tree.md) | 中文

本课服务于开发 DeepSeek Harness 插件的任务。完成后，你能从 `web` profile 追踪到模型请求，并为需要持久保存的模型可见事实选择事件。

## 绘制运行时地图

DeepSeek Harness 没有要求功能代码直接修改的特权核心。profile 选择组合包，组合包提供 Cordis 配置项，这些配置项激活插件。插件通过服务、事件和可逆 effect 加入共享上下文。

请明确区分：实时事件连接正在运行的工作；会话事件保存后续工作必须重建的事实。

## 检查实际组合

在 Vagrant 客体的仓库目录中运行此命令：

```sh
dsh --profile web --dump-config
```

输出是启动插件的证据，不是根据目录名做出的猜测。阅读[架构文档](../../architecture.md)了解整体地图，阅读[Cordis primer](../../cordis-primer.md)了解生命周期语义。

## 提取练习

阅读答案前，为一项会到达模型请求且必须跨 reload 保留的新输入选择正确的位置：

1. 仅监听 `agent/request`，因为它离模型最近。
2. 追加会话事件，再从日志将它投影到模型历史。
3. 将值加入组合包 YAML 文件的注释。

## 答案检查

正确答案是 2。模型可见输入必须能从会话日志重建，因此单独使用实时 listener 无法跨 reload 保留它。

## 继续学习

阅读[架构索引](../reference/dsh-architecture-map.md)，然后用一句话解释“模型可见意味着已记录”。把这句话或令你困惑的事件名发给我；下一课将用你的答案选择一个能力 seam。

## 主要来源

下一课前阅读[DeepSeek Harness 架构文档](../../architecture.md)。
