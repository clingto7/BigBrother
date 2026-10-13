# Issue tracker: GitHub

Issues and specs for Big Brother itself live as GitHub Issues. Use the `gh`
CLI for Big Brother's own planning and lifecycle operations.

## Watched repository review findings

Big Brother creates Review finding issues in the watched repository's GitHub
Issues, using Big Brother's own publication policy, labels, and lifecycle
rules. These issues are distinct from Development issues in the Big Brother
repository.

The watched repository's Matt Pocock setup and native tracker configuration may
be read as project context, but native publication (for example, writing
`.scratch/` local-markdown issues) is deferred. It is not part of the current
GitHub-only publisher.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` when a remote is configured. Until then,
configure the remote before running commands that need to identify the GitHub
repository.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are not included in the ordinary triage queue as external feature
requests. They may still be reviewed explicitly when the user names one.
