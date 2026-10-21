# ADR 0006: Make Check Run Credential Capability Explicit

Status: Superseded for the current MVP by ADR 0012

Big Brother originally selected the non-blocking GitHub Check Run as its first
canonical result surface, but it did not infer write capability from the
presence of a GitHub token. The GitHub REST documentation has a broad note
saying Checks write operations are available to GitHub Apps, while the
individual create and update endpoint sections also list fine-grained
personal access tokens with the `Checks: write` repository permission. Classic
personal access tokens and OAuth app tokens are not a supported assumption for
Check Run writes.

Production deployments should prefer a GitHub App installation token. A
fine-grained personal access token may be used only when explicitly selected
and verified against the target repository. Read/clone credentials and Check
Run publication credentials remain separate, and neither receives push or
repository-content modification authority.

This historical decision is retained to explain the explicit capability
boundary for a future Check Run adapter. The current MVP result surface is
chosen by ADR 0012.

This preserves the user's read-only review boundary while making deployment
failure diagnosable instead of depending on the ambiguous phrase “GitHub
token”.
