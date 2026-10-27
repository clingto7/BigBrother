//! Harvest one review range's structured result (ADR 0026/0030): the
//! conductor transcript's `dispatch_review` calls carry the layer and the
//! range, the layers' answers are the DELIVERED agent-message bodies (a
//! reviewer's own last text narrates the send around the real report), and
//! the synthesis is the conductor's last text after the
//! `REVIEW_SYNTHESIS` marker line. Children without a delivered reply
//! keep ADR 0026's collection — their transcript's last assistant text.
//! Pure over its inputs, so the observer (and tests) can rebuild a
//! Review record from any settled review conversation.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

/// The synthesis marker line (the conductor prompt's output contract,
/// ADR 0030): everything after the last marker line is the synthesis;
/// turn narration never enters the record.
const SYNTHESIS_MARKER: &str = "REVIEW_SYNTHESIS";

/// One harvested layer result: the layer name and its reviewer's full
/// answer.
#[derive(Debug, Clone, PartialEq)]
pub struct HarvestedLayer {
    pub layer: String,
    pub answer: String,
}

/// A range's harvested review: the range identity, the per-layer answers,
/// and the conductor's synthesis.
#[derive(Debug, Clone, PartialEq)]
pub struct HarvestedReview {
    pub base: String,
    pub head: String,
    pub layers: Vec<HarvestedLayer>,
    /// Dispatched layers with neither a delivered answer nor a readable
    /// child transcript. A synthesis can exist despite a child exiting
    /// without a reply; the observer supervises that attempt instead of
    /// treating it as a complete Review record.
    pub missing_layers: Vec<String>,
    /// Missing layers whose exact `<layer>-<head>` child has a terminal
    /// no-reply notice in the conductor transcript.
    pub no_reply_layers: Vec<String>,
    pub conclusion: String,
}

/// Transcript shapes that cannot yield a synthesis or identify a review
/// range are loud. Missing layer answers are returned on
/// [`HarvestedReview`] so the observer can wait for persistence or
/// supervise a confirmed no-reply exit.
#[derive(Debug, thiserror::Error)]
pub enum HarvestError {
    /// The payload is not a messages document at all.
    #[error("no messages array in the transcript payload")]
    NoMessages,
    /// No `dispatch_review` call appears in the transcript.
    #[error("the transcript contains no dispatch_review calls")]
    NoDispatchCalls,
    /// Calls disagree on the range they reviewed.
    #[error("dispatch_review calls disagree on the range: {first} vs {second}")]
    MismatchedRange {
        /// The first observed range.
        first: String,
        /// The conflicting range.
        second: String,
    },
    /// A dispatch call's arguments lack a required field.
    #[error("dispatch_review call \"{call_id}\" has malformed arguments: {reason}")]
    MalformedCall {
        /// The offending tool call id.
        call_id: String,
        /// What is missing or wrong.
        reason: String,
    },
    /// The conductor never wrote a synthesis.
    #[error("the transcript has no synthesis text after the dispatch results")]
    NoConclusion,
}

/// One dispatch call extracted from the transcript.
struct Call {
    layer: String,
    base: String,
    head: String,
}

