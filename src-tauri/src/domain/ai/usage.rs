//! Provider-reported counters only: absent fields never become estimated zeros.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

pub(super) fn extract_usage(payload: &Value) -> Option<AiTokenUsage> {
    let usage = payload.get("usage")?;
    let counter = |paths: &[&str]| {
        paths.iter().find_map(|path| {
            usage
                .pointer(path)
                .and_then(Value::as_u64)
                .filter(|value| *value <= 9_007_199_254_740_991)
        })
    };
    let result = AiTokenUsage {
        input_tokens: counter(&["/prompt_tokens", "/input_tokens"]),
        output_tokens: counter(&["/completion_tokens", "/output_tokens"]),
        total_tokens: counter(&["/total_tokens"]),
        cached_input_tokens: counter(&[
            "/prompt_tokens_details/cached_tokens",
            "/input_tokens_details/cached_tokens",
            "/prompt_cache_hit_tokens",
        ]),
        reasoning_tokens: counter(&[
            "/completion_tokens_details/reasoning_tokens",
            "/output_tokens_details/reasoning_tokens",
        ]),
    };
    (result != AiTokenUsage::default()).then_some(result)
}

pub(super) fn usage_from_json(raw: &str) -> Option<AiTokenUsage> {
    extract_usage(&serde_json::from_str::<Value>(raw).ok()?)
}

/// SSE usage events are cumulative snapshots, not increments. Keep the latest
/// reported value of each field, including explicit zero, without double counting.
pub(super) fn merge_usage(target: &mut Option<AiTokenUsage>, payload: &Value) {
    if let Some(next) = extract_usage(payload) {
        let old = target.get_or_insert_with(AiTokenUsage::default);
        old.input_tokens = next.input_tokens.or(old.input_tokens);
        old.output_tokens = next.output_tokens.or(old.output_tokens);
        old.total_tokens = next.total_tokens.or(old.total_tokens);
        old.cached_input_tokens = next.cached_input_tokens.or(old.cached_input_tokens);
        old.reasoning_tokens = next.reasoning_tokens.or(old.reasoning_tokens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_invalid_and_zero_are_distinct() {
        for value in [
            json!({}),
            json!({"usage":null}),
            json!({"usage":{}}),
            json!({"usage":{"prompt_tokens":-1,"completion_tokens":"4","total_tokens":1.5}}),
            json!({"usage":{"total_tokens":9_007_199_254_740_992u64}}),
        ] {
            assert_eq!(extract_usage(&value), None);
        }
        let usage = extract_usage(&json!({"usage":{"prompt_tokens":0}})).unwrap();
        assert_eq!(usage.input_tokens, Some(0));
        assert_eq!(usage.total_tokens, None);
        assert_eq!(
            serde_json::to_value(usage).unwrap(),
            json!({"inputTokens":0})
        );
    }

    #[test]
    fn parses_details_without_adding_subsets_or_deriving_totals() {
        let usage = usage_from_json(r#"{"usage":{"prompt_tokens":80,"completion_tokens":20,"total_tokens":100,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":10}}}"#).unwrap();
        assert_eq!(
            usage,
            AiTokenUsage {
                input_tokens: Some(80),
                output_tokens: Some(20),
                total_tokens: Some(100),
                cached_input_tokens: Some(60),
                reasoning_tokens: Some(10)
            }
        );
        let alias = extract_usage(
            &json!({"usage":{"input_tokens":3,"output_tokens":2,"prompt_cache_hit_tokens":1}}),
        )
        .unwrap();
        assert_eq!(alias.input_tokens, Some(3));
        assert_eq!(alias.cached_input_tokens, Some(1));
        assert_eq!(alias.total_tokens, None);
    }

    #[test]
    fn repeated_and_partial_snapshots_are_not_summed() {
        let mut usage = None;
        for _ in 0..2 {
            merge_usage(
                &mut usage,
                &json!({"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}),
            );
        }
        merge_usage(&mut usage, &json!({"usage":null}));
        merge_usage(&mut usage, &json!({"usage":{"completion_tokens":0}}));
        let usage = usage.unwrap();
        assert_eq!(usage.input_tokens, Some(8));
        assert_eq!(usage.output_tokens, Some(0));
        assert_eq!(usage.total_tokens, Some(10));
    }
}
