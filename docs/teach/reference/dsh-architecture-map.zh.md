# DeepSeek Harness 架构索引

[English](dsh-architecture-map.md) | 中文

选择扩展点前使用本参考。

## 五个层次

| 层次 | 职责 |
| --- | --- |
| Profile | 选择运行时组合。 |
| 组合包 | 提供有序的 Cordis 配置项。 |
| Plugin tree | 激活服务和可逆 effect。 |
| 事件 | 在运行时连接扩展点。 |
| 会话日志 | 保存必须跨 reload 保留并可重建模型输入的事实。 |

## 查询索引

| 问题 | 优先查看的位置 |
| --- | --- |
| 应用挂载了哪些插件？ | `dsh --profile web --dump-config` |
| 这项事实必须持久化吗？ | `SessionEventMap` 和会话事件 |
| 这是可替换能力吗？ | Service Definition、Service Provider 和 Consumer |
| 代码必须拦截请求或工具吗？ | `agent/*` 或 `tools/*` waterfall 事件 |

## 两条规则

- 每项到达模型请求的输入都必须能从会话日志重建。
- 每个 waterfall listener 都调用 `next()`，将处理委托给下游 listener。

## 来源

- [架构](../../architecture.md)
- [Cordis primer](../../cordis-primer.md)
