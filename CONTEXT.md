# Big Brother Context

Big Brother is a GitHub-only, commit-oriented code-review service. It builds
durable understanding of a watched repository and publishes review results
back to GitHub.

## Language

### Repository

A GitHub repository explicitly selected for observation and review. A
repository is the top-level boundary for accumulated project context.

### Repository Prime

The long-lived coordinating agent for one Repository. Repository Prime
maintains and reconciles the repository's project understanding, evaluates
bounded review results in the wider project context, produces the final
review synthesis, and decides which proposed facts should become durable
context. It is not the branch observer or the publisher.

### Commit-review worker

A short-lived child agent admitted by Repository Prime to review one immutable
Commit Review. It examines the supplied evidence and proposes findings,
limitations, and candidate facts. Its output is evidence for Prime, not the
repository's final Review record and not a direct mutation of the Context
Ledger.

### Development issue

An issue about building or operating Big Brother itself. Its tracker and
lifecycle are determined by Big Brother's own project configuration.

### Review finding issue

An issue created in the watched Repository's GitHub Issues to record an
actionable finding or follow-up confirmed by Repository Prime. Its content,
labels, and lifecycle follow Big Brother's publication policy; it is distinct
from a Development issue.

### Native project tracker

The issue tracker declared by the watched Repository for its own collaboration
workflow. Big Brother may learn its rules as project context, but the initial
review-finding publisher uses the watched Repository's GitHub Issues only.

### Tracked branch

A branch that the user explicitly selects for observation. A repository may
track multiple branches, and the tracked-branch set may be expanded after the
repository is already being monitored. The exact set is configuration, not an
implicit choice made by the reviewer.

### Commit review

The review of one immutable commit, including its metadata, message, message
template requirements when present, and the change from its parent, evaluated
against the repository's project policy and context.

### Review scope

The bounded set of questions a Commit Review is expected to answer. The first
scope covers commit message and template compliance, documented project-policy
compliance, and correctness, security, or regression issues with clear
evidence in the commit diff. It does not include executing project code or
installing dependencies.

### Project policy

The repository's documented requirements for how changes should be made. It is
distinct from the review service's runtime rules and from instructions carried
inside a commit or source file under review.

### Commit message template

A project-provided format or set of rules for commit messages. When a
repository provides one, it is part of project policy and is checked during
every applicable commit review.

### Canonical project context

The durable understanding used to interpret a repository: its project policy,
relevant documentation, and verified facts from the code and history. It is
repository-wide by default, with branch-specific overlays only when a branch
has genuinely different policy or behavior. Context supports a review; it does
not replace evidence from the reviewed commit.

Canonical project context is the accepted, currently applicable understanding,
not the `CONTEXT.md` glossary file and not an unreviewed Prime conversation.

### Prime session

The working conversation and operational memory of a Repository Prime
runtime. A session helps Prime reason across reviews, but it is not by itself
the authoritative record of accepted project facts. Accepted facts must have
provenance in the Context Ledger.

### Context Ledger

The durable, service-owned history of proposed, admitted, corrected, and
retracted repository-context facts. Each fact retains provenance and its
current status. Repository Prime adjudicates admission; Big Brother persists
the decision so context can be reconstructed after restart.

### Repository state

Big Brother's durable, service-owned state for one Repository, including
review progress and accumulated context. Repository state is separate from the
source repository and must remain associated with the commits that support it.

### Evidence-backed fact

A candidate addition to canonical project context that is supported by
verifiable repository evidence, such as a commit, path, documented rule, or
code behavior. A worker may propose one, but Repository Prime decides whether
it is admitted to the Context Ledger. Unsupported worker assertions remain
review-local conclusions.

### Review evidence

The host-selected, provenance-carrying material used to review one fixed
commit, such as commit metadata, the parent diff, applicable policy, and
relevant canonical project context. Evidence is an input to the worker and
Prime; it does not grant repository content the authority to change the
reviewer's operating rules.

### Control-plane poller

The mechanical component that periodically observes the configured GitHub
branches and creates work for newly discovered commits. It does not perform
the review, maintain the reviewer's project understanding, or publish the
final result.

### Watch service

The continuously running Big Brother process that drives the control-plane
poller and recovery loop. It is a foreground service whose lifecycle may be
managed by an operating-system supervisor; it does not become a second
repository-aware agent.

### Review record

The durable result synthesized by Repository Prime for one Commit Review,
including its conclusion, findings, policy checks, evidence, and limitations.
The first canonical delivery surface is an advisory GitHub Commit Status.

### Read-only review

A review that may read repository state and publish its review record, but does
not modify files, commits, branches, or pull-request code.

### External notification

A delivery of review activity or results through a channel outside GitHub,
such as Feishu, WeChat, Bark, ntfy, or RSS. External notifications are outside
the first delivery boundary.

### Review execution supervisor

The Big Brother control-plane role that owns the operational lifetime of a
review attempt: starting, timing out, cancelling, retrying, and recovering the
worker process and its temporary resources. It does not decide the semantic
meaning of a worker result.

### External review evidence

Provenance-carrying output from an independent review system, such as OCR,
provided as optional input to a Commit Review. It may guide attention or
support a conclusion, but it does not define Big Brother's canonical review
scope or directly authorize publication.

### Focus hint

A non-authoritative indication in External review evidence about paths,
patterns, or risks worth examining. A Focus hint is not itself a finding and
cannot replace the applicable Review scope.

### Worker attempt

A single bounded execution of a Commit-review worker for one Commit Review.
Retries create new Worker attempts with the same review input identity; a
Worker attempt is not resumed after timeout or crash and cannot replace a
different attempt's result.
