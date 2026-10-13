# ADR 0023: Fork a suitable agent framework from the start

Status: Accepted for the next design; Prime v0.10.0 selected as initial fork base

Big Brother's next implementation will be a purpose-built review agent based
on an early fork of a suitable existing agent framework. The base must support
separate background and interactive sessions, durable work,
child agents with selectable models, and a controllable tool boundary. This
avoids building the product around an outer wrapper only to move review
behavior into the runtime later. The first fork starts from Prime v0.10.0.
This supersedes ADR 0005's no-fork choice for the next design; the beta remains Prime-derived
around a pinned runtime.

Prime v0.10.0 was the first candidate tested. Its daemon deliberately leaves
saved sessions dormant after a cold start, and its
session engine adds an `ipython` tool by default. The first feasibility gate
must demonstrate a controlled reviewer tool profile, model-selected child
dispatch for one fixed Review range, and recovery of monitoring for explicitly
enrolled repositories. Child reviewers are bounded tasks; they do not own
monitoring or long-term recovery. If this requires replacing the framework's
core execution path, compare another base before committing to the fork.

The v0.10.0 source evaluation found a possible route: a background observer
can wake a saved main-agent session, which dispatches bounded child reviewers
through the existing `RlmSubagentHost` interface. A fork-specific review
session profile must exclude `ipython` from the model's tool list and supply
controlled review tools;
this is a code change, not an existing Prime setting. Prime's optional Factory
workflow may inform child coordination, but its in-memory run registry need
not serve as Big Brother's review record or recovery state. An isolated v0.10.0
fork spike (`spike/big-brother-review-tool-profile`, commits `642f06a` and `db05e12`)
verified that a restricted main session can expose only supplied typed tools
and use one to dispatch three layer-specific, model-selected requests for the
same fixed range. The dispatch test uses a recording child host; the daemon's
real child lifecycle was verified separately. The spike does not yet run a
complete code review through the forked product.

The macOS v0.10.0 test run passed direct attach and short-lived RLM child
lifecycle tests. The spike also verified that a cold-restarted daemon leaves
an inactive session dormant, then wakes it by stable name through
`send_message`. Big Brother's existing SQLite-backed watch recovery test
passed separately. Several upstream supervisor-restart tests assume Linux
`/proc`; a saved-session shutdown timed out twice, and a detached bash
completion wake test failed. These failures do not establish that the
repository monitor cannot work. The fork should use its own background
observer and saved-session wake path. The combined flow is verified below.

Commit `ed3eadc` in the same isolated spike added an opt-in daemon review profile and tested the
combined path on macOS: a local Git repository advanced, a restarted test observer
read its durable cursor, woke the saved main session by name, and the restricted
session dispatched three real daemon child sessions on distinct models for the
same immutable range. All three returned answers; the test saved a review
record and advanced the cursor, then restarted the daemon again without
admitting a duplicate range. Both saved-session wake tests and the two core
review-profile tests passed. No Prime core execution-path replacement was
needed. This passes the framework feasibility gate and selects Prime v0.10.0
as the initial fork base.

The observer cursor and review record in this spike are test-harness files,
not Big Brother's new product implementation. The model service is local and
scripted, with no GitHub or paid model calls. The next implementation must
replace the opt-in environment switch with a per-repository profile, persist
range admission and delivery state, and verify those production paths. On a
cold wake the daemon used its configured default model in the test; model
restoration for real review sessions needs an explicit regression check.

The framework should natively keep background sessions alive across terminal
detach and let an operator reconnect. Unattended review exposes only typed,
controlled reading, indexing, and child-agent operations; general model-written
Python or shell execution is outside its default tool boundary. The fork does
not need to migrate beta review jobs, session transcripts, or service state.
The background component resumes observation of enrolled repositories after
process or machine restart and may wake a saved main-agent session when new
work arrives. Prime v0.10.0 already supports waking a saved session via
`send_message`; it does not automatically start idle sessions on daemon boot.
A platform service manager may start the daemon at boot, but it does not own
review jobs or agent conversations.
The first forked product monitors GitHub repositories; broader Git hosting is
outside its initial scope.
