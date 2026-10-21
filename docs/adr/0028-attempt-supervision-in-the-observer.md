# ADR 0028: Supervise review attempts from the observer

Status: Accepted for the next design

ADR 0015's review execution supervisor and ADR 0017's one-shot worker
attempts predate the fork; on the Prime runtime their operational owner is
the observer (ADR 0027), acting through the daemon protocol like any
operator client. One in-flight Review range executes as one attempt with a
total time budget from the repository's review profile
(`attemptTimeoutSeconds`, default 1800). A timed-out attempt is cancelled,
never resumed: the observer kills the conductor first, then every
`<layer>-<head>` child (the conductor is dead, so child-death notices
trigger nothing). In-memory children vanish with their workers, and the
spawn ledger's edges only stay live while a child session file exists, so
the retry's fresh dispatch reuses each layer name cleanly.

A retry is a new attempt with the same input identity (ADR 0017): the
state document counts `attempts` and stamps `attemptStartedAt`, the wake
message keeps the `REVIEW_RANGE <base>..<head> END` shape and appends an
explicit retry instruction — dispatch every configured layer fresh,
because the cancelled attempt's collected answers died with its in-memory
children. The harvest already tolerates a re-dispatched layer (the last
call per layer wins), and the completed record carries the attempt count.
At the profile's `maxAttempts` (default 3, first attempt included) the
range fails loudly instead: the in-flight slot clears, a `lastFailure`
fact (range, attempts, reason `timed_out`, timestamp) records on the
branch, and the cursor does not move — an unreviewed change is never
swallowed as reviewed. The next observed head admits from the same base,
so a later range re-covers the failed commits; the operator sees the
failure through the query surface.

The new state fields are serde-defaulted and the schema version stays 1:
existing documents load with their original meaning (attempt 1, started
at admission), and older builds ignore the additions. A stalled child
turn (the real-model smoke's silent mid-tool stall) needs no finer
detection than the attempt budget: whatever the stall, the budget bounds
it, and the retry re-runs the range wholesale.
