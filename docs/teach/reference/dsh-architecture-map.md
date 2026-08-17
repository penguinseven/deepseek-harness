# DeepSeek Harness architecture map

English | [中文](dsh-architecture-map.zh.md)

Use this reference before choosing an extension point.

## Five layers

| Layer | Responsibility |
| --- | --- |
| Profile | Selects a runtime composition. |
| Bundle | Supplies ordered Cordis configuration entries. |
| Plugin tree | Activates services and reversible effects. |
| Events | Connects extension points at runtime. |
| Session log | Stores facts that must survive reload and reconstruct model input. |

## Lookup guide

| Question | First place to check |
| --- | --- |
| Which plugins does an application mount? | `dsh --profile web --dump-config` |
| Must this fact persist? | `SessionEventMap` and a session event |
| Is this a swappable capability? | Service Definition, Service Provider, and Consumer |
| Must code intercept a request or tool? | An `agent/*` or `tools/*` waterfall event |

## Two rules

- Every input that reaches a model request must be reconstructable from the session log.
- Every waterfall listener calls `next()` to delegate to downstream listeners.

## Sources

- [Architecture](../../architecture.md)
- [Cordis primer](../../cordis-primer.md)
