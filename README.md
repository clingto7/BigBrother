# Big Brother

Big Brother is a local, long-running code review agent for developers and small teams who want a second pair of eyes on every update to a repository.

It watches a dedicated Git worktree, fetches the tracked branch, and asks a persistent Prime Agent review session to inspect each new commit range. Reviews are read-only: Big Brother does not edit source files, rewrite commits, or act as a merge gate.

> **Beta status**
>
> The current beta targets one GitHub repository and one branch per monitored session. It is designed for macOS and Ubuntu/Debian Linux desktops. Multi-branch monitoring, automatic clone/setup, and non-fast-forward recovery are planned follow-ups.

## Why Big Brother

Most automated reviewers answer one pull request or one CI job. Big Brother is for a different workflow: keep a review worktree running in the background while you continue using your normal checkout and interactive agent sessions.

- **Persistent review context** — one repository-scoped review session carries project policy, direction, and prior review state across ranges.
- **Layered review** — requirements, project fit, and implementation quality can use separate review layers and models.
- **Local control** — the observer, state, worktree, and service lifecycle live on your machine; you bring the model endpoint and Git credentials.
- **Read-only boundary** — the review agent can inspect and reason about the repository, but the service does not modify project code.
- **Durable delivery** — completed records can publish an advisory GitHub Commit Status (`big-brother/review`) and optional Bark notifications.
- **Normal developer workflow stays intact** — the review worktree is separate from the checkout you edit every day, and user sessions continue through the existing Prime Agent daemon.

## How it compares

