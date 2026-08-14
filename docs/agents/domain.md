# Domain documentation

Engineering skills read this repository's domain documentation before exploring relevant code.

## Sources

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/` when they exist.
- Proceed silently when either location does not exist. The domain-modeling workflow creates these files when terminology or decisions require them.

## Layout

This repository uses a single-context layout:

```text
/
|-- CONTEXT.md
`-- docs/adr/
```

Use terms defined in `CONTEXT.md` consistently. Surface any conflict with an existing ADR instead of silently overriding it.
