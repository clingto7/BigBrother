# ADR 0005: Build Big Brother as an Independent Prime-Derived Agent

Status: Accepted

Big Brother will be a separately launched agent built on the Prime Agent
runtime, not a prompt-only profile and not a full runtime fork. It will have
its own executable identity (`big-brother`), configuration namespace, session
and state location, launcher, selected resources, and container entrypoint.
The upstream Prime runtime will be kept as a versioned source snapshot and a
copied or packaged runtime; Big Brother-specific behavior will live around the
runtime at explicit integration seams.

The Big Brother layer will add the control-plane poller, repository
configuration, durable review/job state, GitHub adapters, review-result
contract, and sandbox policy. Prime will remain responsible for the long-lived
repository agent session, model/provider lifecycle, and RLM child-agent
execution. RLM/Pi workers will be selected and constrained by Big Brother's
review profile rather than by ad hoc prompts in the poller.

This preserves upstream Prime updates and Sifu's proven independent launcher
pattern while keeping Big Brother's domain logic testable without a live model.
It also makes the seam explicit: the control plane must be able to start,
submit work to, recover, and stop a Prime repository runtime without depending
on private Prime session internals. A full Prime fork is reserved for a future
case where the runtime itself must change and a thin integration seam cannot
provide the required behavior.
