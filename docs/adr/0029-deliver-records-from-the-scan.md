# ADR 0029: Deliver records from the observer scan

Status: Accepted for the next design

ADR 0021 fixed the order — one record persists before any channel
delivers it — and left each channel with independent durable state and
retries. The delivery driver is the observer's scan: after observation,
every scan attempts delivery for every record whose enabled channels
are not yet delivered. A crash between a send and its record update
replays the send, so the protocol is at-least-once — a Commit Status
write is idempotent under the stable `big-brother/review` context
(ADR 0012), and a repeated Bark push is bounded by the record set. No
send journal is needed.

Channels resolve from the observer process's environment, never from
watched-repository content or the review profile: Bark needs
`BARK_KEY` (the short push key, not the APNs device token) with
optional `BARK_SERVER` (default `https://api.day.app`); the Commit
Status channel needs `BIG_BROTHER_GITHUB_TOKEN` with optional
`BIG_BROTHER_GITHUB_API_URL` (default `https://api.github.com`, and the
deployment's proxy seam) and a GitHub `origin` remote on the watched
work tree — owner/repo parsed from the SSH or HTTPS remote forms; any
other host leaves the channel off for that repository. An absent key
disables its channel silently; a key enabled later retro-delivers past
records on the next scan, one send per record.

A completed review posts an advisory `success` status whose
description is the synthesis's first line capped at GitHub's 140
characters. A range that exhausted its attempts produces no record and
therefore no status — an unreviewed change is never presented as
reviewed. Bark carries the same first line under group `big-brother`.

Per-channel state lives in `record.delivery`: the attempt count, the
last attempt time, the last error, and the delivery time once done. A
pending channel retries no more often than once a minute, so the scan
interval stays fast while a hard-down endpoint is probed at the minute,
not the scan. Delivery never reruns a review or touches its conclusion
(ADR 0021); a channel failure logs and persists, nothing more.
