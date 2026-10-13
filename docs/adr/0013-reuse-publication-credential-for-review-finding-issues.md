# Reuse the publication credential for Review finding issues

Status: Accepted

Big Brother keeps `big-brother/review` Commit Status as its canonical review
surface and adds Prime-approved GitHub Review finding issues as an independent
follow-up surface. The existing per-repository publication credential is reused
for both operations, so operators grant it `Commit statuses: write` and
`Issues: write`; introducing a second token would add configuration and secret
rotation overhead without creating a meaningful trust boundary. Repository
read/clone credentials remain separate, and the publication credential still
receives no repository-content write permission. This supersedes ADR 0012 only
where that ADR restricted the publication credential to status write alone.
