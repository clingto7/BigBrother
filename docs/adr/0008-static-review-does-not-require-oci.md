# ADR 0008: Do Not Require a Container for the Initial Static Review

Status: Accepted

The initial Big Brother review profile is read-only and static. It does not
execute repository code, run tests, compile, invoke package managers, or
install dependencies. Therefore an OCI container is not a prerequisite for
the first usable deployment. Big Brother may run as a dedicated host process
with service-owned state and workspace directories.

This is an operational simplification, not a claim that Prime's RLM is a
security sandbox. The static profile must keep the review worker's tools
restricted to repository reading and structured result production. GitHub
credentials remain outside the repository workspace, and no push credential is
provided.

ADR 0007 remains the future execution-profile decision: if project code,
tests, builds, or dependencies become part of review, use a rootless OCI
worker container. Until then, Podman/Docker integration is optional and does
not belong in the critical review path.
