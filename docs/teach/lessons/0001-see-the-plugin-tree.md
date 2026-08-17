# Lesson 1: Read the plugin tree

English | [中文](0001-see-the-plugin-tree.zh.md)

This lesson supports the mission of building a DeepSeek Harness plugin. Its outcome is to trace the `web` profile to a model request and choose the event that carries a durable model-visible fact.

## Map the runtime

DeepSeek Harness has no privileged core that feature code must patch. A profile selects bundles, bundles supply Cordis configuration entries, and those entries activate plugins. Plugins add services, events, and reversible effects to the shared context.

Keep one distinction clear: a live event connects running work, while a session event stores a fact that later work must reconstruct.

## Inspect the actual composition

Run this command from the Vagrant guest's repository directory:

```sh
dsh --profile web --dump-config
```

The output is evidence of the plugins that boot, rather than a guess based on directory names. Read the [architecture](../../architecture.md) for the map and the [Cordis primer](../../cordis-primer.md) for lifecycle semantics.

## Retrieval practice

Before reading the answer, choose the right place for a new input that reaches a model request and must survive reload:

1. Listen only to `agent/request` because it is closest to the model.
2. Append a session event, then project it from the log into model history.
3. Add the value as a comment in a bundle YAML file.

## Answer check

The correct answer is 2. Model-visible input must be reconstructable from the session log, so a live listener alone cannot preserve it across reload.

## Continue

Read the [architecture map](../reference/dsh-architecture-map.md), then explain in one sentence why “model-visible means logged”. Send that sentence or the event name that confused you; the next lesson will use your answer to choose a capability seam.

## Primary source

Read [DeepSeek Harness architecture](../../architecture.md) before the next lesson.
