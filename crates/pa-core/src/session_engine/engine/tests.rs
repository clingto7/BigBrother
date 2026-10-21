//! The engine unit battery: the scripted tool loop, the child-depth
//! stamp, the MCP-gating unlock, and the goal/heartbeat handler
//! registration.
use super::*;
use crate::session_engine::rlm_host::{
    NoRlmChildren, RlmChildResult, RlmCreateSessionHandle, RlmCreateSessionRequest,
    RlmDeleteSubagentResult, RlmHostFuture, RlmSpawnHandle, RlmSpawnRequest, RlmSubagentEntry,
    RlmSubagentHost,
};
use crate::session_engine::tool_bridge::{bridge_tool, ToolDefinitionBridge};
use crate::tools::tool_definition::{ExecutionMode, ToolDefinition, ToolExecutionResult};
use pa_agent::scripted::ScriptedProvider;

fn echo_definition() -> ToolDefinition {
    ToolDefinition {
        name: "echo".to_string(),
        label: "Echo".to_string(),
        description: "Echoes its input".to_string(),
        prompt_snippet: String::new(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(|_id, params, _signal, _on_update| {
            let text = params
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string();
            Box::pin(async move { Ok(ToolExecutionResult::text(format!("echo: {text}"))) })
        }),
    }
}

#[tokio::test]
async fn engine_runs_tool_loop_and_persists() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_tool_call_turn(
        Some("checking"),
        vec![("call-1", "echo", serde_json::json!({ "text": "hi" }))],
    );
    provider.push_text_turn("all done");

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(echo_definition())],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    // The system prompt is the layered assembly: static core layer
    // first, dynamic tail after.
    assert!(engine.system_prompt.starts_with("# prime-agent harness"));
    assert!(engine
        .system_prompt
        .contains("Recursive agent depth: 0 (root)"));

    let outcome = engine
        .prompt("run the echo tool", PromptOptions::default())
        .await
        .unwrap();
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    let state = engine.session.agent().state().await;
    assert!(state.messages.iter().any(|message| match message {
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(result)) => {
            result.tool_name == "echo"
        }
        _ => false,
    }));
    assert!(state.messages.iter().any(|message| match message {
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant)) => {
            assistant.content.iter().any(|block| {
                matches!(
                    block,
                    pa_agent::types::AssistantContent::Text(text) if text.text == "all done"
                )
            })
        }
        _ => false,
    }));
    let entries = engine.session.entries().await;
    assert!(entries.iter().any(|entry| matches!(
        entry,
        pa_types::session::FileEntry::Message {
            message: pa_types::session::AgentMessage::User(user),
            ..
        } if user.content.text() == "run the echo tool"
    )));
    let _ = ToolDefinitionBridge::new;
}

#[tokio::test]
async fn review_session_runs_only_its_supplied_tool() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_tool_call_turn(
        None,
        vec![("call-1", "echo", serde_json::json!({"text": "hi"}))],
    );
    provider.push_text_turn("done");
    let tmp = tempfile::tempdir().unwrap();
    let engine = create_review_session(SessionEngineConfig {
        cwd: tmp.path().to_path_buf(),
        agent_dir: tmp.path().join("agent"),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(echo_definition())],
        ..Default::default()
    })
    .await
    .unwrap();
    let names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert_eq!(names, vec!["echo"]);
    assert!(engine
        .system_prompt
        .contains("This session has no Python REPL"));
    engine
        .prompt("read evidence", PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let state = engine.session.agent().state().await;
    assert!(state.messages.iter().any(|message| matches!(message,
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(result))
            if result.tool_name == "echo"
    )));
}

struct RecordingReviewHost {
    requests: Arc<tokio::sync::Mutex<Vec<RlmSpawnRequest>>>,
    fallback: NoRlmChildren,
}

impl RlmSubagentHost for RecordingReviewHost {
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let requests = Arc::clone(&self.requests);
        Box::pin(async move {
            let name = request.name.clone().unwrap_or_else(|| "review".into());
            let model = request.model.clone().unwrap_or_default();
            requests.lock().await.push(request);
            Ok(RlmSpawnHandle {
                rlm_child_id: format!("sub-{name}"),
                name,
                session_dir: "/tmp/spike-child".into(),
                model,
            })
        })
    }

    fn create_session(
        &self,
        request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle> {
        self.fallback.create_session(request)
    }

    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
        self.fallback.list_subagents()
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        self.fallback.delete_subagent(target)
    }

    fn collect(&self, targets: Vec<String>, timeout_ms: u64) -> RlmHostFuture<Vec<RlmChildResult>> {
        self.fallback.collect(targets, timeout_ms)
    }

    fn rename(&self, name: String, session_id: Option<String>) -> RlmHostFuture<String> {
        self.fallback.rename(name, session_id)
    }
}

