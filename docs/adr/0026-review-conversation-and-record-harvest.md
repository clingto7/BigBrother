# ADR 0026: Conduct the review conversation in the main session

Status: Accepted for the next design

The repository's review main session is a conductor with a product-owned
system prompt derived from the review profile at every session build:
dispatch one `dispatch_review` call per configured layer for the admitted
range, then synthesize. Deriving the prompt from the profile — instead of
the create command's system-prompt fields — keeps it intact across cold
wakes, where create-config resources do not survive the daemon restart.
The observer's wake message protocol is product-defined:
`REVIEW_RANGE <baseSha>..<headSha> END`.

The dispatch contract follows the framework's spawn model rather than
fighting it: `dispatch_review` spawns the layer's child (model fixed by
the profile) and returns the child's id. Children run only after the
dispatching turn settles, so a tool that waited mid-turn for the child
would deadlock; the layers' FULL answers are therefore collected
observer-side from the settled children, never in-band. The terminal
notices children deliver carry only capped previews and trigger the
conductor's follow-up turns, not the record.

One review record harvests from two sources: the conductor transcript
(the dispatch calls carry the layer and the range; the last conductor text
after the final activity row is the synthesis) and the collected child
answers keyed by layer. The harvester is pure over both inputs and fails
loudly on any incomplete conversation — a missing layer answer, calls
disagreeing on the range, or a missing synthesis never yields a partial
record.
