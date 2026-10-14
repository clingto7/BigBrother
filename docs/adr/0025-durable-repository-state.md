# ADR 0025: Persist range admission, progress, and review records durably

Status: Accepted for the next design

Big Brother's operational Repository state lives in one repository-keyed
directory under the agent dir, `<agent-dir>/big-brother/repos/<repo-slug>/`,
which now also holds the review profile (refining ADR 0024's
`profiles/<slug>/` path). The directory holds `profile.json`, `state.json`,
and `records/<branch>/<head>.json`. It stays outside the watched work tree:
operational state and reviewed content remain separate trust domains.

`state.json` records, per tracked branch, the review cursor (the last
completed revision — the next range's base) and the single admitted
in-flight range. Admission follows ADR 0018: a head equal to the cursor or
the in-flight head admits nothing, and a later head while a range is in
review makes the observer wait — it never preempts. Seeding the baseline
cursor is enrollment's job (`init`, a later increment); reseeding a branch
to a different revision is refused rather than treated as a reset.
Admission and completion are idempotent and restart-safe, so a process or
machine restart never re-reviews a completed range.

Completing a range persists the full Review record before the cursor
advances and before any channel delivery (ADR 0021): the record file is
the local delivery, and the record schema reserves an independent
per-channel delivery map for later surfaces. A crash between the record
write and the state advance replays completion idempotently; a completion
matching neither the in-flight range nor the cursor is refused loudly.

Writes serialize through a proper-lockfile-compatible directory lock with
atomic temp+rename replacement, following the settings storage
conventions. State and record documents are versioned; an unsupported
version or malformed document is a loud error, never a silent reset.
Revision values are validated as git object ids; branch names are
sanitized for the records directory but travel unsanitized inside records.
