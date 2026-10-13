# ADR 0020: Share provenanced project direction across monitoring and chat

Status: Accepted for the next design

Background review and the repository's Operator session use the same durable
project understanding. A user-confirmed correction may update Project
direction when it retains its source and rationale; the main agent must expose
conflicts with repository documents rather than silently choosing whichever
statement it saw last. Project direction informs whether a change fits the
repository's goals, but it is not automatically a mandatory Project policy
rule. This makes interactive correction useful across future reviews without
turning an unverified chat transcript into the sole authority for project
facts.

Background review and Operator chat use separate sessions. Both read the same
project assets and Review records; the chat may inspect and direct background
work without inserting user turns into an in-flight review conversation.

The main agent may autonomously admit code-supported technical facts found
during review, preserving evidence and revision history. A change to Project
direction still requires user confirmation before it becomes durable context.
