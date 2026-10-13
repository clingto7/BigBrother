//! The review main session's dispatch tool: spawn one review-layer child
//! for an immutable range. The layer's reviewer model comes from the
//! repository's review profile — configuration, never the main agent's
//! tool-argument choice (ADR 0019).

use std::sync::Arc;

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
        description: "Dispatch one review layer for an immutable range; each layer's reviewer model is fixed by the repository's review profile".into(),
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
                let handle = children
                    .spawn(RlmSpawnRequest {
                        prompt: format!("Review {layer} for {base}..{head}"),
                        name: Some(layer),
                        model: Some(model.to_string()),
                        thinking: None,
                        spawned_by_request_id: None,
                        cell_source_code: None,
                    })
                    .await?;
                Ok(ToolExecutionResult::text(handle.rlm_child_id))
            })
        }),
    })
}
