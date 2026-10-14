# ADR 0027: Run the watch service as a daemon-protocol client

Status: Accepted for the next design

The watch service ships as `pa-daemon observer`: a separate process that
speaks the daemon's client protocol rather than a task inside the
supervisor. Scanning, waking by session name, reading rosters and
transcripts, and collecting child answers all ride the same wire surface
an operator's client uses, so the observer inherits the daemon's
hardened paths and stays restartable independently. A platform service
manager may run it beside the daemon; folding it into the supervisor is
a later deployment choice, not a protocol change.

Each scan walks the enrolled repositories under
`<agent-dir>/big-brother/repos/`: the state document records the watched
git root (the directory slug does not invert), and observation reads the
persistent work tree's local tracked-branch head — GitHub-side fetching
is a later delivery-source concern. An in-flight range completes before a
newer head admits (ADR 0018): the observer polls until every configured
layer's child has answered, harvests the conductor transcript (ADR 0026),
and persists the record (ADR 0025). Recovery is state-driven: an
in-flight range found at startup harvests from an already-settled
conversation, or gets its wake retried at most once per observer run — a
retry is a new attempt with the same input identity.

Layer children are named `<layer>-<head>`: a later range reuses each
layer (name reservation would refuse the same name twice), and the
observer matches the exact in-flight head, so a retained child from a
previous range never answers for the new one.
