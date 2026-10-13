# ADR 0011: Keep Watch Foreground and Delegate Supervision to the Platform

Status: Accepted

Date: 2026-09-14

## Context

Big Brother must monitor repositories for long periods on a developer's Mac
and later on Linux servers or VPS hosts. The existing `big-brother watch`
command already owns the polling, retry, durable-state, and graceful-stop
behavior. Making the application daemonize itself would duplicate lifecycle
responsibilities and make shutdown and logging differ by platform.

## Decision

`big-brother watch` remains a foreground service. Platform deployment adapters
supervise it:

- macOS uses `launchd` through a LaunchAgent or LaunchDaemon definition;
- Linux uses `systemd` through a service unit.

The supervisor owns startup, restart after unexpected exit, environment and
working-directory setup, logs, and operator-level lifecycle. Big Brother owns
polling, retries, durable state, and graceful termination on the supervisor's
stop signal. Big Brother does not self-daemonize, and the supervisor does not
reimplement the polling loop. Service definitions must not contain secrets;
credentials come from the host's configured secret/environment mechanism.

## Consequences

The watch process has one behavior across development and deployment, and the
operating system provides the expected restart and logging primitives. The
repository must provide and validate two deployment adapters, and operators
must configure credentials and paths outside the repository. Container
orchestration remains a later deployment option rather than a requirement for
the initial static review profile.
