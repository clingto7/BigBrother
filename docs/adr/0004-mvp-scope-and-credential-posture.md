# ADR 0004: Set the MVP Scope and Credential Posture

Status: Accepted

The product configuration will support multiple GitHub repositories from the
beginning. Each repository will have isolated Prime ownership and durable
service state, while the first implementation may validate the design against
one repository. The first review scope is limited to commit message and
template compliance, documented project-policy compliance, and correctness,
security, or regression issues that have clear evidence in the commit diff.
The first version will not execute project code or install dependencies.

The MVP will accept configured SSH and explicitly typed token credentials as
appropriate for repository access and GitHub Commit Status publication. The
credentials are separated by purpose and do not grant push or
repository-content modification authority. Commit Status credential details
are defined by ADR 0012; a generic `gh` login token is not assumed to be
writable.

This keeps the first product useful without pretending to provide complete
automated verification. It permits a narrow, auditable permission model and a
single-repository validation path, while leaving room to add execution profiles
and GitHub App authentication later without changing the review domain.
