# ADR 0030: Harvest clean bodies from the delivered agent messages

Status: Accepted for the next design

ADR 0026 harvests the layers' answers from each child's own final
assistant text and the synthesis from the conductor's last text. The
real-model runs showed both surfaces carry wrapper narration: a
reviewer's final text opens with its send narration ("Sent ... to the
parent") around the real body, and the conductor's synthesis text
opens with a turn preamble ("Writing the synthesis."). The bodies the
review actually produced are already on the wire — delivered, not
narrated.

The layers' clean answers are the conductor transcript's agent-message
rows: each reviewer sends its report through the framework's
`agent_message.send`, and the conductor's row carries the delivered
body in its details with the child's `<layer>-<head>` session name.
The harvest reads the delivered body per layer and range (the last
reply for an exact head wins; a reply for an earlier range never
satisfies a later one), structured first and the rendered
`[agent-message from child:<name>]` header as the fallback shape. A
layer with no delivered row keeps ADR 0026's collection — the child
transcript's last assistant text — so a conversation whose reviewers
never used the message tool still completes, wrapped answer and all.

The synthesis gets an explicit output contract instead: the conductor
prompt requires the final message to begin with a line exactly
`REVIEW_SYNTHESIS`, and the harvest keeps everything after the last
marker line, trimmed. The conductor is a top-level session — there is
no parent to deliver a synthesis message to — so the marker is the
machine-extractable boundary between turn narration and the synthesis
itself. A text without the marker (a conversation from before the
contract, or a model that ignored it) is kept whole; an empty
after-marker body falls back the same way. The system prompt is
rebuilt at every session build (ADR 0026), so the contract takes
effect on the next turn without any session migration.

The prompt is derived from the profile at session build, so the
contract rides the existing rebuild; the mock providers in the e2e
suites speak the marker, making the unwrap a verified behavior rather
than a hopeful string cut.