/// Harvest the review from a `get_messages` payload (`{"messages": [...]}`,
/// or the bare array) plus the collected full answers keyed by layer name.
/// Rows are classified structurally: a row with a `toolCallId` is a tool
/// result, a `custom` row is a child reply, `toolCall` content blocks on
/// an assistant row are dispatch calls, and a text row after the final
/// activity row is the synthesis candidate.
///
/// # Errors
///
/// Any incomplete or inconsistent conversation is a loud
/// [`HarvestError`] — never a partial record.
pub fn harvest_review(
    payload: &Value,
    child_answers: &BTreeMap<String, String>,
) -> Result<HarvestedReview, HarvestError> {
    let rows = payload
        .get("messages")
        .and_then(Value::as_array)
        .or_else(|| payload.as_array())
        .ok_or(HarvestError::NoMessages)?;

    let mut calls: Vec<Call> = Vec::new();
    // The delivered answers (ADR 0030): the conductor's agent-message
    // rows from child senders, keyed (layer, head) — the LAST reply per
    // layer and exact head wins, and a reply for an earlier range never
    // satisfies a later one.
    let mut delivered: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut no_reply_children = BTreeSet::new();
    // The synthesis is the last conductor text AFTER the conversation's
    // final activity row (a tool result or a child-reply custom row):
    // intermediate "awaiting reviewers" texts and the wake message never
    // qualify.
    let mut last_text: Option<(usize, String)> = None;
    let mut last_activity_index: Option<usize> = None;
    let mut seen_result = false;

    for (index, row) in rows.iter().enumerate() {
        if row.get("toolCallId").is_some() {
            seen_result = true;
            last_activity_index = Some(index);
            continue;
        }
        if row.get("role").and_then(Value::as_str) == Some("custom") {
            last_activity_index = Some(index);
            if let Some(child) = no_reply_child(row) {
                no_reply_children.insert(child);
            }
            if let Some((layer, head, body)) = child_reply(row) {
                delivered.insert((layer, head), body);
            }
            continue;
        }
        if let Some(blocks) = row.get("content").and_then(Value::as_array) {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("toolCall")
                    || block.get("name").and_then(Value::as_str) != Some("dispatch_review")
                {
                    continue;
                }
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments = call_argument_object(block);
                let field = |key: &str| -> Option<String> {
                    arguments
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                };
                let (Some(layer), Some(base), Some(head)) =
                    (field("layer"), field("baseSha"), field("headSha"))
                else {
                    return Err(HarvestError::MalformedCall {
                        call_id: id,
                        reason: "layer, baseSha, and headSha are all required".to_string(),
                    });
                };
                // A retried range supersedes its earlier dispatch: the
                // last call per layer is the authoritative one.
                calls.retain(|existing| existing.layer != layer);
                calls.push(Call { layer, base, head });
            }
        }
        let text = content_text(row);
        if !text.is_empty() && seen_result {
            last_text = Some((index, text));
        }
    }
    let conclusion = match (last_text, last_activity_index) {
        (Some((index, text)), Some(activity)) if index > activity => Some(unwrap_synthesis(&text)),
        (Some((_, text)), None) => Some(unwrap_synthesis(&text)),
        _ => None,
    };

    if calls.is_empty() {
        return Err(HarvestError::NoDispatchCalls);
    }
    let base = calls[0].base.clone();
    let head = calls[0].head.clone();
    for call in &calls[1..] {
        if call.base != base || call.head != head {
            return Err(HarvestError::MismatchedRange {
                first: format!("{base}..{head}"),
                second: format!("{}..{}", call.base, call.head),
            });
        }
    }
    let mut layers = Vec::with_capacity(calls.len());
    let mut missing_layers = Vec::new();
    let mut no_reply_layers = Vec::new();
    for call in calls {
        // The delivered body wins (ADR 0030); a layer with no delivered
        // reply keeps the collected child transcript answer (ADR 0026) —
        // wrapped narration and all, never a silent gap.
        let answer = delivered
            .get(&(call.layer.clone(), head.clone()))
            .cloned()
            .or_else(|| child_answers.get(&call.layer).cloned());
        let Some(answer) = answer else {
            if no_reply_children.contains(&format!("{}-{head}", call.layer)) {
                no_reply_layers.push(call.layer.clone());
            }
            missing_layers.push(call.layer);
            continue;
        };
        layers.push(HarvestedLayer {
            layer: call.layer,
            answer,
        });
    }
    let Some(conclusion) = conclusion else {
        return Err(HarvestError::NoConclusion);
    };
    Ok(HarvestedReview {
        base,
        head,
        layers,
        missing_layers,
        no_reply_layers,
        conclusion,
    })
}

/// The layer child named by a terminal no-reply custom row, if present.
fn no_reply_child(row: &Value) -> Option<String> {
    let content = row.get("content").and_then(Value::as_str)?;
    let child = content.strip_prefix("[child-exited: no-reply child:")?;
    Some(child.split_once(']')?.0.to_string())
}

/// The last assistant text of a `get_messages` payload (`{"messages":
/// [...]}`, or the bare array): the observer's child-answer source — the
/// full final answer, where the roster previews are capped.
#[must_use]
pub fn last_assistant_text(payload: &Value) -> Option<String> {
    let rows = payload
        .get("messages")
        .and_then(Value::as_array)
        .or_else(|| payload.as_array())?;
    rows.iter()
        .rev()
        .find(|row| row.get("role").and_then(Value::as_str) == Some("assistant"))
        .and_then(|row| {
            let text = content_text(row);
            (!text.is_empty()).then_some(text)
        })
}