#[tokio::test]
async fn restricted_main_agent_dispatches_fixed_range_review_children() {
    let model = pa_agent::types::Model {
        id: "main".into(),
        name: "main".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let layers = ["requirements", "project-fit", "implementation"];
    let call_ids = ["call-1", "call-2", "call-3"];
    provider.push_tool_call_turn(
        None,
        layers
            .iter()
            .zip(call_ids)
            .map(|(layer, call_id)| {
                (
                    call_id,
                    "dispatch_review",
                    serde_json::json!({
                        "layer": layer,
                        "baseSha": "base-123",
                        "headSha": "head-456",
                    }),
                )
            })
            .collect(),
    );
    provider.push_text_turn("reviews dispatched");

    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let fallback_session = Arc::new(tokio::sync::Mutex::new(SessionManager::in_memory(
        tmp.path(),
    )));
    let host: Arc<dyn RlmSubagentHost> = Arc::new(RecordingReviewHost {
        requests: Arc::clone(&requests),
        fallback: NoRlmChildren::new(fallback_session),
    });
    let tool_host = Arc::clone(&host);
    // The dispatch configuration, not the model's tool arguments, picks
    // each layer's reviewer model (ADR 0019).
    let layer_models: std::collections::HashMap<String, String> = layers
        .iter()
        .map(|layer| ((*layer).to_string(), format!("provider/{layer}")))
        .collect();
    let tool = ToolDefinition {
        name: "dispatch_review".into(),
        label: "Dispatch review".into(),
        description: "Review one fixed range in one layer".into(),
        prompt_snippet: String::new(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "layer": {"type": "string"},
                "baseSha": {"type": "string"},
                "headSha": {"type": "string"}
            },
            "required": ["layer", "baseSha", "headSha"]
        }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(move |_id, params, _signal, _on_update| {
            let host = Arc::clone(&tool_host);
            let layer_models = layer_models.clone();
            Box::pin(async move {
                let field = |key: &str| -> anyhow::Result<String> {
                    Ok(params
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("missing {key}"))?
                        .to_string())
                };
                let layer = field("layer")?;
                let base = field("baseSha")?;
                let head = field("headSha")?;
                let Some(model) = layer_models.get(&layer) else {
                    anyhow::bail!("unknown review layer \"{layer}\"");
                };
                let handle = host
                    .spawn(RlmSpawnRequest {
                        prompt: format!("Review {layer} for {base}..{head}"),
                        name: Some(layer),
                        model: Some(model.clone()),
                        thinking: None,
                        spawned_by_request_id: None,
                        cell_source_code: None,
                    })
                    .await?;
                Ok(ToolExecutionResult::text(handle.rlm_child_id))
            })
        }),
    };
    let engine = create_review_session(SessionEngineConfig {
        cwd: tmp.path().to_path_buf(),
        agent_dir: tmp.path().join("agent"),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(tool)],
        rlm_subagent_host: Some(host),
        ..Default::default()
    })
    .await
    .unwrap();
    let names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert_eq!(names, vec!["dispatch_review"]);
    engine
        .prompt("review base-123..head-456", PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    let recorded = requests.lock().await;
    assert_eq!(recorded.len(), 3);
    for (request, layer) in recorded.iter().zip(layers) {
        assert_eq!(request.name.as_deref(), Some(layer));
        assert_eq!(
            request.model.as_deref(),
            Some(format!("provider/{layer}").as_str())
        );
        assert_eq!(
            request.prompt,
            format!("Review {layer} for base-123..head-456")
        );
    }
}

/// A spawned child's prompt stamps its recursion depth: `create_session`
/// at depth N reads "depth: N (not root)", never the root identity.
#[tokio::test]
async fn spawned_child_prompt_stamps_its_depth() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(echo_definition())],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: Some(2),
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    assert!(engine
        .system_prompt
        .contains("Recursive agent depth: 2 (not root)"));
    assert!(!engine.system_prompt.contains("depth: 0 (root)"));
}

