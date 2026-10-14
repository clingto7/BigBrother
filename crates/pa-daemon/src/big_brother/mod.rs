//! Big Brother product surface in the fork: the per-repository review
//! profile (ADR 0024), the durable repository state of admitted review
//! ranges and completed review records (ADR 0025), and the review
//! dispatch tool. Everything lives under the agent dir, never inside the
//! watched work tree — reviewed content cannot edit the reviewer's
//! operating rules. The work tree's `.big-brother` understanding assets
//! (ADR 0022) are a separate concern with their own lifecycle.

pub mod harvest;
pub mod init;
pub mod observer;
pub mod profile;
pub mod query;
pub mod state;

pub(crate) mod client;
pub(crate) mod dispatch;
pub(crate) mod git;
pub(crate) mod prompt;