/// A tool call's arguments as an object: native rows carry an object;
/// provider-wire rows carry the JSON as a string.
fn call_argument_object(call: &Value) -> Value {
    match call.get("arguments") {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// One custom row's delivered child reply (ADR 0030): the sender's
/// `<layer>-<head>` session name and the delivered body. Structured
/// first (the row's `details`), the rendered
/// `[agent-message from child:<name>]` header as the fallback shape.
/// `None` for anything that is not a child reply — wake rows, terminal
/// notices, and other custom rows never parse as reviewers.
fn child_reply(row: &Value) -> Option<(String, String, String)> {
    // Structured rows carry the bare session name and body in
    // `details`; rendered-only rows carry both in the header content.
    // Rendered senders carry the relationship prefix ("child:<name>").
    let (sender, body) = if let Some(name) = row
        .pointer("/details/from/sessionName")
        .and_then(Value::as_str)
    {
        (
            name.to_string(),
            row.pointer("/details/message")
                .and_then(Value::as_str)?
                .to_string(),
        )
    } else {
        let content = row.get("content").and_then(Value::as_str)?;
        let header = content.strip_prefix("[agent-message from ")?;
        let (sender, body) = header.split_once("]\n\n")?;
        (sender.to_string(), body.to_string())
    };
    let name = sender.strip_prefix("child:").unwrap_or(sender.as_str());
    // The reviewer name is `<layer>-<head>`: the head (40/64 hex, no
    // dashes) is the LAST dash-separated segment, so a dashed layer
    // name ("project-fit") stays whole.
    let (layer, head) = name.rsplit_once('-')?;
    let head_is_revision =
        matches!(head.len(), 40 | 64) && head.bytes().all(|byte| byte.is_ascii_hexdigit());
    if layer.is_empty() || !head_is_revision {
        return None;
    }
    Some((layer.to_string(), head.to_string(), body))
}

/// The synthesis after the marker line (the conductor prompt's output
/// contract, ADR 0030): everything after the LAST marker line, trimmed.
/// A text without the marker — a pre-contract conversation, or a model
/// that ignored it — is kept whole; so is one whose after-marker body
/// came out empty.
fn unwrap_synthesis(text: &str) -> String {
    let mut cut = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        if line.trim() == SYNTHESIS_MARKER {
            cut = Some(offset + line.len());
        }
        offset += line.len();
    }
    let body = cut.map_or("", |at| text[at..].trim());
    if body.is_empty() {
        text.to_string()
    } else {
        body.to_string()
    }
}

/// A message row's text content: text blocks joined with newlines (a bare
/// string content also accepted).
fn content_text(row: &Value) -> String {
    match row.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BASE: &str = "0123456789abcdef0123456789abcdef01234567";
    const HEAD: &str = "89abcdef0123456789abcdef0123456789abcdef";

    fn dispatch_row(index: usize, arguments: &Value) -> Value {
        json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": format!("call-{index}"), "name": "dispatch_review", "arguments": arguments }
            ]
        })
    }

    fn layer_arguments(layer: &str) -> Value {
        json!({ "layer": layer, "baseSha": BASE, "headSha": HEAD })
    }

    fn complete_transcript() -> Value {
        json!({ "messages": [
            { "role": "custom", "content": format!("[agent-message from observer]\n\nREVIEW_RANGE {BASE}..{HEAD} END") },
            dispatch_row(1, &layer_arguments("requirements")),
            dispatch_row(2, &layer_arguments("project-fit")),
            dispatch_row(3, &layer_arguments("implementation")),
            { "role": "toolResult", "toolCallId": "call-1", "content": [{ "type": "text", "text": "spawned" }] },
            { "role": "toolResult", "toolCallId": "call-2", "content": [{ "type": "text", "text": "spawned" }] },
            { "role": "toolResult", "toolCallId": "call-3", "content": [{ "type": "text", "text": "spawned" }] },
            { "role": "assistant", "content": [{ "type": "text", "text": "awaiting reviewers" }] },
            { "role": "custom", "content": "[child] requirements replied" },
            { "role": "custom", "content": "[child] project-fit replied" },
            { "role": "custom", "content": "[child] implementation replied" },
            { "role": "assistant", "content": [{ "type": "text", "text": "clean overall" }] }
        ]})
    }

    fn complete_answers() -> BTreeMap<String, String> {
        [
            ("requirements", "requirements findings"),
            ("project-fit", "project-fit findings"),
            ("implementation", "implementation findings"),
        ]
        .into_iter()
        .map(|(layer, answer)| (layer.to_string(), answer.to_string()))
        .collect()
    }

    #[test]
    fn the_last_assistant_text_wins_over_earlier_turns() {
        let payload = json!({ "messages": [
            { "role": "assistant", "content": [{ "type": "text", "text": "first" }] },
            { "role": "custom", "content": "a child reply" },
            { "role": "assistant", "content": [{ "type": "text", "text": "final answer" }] },
        ]});
        assert_eq!(
            last_assistant_text(&payload).as_deref(),
            Some("final answer")
        );
        assert_eq!(last_assistant_text(&json!({ "messages": [] })), None);
    }

    #[test]
    fn a_complete_conversation_harvests_range_layers_and_conclusion() {
        let harvested = harvest_review(&complete_transcript(), &complete_answers()).unwrap();
        assert_eq!(harvested.base, BASE);
        assert_eq!(harvested.head, HEAD);
        // The LAST text after the results is the synthesis — the mid-flow
        // "awaiting reviewers" row never wins.
        assert_eq!(harvested.conclusion, "clean overall");
        assert!(harvested.missing_layers.is_empty());
        assert_eq!(
            harvested.layers,
            vec![
                HarvestedLayer {
                    layer: "requirements".into(),
                    answer: "requirements findings".into()
                },
                HarvestedLayer {
                    layer: "project-fit".into(),
                    answer: "project-fit findings".into()
                },
                HarvestedLayer {
                    layer: "implementation".into(),
                    answer: "implementation findings".into()
                },
            ]
        );
    }

    #[test]
    fn provider_wire_string_arguments_parse_identically() {
        let mut transcript = complete_transcript();
        transcript["messages"][1]["content"][0]["arguments"] =
            json!(layer_arguments("requirements").to_string());
        assert!(harvest_review(&transcript, &complete_answers()).is_ok());
    }

    #[test]
    fn an_uncollected_layer_is_reported_for_attempt_supervision() {
        let mut answers = complete_answers();
        answers.remove("project-fit");
        let harvested = harvest_review(&complete_transcript(), &answers).unwrap();
        assert_eq!(harvested.missing_layers, vec!["project-fit"]);
        assert!(harvested.no_reply_layers.is_empty());
        assert_eq!(harvested.conclusion, "clean overall");
    }

    #[test]
    fn an_exact_child_no_reply_notice_marks_only_its_missing_layer_terminal() {
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        rows.insert(
            rows.len() - 1,
            json!({
                "role": "custom",
                "content": format!("[child-exited: no-reply child:project-fit-{HEAD}]")
            }),
        );
        let mut answers = complete_answers();
        answers.remove("project-fit");

        let harvested = harvest_review(&transcript, &answers).unwrap();

        assert_eq!(harvested.missing_layers, vec!["project-fit"]);
        assert_eq!(harvested.no_reply_layers, vec!["project-fit"]);
    }

    #[test]
    fn calls_must_agree_on_the_range() {
        let mut transcript = complete_transcript();
        transcript["messages"][2]["content"][0]["arguments"]["headSha"] =
            json!("fedcba9876543210fedcba9876543210fedcba98");
        let error = harvest_review(&transcript, &complete_answers()).unwrap_err();
        assert!(
            error.to_string().contains("disagree on the range"),
            "{error}"
        );
    }

    #[test]
    fn a_missing_synthesis_is_loud() {
        let mut transcript = complete_transcript();
        transcript["messages"].as_array_mut().unwrap().pop();
        assert!(matches!(
            harvest_review(&transcript, &complete_answers()),
            Err(HarvestError::NoConclusion)
        ));
    }

    #[test]
    fn a_conversation_without_dispatches_is_loud() {
        let payload = json!({ "messages": [{ "role": "user", "content": [] }] });
        assert!(matches!(
            harvest_review(&payload, &complete_answers()),
            Err(HarvestError::NoDispatchCalls)
        ));
    }

    fn reply_row(session_name: &str, body: &str) -> Value {
        json!({
            "role": "custom",
            "customType": "agent_message",
            "content": format!("[agent-message from child:{session_name}]\n\n{body}"),
            "details": {
                "from": { "sessionName": session_name },
                "message": body
            }
        })
    }

    #[test]
    fn delivered_bodies_win_over_child_transcripts() {
        // The reviewer's own last text narrates the send; the delivered
        // body is the clean report (ADR 0030).
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("requirements-{HEAD}"), "clean requirements report"),
        );
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("project-fit-{HEAD}"), "clean project-fit report"),
        );
        rows.insert(
            rows.len() - 1,
            reply_row(
                &format!("implementation-{HEAD}"),
                "clean implementation report",
            ),
        );
        let harvested = harvest_review(&transcript, &complete_answers()).unwrap();
        assert_eq!(
            harvested
                .layers
                .iter()
                .map(|layer| layer.answer.as_str())
                .collect::<Vec<_>>(),
            vec![
                "clean requirements report",
                "clean project-fit report",
                "clean implementation report",
            ]
        );
    }

    #[test]
    fn delivered_bodies_complete_harvest_without_resident_children() {
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        for layer in ["requirements", "project-fit", "implementation"] {
            rows.insert(
                rows.len() - 1,
                reply_row(
                    &format!("{layer}-{HEAD}"),
                    &format!("delivered {layer} report"),
                ),
            );
        }

        let harvested = harvest_review(&transcript, &BTreeMap::new()).unwrap();

        assert!(harvested.missing_layers.is_empty());
        assert_eq!(
            harvested
                .layers
                .iter()
                .map(|layer| layer.answer.as_str())
                .collect::<Vec<_>>(),
            vec![
                "delivered requirements report",
                "delivered project-fit report",
                "delivered implementation report",
            ]
        );
    }

    #[test]
    fn rendered_reply_headers_parse_without_details() {
        // The same rows with only the rendered content (a wire shape
        // without details) parse identically.
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        let rendered = json!({
            "role": "custom",
            "content": format!(
                "[agent-message from child:requirements-{HEAD}]\n\nclean requirements report"
            )
        });
        rows.insert(rows.len() - 1, rendered);
        let harvested = harvest_review(&transcript, &complete_answers()).unwrap();
        assert_eq!(harvested.layers[0].answer, "clean requirements report");
    }

    #[test]
    fn a_later_reply_supersedes_and_old_heads_never_satisfy() {
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        let old_head = "fedcba9876543210fedcba9876543210fedcba98";
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("requirements-{old_head}"), "stale range report"),
        );
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("requirements-{HEAD}"), "first fresh report"),
        );
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("requirements-{HEAD}"), "latest fresh report"),
        );
        let harvested = harvest_review(&transcript, &complete_answers()).unwrap();
        assert_eq!(harvested.layers[0].answer, "latest fresh report");
        // A range whose only reply targets an old head falls back to the
        // collected child answer (ADR 0026's path), never the stale body.
        let mut stale = complete_transcript();
        let rows = stale["messages"].as_array_mut().unwrap();
        rows.insert(
            rows.len() - 1,
            reply_row(&format!("requirements-{old_head}"), "stale range report"),
        );
        let harvested = harvest_review(&stale, &complete_answers()).unwrap();
        assert_eq!(harvested.layers[0].answer, "requirements findings");
    }

    #[test]
    fn non_reply_agent_messages_never_parse_as_reviewers() {
        // The observer's wake row and a terminal notice are custom rows
        // too; neither carries a child:<layer>-<head> sender.
        let mut transcript = complete_transcript();
        let rows = transcript["messages"].as_array_mut().unwrap();
        rows.insert(
            0,
            json!({
                "role": "custom",
                "customType": "agent_message",
                "content": format!("[agent-message from d6d076de6b7d]\n\nREVIEW_RANGE {BASE}..{HEAD} END"),
                "details": { "from": { "clientId": "d6d076de6b7d" }, "message": "REVIEW_RANGE" }
            }),
        );
        rows.insert(
            rows.len() - 1,
            json!({
                "role": "custom",
                "customType": "rlm_child_terminal",
                "content": "[child sub-1 completed without a reply]"
            }),
        );
        let harvested = harvest_review(&transcript, &complete_answers()).unwrap();
        assert_eq!(harvested.layers[0].answer, "requirements findings");
    }

    #[test]
    fn the_synthesis_marker_cuts_turn_narration() {
        let mut transcript = complete_transcript();
        transcript["messages"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["content"] = json!([{
            "type": "text",
            "text": "All layers replied. Writing the synthesis.\n\nREVIEW_SYNTHESIS\n## Range synthesis — clean overall"
        }]);
        let harvested = harvest_review(&transcript, &complete_answers()).unwrap();
        assert_eq!(harvested.conclusion, "## Range synthesis — clean overall");
        // Without the marker (a pre-contract conversation), the whole
        // text stays — and so does one whose after-marker body is empty.
        let mut unmarked = complete_transcript();
        unmarked["messages"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["content"] = json!([{
            "type": "text",
            "text": "narration only, no marker"
        }]);
        assert_eq!(
            harvest_review(&unmarked, &complete_answers())
                .unwrap()
                .conclusion,
            "narration only, no marker"
        );
        let mut empty_after = complete_transcript();
        empty_after["messages"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["content"] = json!([{
            "type": "text",
            "text": "narration\n\nREVIEW_SYNTHESIS\n"
        }]);
        assert_eq!(
            harvest_review(&empty_after, &complete_answers())
                .unwrap()
                .conclusion,
            "narration\n\nREVIEW_SYNTHESIS\n"
        );
    }
}