| Project | Main job | Big Brother difference |
| --- | --- | --- |
| [reviewdog](https://github.com/reviewdog/reviewdog) | Convert linter and static-analysis output into review comments, annotations, or checks. | Big Brother runs an agent-led, repository-aware review with durable context; it complements deterministic linters rather than replacing them. |
| [PR-Agent](https://github.com/The-PR-Agent/pr-agent) | Run AI analysis and suggestions for pull requests through repository integrations and commands. | Big Brother is a local branch watcher with a persistent review conversation and an operator-owned worktree; it does not require a PR event for every review range. |
| [OpenHands](https://github.com/OpenHands/OpenHands) | General-purpose software development agent that can modify code and run tasks. | Big Brother narrows the control plane to continuous, read-only review and durable delivery. |

Choose Big Brother when you want background review of a repository you control, stable project context across reviews, and a separate review checkout. Choose reviewdog when deterministic tool output is the main input. Choose PR-Agent when PR-centric automation is the desired workflow. Choose OpenHands when the agent should actively implement changes.

## Requirements

- macOS or Ubuntu/Debian Linux with `launchd` or `systemd --user`.
- Git and a dedicated, clean review worktree with an `origin` remote and an upstream branch.
- A running Prime Agent daemon. Big Brother's observer and your interactive sessions share its Unix socket but remain separate sessions.
- A configured Prime Agent model provider. Model credentials stay in Prime Agent's normal auth configuration.
- Optional delivery credentials:
  - `BIG_BROTHER_GITHUB_TOKEN` for Commit Status writes.
  - `BARK_KEY` and optional `BARK_SERVER` for Bark notifications.
- Rust and Cargo only when building from source.

## Install the nightly release

Nightly release archives contain `prime-agent`, `big-brother`, and `pa-daemon` for the same platform, plus the payload those binaries resolve at runtime: `prime-agent-runtime/` (the Python kernel review sessions boot), `package.json` (the version manifest `prime-agent --version` reports), catalog assets, and skills. `big-brother` manages enrollment and status, `pa-daemon supervisor` serves Prime Agent sessions, and `pa-daemon observer` runs the review watcher. The observer is a separate process; the service script below installs it.

Download the archive for your platform from the [nightly release](https://github.com/clingto7/BigBrother/releases/tag/nightly). Check its SHA-256 against the matching row in `SHA256SUMS`, then extract the whole archive into a directory on `PATH`. Extract everything, not just the executables: without `prime-agent-runtime/` beside the binary every review fails with "The packaged prime-agent-runtime directory was not found", and without `package.json` the version reporting falls back to the build-time version:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.cache/big-brother-release"
cd "$HOME/.cache/big-brother-release"
# Download the platform archive and SHA256SUMS from the nightly release page.
archive="prime-agent-VERSION-PLATFORM.tar.gz"
expected="$(awk -v name="$archive" '$2 == name { print $1 }' SHA256SUMS)"
actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
test -n "$expected" && test "$actual" = "$expected"
tar -xzf "$archive" -C "$HOME/.local/bin"
```

Replace `VERSION` and `PLATFORM` with the archive name shown on the release page (for example `0.10.1-beta.21` and `darwin-arm64`). Add `~/.local/bin` to `PATH` if needed. On Windows, the executable names end in `.exe`.

Start the shared Prime Agent supervisor:

```bash
pa-daemon supervisor --agent-dir "$HOME/.prime/agent"
```

## Quick start from source

Build the workspace and put the three binaries on your `PATH`:

```bash
cargo build --locked -p pa-cli --bin big-brother
cargo build --locked -p pa-daemon --bin pa-daemon
cargo build --locked -p pa-cli --bin prime-agent
export PATH="$PWD/target/debug:$PATH"
```

Prepare a review-only worktree. Do not use the checkout where you edit files daily:

```bash
git clone git@github.com:OWNER/REPOSITORY.git "$HOME/review-worktrees/REPOSITORY"
cd "$HOME/review-worktrees/REPOSITORY"
git switch main                         # or the repository's default branch
git branch --set-upstream-to=origin/main main
```

Make sure the worktree is clean, then enroll it. `--branch` is optional; without it Big Brother resolves `origin/HEAD`, then `main`, then `master`:

```bash
big-brother init \
  --repo "$HOME/review-worktrees/REPOSITORY" \
  --main-model provider/model \
  --layer requirements=provider/model \
  --layer project-fit=provider/model \
  --layer implementation=provider/model
```

The existing Prime Agent daemon must be running before `init`. If you manage it manually, use the same agent directory and socket for both processes:

```bash
pa-daemon supervisor --agent-dir "$HOME/.prime/agent"
```

Install the background observer. The script creates a macOS LaunchAgent or Linux systemd user unit, keeps the observer in the foreground, and leaves secrets outside the service definition:

```bash
scripts/big-brother-service.sh install \
  --agent-dir "$HOME/.prime/agent" \
  --binary "$(command -v pa-daemon)"
```

Inspect enrollment and review progress:

```bash
big-brother status --repo "$HOME/review-worktrees/REPOSITORY"
```

Remove the platform service without deleting review records or the worktree:

```bash
scripts/big-brother-service.sh uninstall
```

## Runtime behavior

On each interval, the observer:

1. fetches `origin/<branch>` through Git's configured credential helper;
2. fast-forwards the dedicated local branch and worktree;
3. admits the new range after the previous range settles;
4. wakes the repository's persistent review session;
5. harvests the layered answers and synthesis;
6. stores the review record before attempting delivery.

The default interval is 30 seconds. A dirty worktree, fetch failure, wrong checked-out branch, or non-fast-forward update is recorded and skipped without overwriting files. A repository with no fetch upstream remains usable in local-observation mode.

The observer is a separate foreground process. `launchd` or `systemd --user` owns restart and logs; the Prime Agent daemon owns model sessions. Your interactive Prime Agent sessions continue using the same daemon independently.

## Configuration and boundaries

- Review profile and operational state live under the Prime Agent agent directory, not inside the watched repository.
- `.big-brother/` contains only minimal project-understanding assets in the worktree.
- Git remote credentials come from SSH agent or Git credential helpers.
- GitHub Commit Status and Bark are optional channels. Missing credentials disable their channel.
- Big Brother sends review material to the configured model endpoint. Do not enroll repositories whose content may not leave your approved processing boundary.
- A successful review is advisory. Exhausted review attempts do not produce a success status.

## Configure with another agent

Give your setup agent this prompt:

> Configure Big Brother for this repository. Use a dedicated clean worktree, separate from my daily checkout. Verify that `big-brother`, `pa-daemon`, and the Prime Agent daemon are available. Initialize the worktree with `big-brother init` using the existing daemon socket and my chosen review models, then install the platform service with `scripts/big-brother-service.sh install --binary "$(command -v pa-daemon)"`. Do not put tokens or secret values in a plist, systemd unit, repository file, or commit. Show the service path, agent directory, tracked branch, and `big-brother status` output. Stop if the worktree is dirty or is the same checkout I use for daily editing.

## Development

Run focused checks from a short temporary directory on macOS:

```bash
TMPDIR=/tmp/bbtest/ cargo test -p pa-daemon --lib --locked -- big_brother --test-threads=1
TMPDIR=/tmp/bbtest/ cargo test -p pa-daemon --test big_brother_init_e2e --locked -- --test-threads=1
TMPDIR=/tmp/bbtest/ cargo test -p pa-daemon --test big_brother_delivery_e2e --locked -- --test-threads=1
cargo fmt --all --check
```

The project records architectural decisions in [`docs/adr`](docs/adr) and domain language in [`CONTEXT.md`](CONTEXT.md).

## License

Big Brother is released under the [MIT License](LICENSE).
