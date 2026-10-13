# Big Brother Context

Big Brother is a repository review agent that monitors changes, maintains
project understanding, and makes review results available to its users.

Some terms below describe the v0.1.0-beta.1 implementation. ADRs 0018–0023
define changes agreed for the next design; where they differ, the ADRs govern
the new implementation.

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

### Review range

A bounded change from the last reviewed revision to an observed branch head
that receives one overall review synthesis. Individual pushed commits remain
identifiable within the range.

### Review layer

A distinct level of assessment within a Review range, progressing from
verifiable requirements through project fit to implementation quality. A
layer's reviewer supplies evidence and proposals for the final synthesis.

### Review scope

The bounded set of questions a review is expected to answer. The initial
scope spans verifiable requirements, fit with project rules and direction,
and implementation quality, with conclusions tied to evidence.

### Project policy

The repository's documented requirements for how changes should be made. It is
distinct from the review service's runtime rules and from instructions carried
inside a commit or source file under review.

### Project direction

The repository's intended trajectory, supported by repository evidence or a
user-confirmed decision with provenance. It informs project-fit assessment;
it is distinct from a mandatory Project policy rule.

### Commit message template

A project-provided format or set of rules for commit messages. When a
repository provides one, it is part of project policy and is checked during
every applicable review.

### Canonical project context

The durable understanding used to interpret a repository: its project policy,
project direction, relevant documentation, and accepted facts with provenance.
It is repository-wide by default, with branch-specific overlays only when a
branch has genuinely different policy or behavior.

Canonical project context is the accepted, currently applicable understanding,
not the `CONTEXT.md` glossary file and not an unreviewed Prime conversation.

### Prime session

The working conversation and operational memory of a Repository Prime
runtime. A session helps Prime reason across reviews, but it is not by itself
the authoritative record of accepted project facts. Accepted facts must have
provenance in the Context Ledger.

### Operator session

An interactive, repository-scoped conversation through which a user can ask
about review results and evidence, inspect a specified code revision, or
request further review. It uses the same durable project understanding as
background monitoring.

### Context Ledger

The durable history of proposed, admitted, corrected, and retracted
repository-context facts. Each fact retains provenance and its
current status. Repository Prime adjudicates admission; Big Brother persists
the decision so context can be reconstructed after restart.

### Repository state

Big Brother's durable operational state for one Repository, including review
progress, completed results, and delivery status. It is separate from Project
understanding assets and remains associated with the revisions it covers.

### Project understanding assets

The inspectable code map, project overview, and provenance-bearing context
that Big Brother maintains for a Repository. They provide the initial and
evolving basis for review.

### Repository initialization

The first construction of Project understanding assets for a newly enrolled
Repository, based on its codebase and project documents.

### Repository indexing

A later, explicit recalibration of Project understanding assets after a major
repository change. It is distinct from their incremental update during review.

### Evidence-backed fact

A candidate addition to canonical project context that is supported by
verifiable repository evidence, such as a commit, path, documented rule, or
code behavior. A worker may propose one, but Repository Prime decides whether
it is admitted to the Context Ledger. Unsupported worker assertions remain
review-local conclusions.

### Review evidence

The host-selected, provenance-carrying material used to review one fixed
revision or Review range, such as commit metadata, the diff, applicable policy,
and relevant canonical project context. Evidence is an input to the worker and
Prime; it does not grant repository content the authority to change the
reviewer's operating rules.

### Control-plane poller

The mechanical component that periodically observes the configured GitHub
branches and creates work for newly discovered Review ranges. It does not
perform the review, maintain the reviewer's project understanding, or publish the
final result.

### Watch service

The continuously running Big Brother service that drives branch observation
and recovery. It does not replace the repository-aware agent's judgment.

### Review record

The durable result synthesized by the repository's main agent for one bounded
review, including its conclusion, findings, policy checks, evidence, and
limitations. Delivery channels present this record to users.

### Read-only review

A review that may read repository state, update Project understanding assets,
and publish its Review record, but does not modify source files, commits,
branches, or pull-request code.

### External notification

A delivery of review activity or results through a channel outside GitHub,
such as Bark, Feishu, WeChat, ntfy, or RSS.

### Review execution supervisor

The Big Brother control-plane role that owns the operational lifetime of a
review attempt: starting, timing out, cancelling, retrying, and recovering the
worker process and its temporary resources. It does not decide the semantic
meaning of a worker result.

### External review evidence

Provenance-carrying output from an independent review system, such as OCR,
provided as optional input to a review. It may guide attention or
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
