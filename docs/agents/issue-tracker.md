# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI for all operations.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Run commands inside this clone so `gh` resolves the repository from its Git remotes.

## Pull requests as requests

**PRs as a request surface: no.**

## Skill operations

When a skill says to publish an issue, create a GitHub issue. When it says to fetch a ticket, run `gh issue view <number> --comments`.
