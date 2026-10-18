# ADR 0031: Fetch the review branch into a platform-supervised service

Status: Accepted for the next design

The first service deployment watches one repository through one review worktree
and one default branch. The foreground `pa-daemon observer` is supervised by a
user-level macOS LaunchAgent or Linux systemd unit, while the existing
Prime-agent daemon remains a separate session runtime on the shared Unix
socket. This keeps background review sessions independent from the user's
interactive sessions without making the observer responsible for model
execution.

The observer uses the worktree prepared by the operator; it does not clone or
initialize repositories in this milestone. Each interval runs `git fetch`
through Git's existing remote and credential helper, resolves the default
branch as `origin/HEAD`, then `main`, then `master`, and fast-forwards the
dedicated local branch and worktree before scanning it. A dirty worktree,
fetch failure, or non-fast-forward update is recorded and skipped without
overwriting files. Non-fast-forward recovery is a later milestone. Fetch and
scan share one configurable interval, defaulting to the current 30 seconds.
Repositories without an `origin` remain in local-observation mode for
development and existing enrollments; the observer still refuses user changes
before scanning.

The service templates configure paths, the shared socket, interval, PATH, and
logs, but never embed secrets. Installation and removal commands generate and
manage the LaunchAgent or systemd user unit without deleting review state,
records, profile, or worktree. The README will include a copyable prompt that
lets a user's agent perform this setup. Multiple branches and multiple
repositories remain later expansions; multiple repositories are expected to be
represented by separate monitored sessions.

## Consequences

The service can review remote branch updates without touching a user's daily
checkout, and the same observer behavior works under both supported desktop
service managers. Operators must provide a dedicated, clean worktree and
credentials through the host environment. The observer and Prime-agent daemon
must be deployed together but remain independently restartable.