/// The login chain's prompt-gating end to end: a settings-declared OAuth
/// server stays gated, an endpoint-bound credential unlocks it in the NEXT
/// session, and one bound to another endpoint does not.
#[tokio::test]
async fn oauth_creds_unlock_generic_mcp_gating_in_new_sessions() {
    fn model() -> pa_agent::types::Model {
        pa_agent::types::Model {
            id: "m".into(),
            name: "m".into(),
            api: "test".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            cost: pa_agent::types::UsageCost::default(),
            context_window: 1_000,
            max_tokens: 100,
            max_tokens_explicit: false,
        }
    }

    fn config(
        cwd: &std::path::Path,
        agent_dir: &std::path::Path,
        stream_fn: pa_agent::stream::StreamFn,
    ) -> SessionEngineConfig {
        SessionEngineConfig {
            on_late_sent_agent_message: None,
            semantic_edges: None,
            cron_store: None,
            queued_steering_probe: None,
            should_stop_after_turn: None,
            image_model_router: None,
            steering_mode: None,
            follow_up_mode: None,
            cwd: cwd.to_path_buf(),
            agent_dir: agent_dir.to_path_buf(),
            mcp_manager: None,
            model: Some(model()),
            thinking_level: None,
            stream_fn: Some(stream_fn),
            tools: vec![],
            custom_system_prompt: None,
            prompt_guidelines: vec![],
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager: None,
            extra_host_handlers: None,
            conversation_log_path: None,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: None,
            rlm_usage_store: None,
            progress_note_emit: None,
            rlm_depth: None,
            daemonless: true,
            telemetry: None,
            model_info: None,
            on_background_work_settled: None,
            prewarm_ipython_kernel: None,
            queued_goal_context_purge: None,
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    let agent_dir = tmp.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The settings declaration the daemon worker's MCP manager also
    // resolves (an OAuth HTTP server, like `mcp add ... --oauth`).
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({
            "mcpServers": {
                "fixture-oauth": {
                    "type": "http",
                    "url": "https://fixture.example/mcp",
                    "oauth": true,
                },
            },
        })
        .to_string(),
    )
    .unwrap();
    let provider = Arc::new(ScriptedProvider::new(model()));

    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(!engine.system_prompt.contains("# Generic MCP Connections"));

    // The persisted credential begin_login leaves behind (the TS
    // McpCredentials shape, endpoint-bound).
    let write_credential = |endpoint: &str| {
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "mcp:fixture-oauth": {
                    "type": "oauth",
                    "access": "fixture-access",
                    "refresh": "fixture-refresh",
                    "expires": 999_999_999_999_999_i64,
                    "endpoint": endpoint,
                    "tokenEndpoint": "https://fixture.example/token",
                    "clientId": "fixture-client",
                },
            })
            .to_string(),
        )
        .unwrap();
    };

    // A credential bound to another endpoint stays gated: the token
    // must prove where it belongs.
    write_credential("https://other.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(!engine.system_prompt.contains("# Generic MCP Connections"));

    write_credential("https://fixture.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(engine.system_prompt.contains("# Generic MCP Connections"));
    assert!(engine.system_prompt.contains("`fixture-oauth`"));
}

#[tokio::test]
async fn create_session_registers_goal_and_heartbeat_handlers() {
    let dir = tempfile::TempDir::new().unwrap();
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "ok",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    let model = registration.get_model();
    let agent_model = crate::session_engine::provider_adapter::json_round_trip(&model).unwrap();
    let stream_fn = crate::session_engine::provider_adapter::real_stream_fn(None, model.clone());
    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().to_path_buf(),
        model: Some(agent_model),
        stream_fn: Some(stream_fn),
        tools: Vec::new(),
        ..Default::default()
    })
    .await
    .unwrap();
    let names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert!(
        names.iter().any(|name| name == "python_repl"),
        "tools: {names:?}"
    );
}

/// A daemon-shaped resume: an in-memory session manager (the daemon's
/// non-persisted engine session) already holding a message, plus a
/// `conversation_log_path`, still auto-appends the missing
/// thinking-level and service-tier rows (#3350's gate regression).
#[tokio::test]
async fn create_session_appends_missing_resume_settings_rows() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let mut session_manager =
        crate::session::manager::SessionManager::in_memory_in_session_dir(&cwd, tmp.path());
    session_manager
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("resumed".into()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            },
        ))
        .unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: Some(session_manager),
        extra_host_handlers: None,
        conversation_log_path: Some(tmp.path().join("session.jsonl")),
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    let entries = engine.session.entries().await;
    assert!(
        entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::ThinkingLevelChange { .. }
        )),
        "entries: {entries:?}"
    );
    assert!(
        entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::ServiceTierChange { .. }
        )),
        "entries: {entries:?}"
    );
}
