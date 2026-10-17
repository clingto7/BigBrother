//! The review main session's dispatch tool: spawn one review-layer child
//! for an immutable range and return its child id. The layer's reviewer
//! model comes from the repository's review profile — configuration,
//! never the main agent's tool-argument choice (ADR 0019). The child runs
//! after the conductor's turn settles (the framework's spawn model); its
//! full answer is collected observer-side, never through a mid-turn wait
//! (which the spawn deferral would deadlock).

use std::sync::Arc;

use anyhow::Context as _;
use serde_json::Value;

use crate::big_brother::profile::ReviewProfile;
use crate::rlm_children::SupervisorChildSessions;

/// Build the `dispatch_review` tool for a repository's review main
/// session: `layer` selects a profile-configured reviewer; `baseSha` and
/// `headSha` bound the immutable range. Returns the spawned child's id.
pub(crate) fn dispatch_review_tool(
    children: Arc<SupervisorChildSessions>,
    profile: Arc<ReviewProfile>,
) -> Arc<dyn pa_agent::types::AgentTool> {
    use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
    use pa_core::session_engine::tool_bridge::bridge_tool;
    use pa_core::{ExecutionMode, ToolDefinition, ToolExecutionResult};

    let layer_names: Vec<&str> = profile
        .layers
        .iter()
        .map(|layer| layer.name.as_str())
        .collect();
    bridge_tool(ToolDefinition {
        name: "dispatch_review".into(),
        label: "Dispatch review".into(),
        description: "Dispatch one review layer for an immutable range; the layer's reviewer runs after this turn settles and its reply arrives as a child message. Each layer's reviewer model is fixed by the repository's review profile".into(),
        prompt_snippet: String::new(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "layer": { "type": "string", "enum": layer_names },
                "baseSha": { "type": "string" },
                "headSha": { "type": "string" }
            },
            "required": ["layer", "baseSha", "headSha"]
        }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, _signal, _on_update| {
            let children = Arc::clone(&children);
            let profile = Arc::clone(&profile);
            Box::pin(async move {
                let field = |key: &str| -> anyhow::Result<String> {
                    params
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| anyhow::anyhow!("missing {key}"))
                };
                let layer = field("layer")?;
                let base = field("baseSha")?;
                let head = field("headSha")?;
                let Some(model) = profile.layer_model(&layer) else {
                    let names = profile
                        .layers
                        .iter()
                        .map(|candidate| candidate.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    anyhow::bail!("unknown review layer \"{layer}\"; configured layers: {names}");
                };
                // The child's name carries the range head: a later range
                // reuses the layer (name reservation would refuse the
                // same name), and the observer matches the exact
                // in-flight range — a stale child never answers for it.
                let child_name = format!("{layer}-{head}");
                let spawn_request = || RlmSpawnRequest {
                    prompt: format!("Review {layer} for {base}..{head}"),
                    name: Some(child_name.clone()),
                    model: Some(model.to_string()),
                    thinking: None,
                    spawned_by_request_id: None,
                    cell_source_code: None,
                };
                let handle = match children.spawn(spawn_request()).await {
                    Ok(handle) => handle,
                    Err(first) => {
                        // A retry's fresh dispatch reuses the
                        // `<layer>-<head>` name (ADR 0028); the cancelled
                        // prior attempt's dead reviewer record must not
                        // hold it forever. Retire the dead name and spawn
                        // again — a LIVE same-name child still refuses
                        // (the running verdict).
                        let verdict = children.retire_dead_child_name(&child_name).await;
                        match verdict {
                            Ok("deleted") => children.spawn(spawn_request()).await
                                .with_context(|| {
                                    format!(
                                        "re-spawning reviewer {child_name} after retiring its dead record (first spawn: {first:#})"
                                    )
                                })?,
                            other => {
                                return Err(anyhow::anyhow!(
                                    "spawning the review child (name retire verdict {other:?}): {first:#}"
                                ));
                            }
                        }
                    }
                };
                Ok(ToolExecutionResult::text(format!(
                    "layer {layer} reviewer spawned as child {} for {base}..{head}",
                    handle.rlm_child_id
                )))
            })
        }),
    })
}
