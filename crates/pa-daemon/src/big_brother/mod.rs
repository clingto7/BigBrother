//! Big Brother product surface in the fork: the per-repository review
//! profile (ADR 0024) and, in later increments, the durable range/cursor
//! state and the review tools. The profile lives under the agent dir, never
//! inside the watched work tree — reviewed content cannot edit the
//! reviewer's operating rules. The work tree's `.big-brother` understanding
//! assets (ADR 0022) are a separate concern with their own lifecycle.

pub(crate) mod dispatch;
pub(crate) mod profile;
