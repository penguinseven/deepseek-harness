# Mission: Build a DeepSeek Harness plugin

English | [中文](MISSION.zh.md)

## Why

I want to move from running DeepSeek Harness to extending it safely. The practical outcome is being able to choose the right extension point, implement a plugin, and verify its effect in the assembled application.

## Success looks like

- Explain how a profile assembles bundles into a Cordis plugin tree.
- Trace one model-visible fact from an event producer through the session log to the Web UI or model request.
- Implement a small plugin with a Service Definition, Provider, and Consumer where those roles are needed.
- Run focused tests and the assembled Web UI to verify the plugin's behavior.

## Constraints

- Lessons should be short, interactive, and written in Chinese.
- Runtime practice uses the Vagrant environment at `/data/wwwroot/deepseek-harness`.
- Use the repository's architecture and package documentation as primary sources.

## Out of scope

- Relearning general TypeScript syntax.
- Implementing a production model provider or replacing the Cordis framework.
