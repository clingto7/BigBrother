//! Harvest one review range's structured result (ADR 0026): the
//! conductor transcript's `dispatch_review` calls carry the layer and the
//! range, the conductor's last text message is the synthesis, and the
//! layers' FULL answers come from the children themselves — collected
//! observer-side, because the framework's spawn model defers each child's
//! run until the dispatching turn settles (a mid-turn wait would
//! deadlock). Pure over its inputs, so the observer (and tests) can
//! rebuild a Review record from any settled review conversation.

use std::collections::BTreeMap;

use serde_json::Value;

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
    pub conclusion: String,
}

/// Inputs that cannot yield a complete review: loud, because a record
/// assembled from a partial conversation would report an unfinished
/// assessment as reviewed.
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
    /// A dispatched layer's answer was never collected.
    #[error("layer \"{layer}\" was dispatched but its answer was never collected")]
    MissingAnswer {
        /// The layer that stayed unanswered.
        layer: String,
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
                calls.push(Call { layer, base, head });
            }
        }
        let text = content_text(row);
        if !text.is_empty() && seen_result {
            last_text = Some((index, text));
        }
    }
    let conclusion = match (last_text, last_activity_index) {
        (Some((index, text)), Some(activity)) if index > activity => Some(text),
        (Some((_, text)), None) => Some(text),
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
    for call in calls {
        let Some(answer) = child_answers.get(&call.layer) else {
            return Err(HarvestError::MissingAnswer { layer: call.layer });
        };
        layers.push(HarvestedLayer {
            layer: call.layer,
            answer: answer.clone(),
        });
    }
    let Some(conclusion) = conclusion else {
        return Err(HarvestError::NoConclusion);
    };
    Ok(HarvestedReview {
        base,
        head,
        layers,
        conclusion,
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
    fn a_complete_conversation_harvests_range_layers_and_conclusion() {
        let harvested = harvest_review(&complete_transcript(), &complete_answers()).unwrap();
        assert_eq!(harvested.base, BASE);
        assert_eq!(harvested.head, HEAD);
        // The LAST text after the results is the synthesis — the mid-flow
        // "awaiting reviewers" row never wins.
        assert_eq!(harvested.conclusion, "clean overall");
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
    fn an_uncollected_layer_is_loud() {
        let mut answers = complete_answers();
        answers.remove("project-fit");
        let error = harvest_review(&complete_transcript(), &answers).unwrap_err();
        assert!(
            error.to_string().contains("answer was never collected"),
            "{error}"
        );
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
}
