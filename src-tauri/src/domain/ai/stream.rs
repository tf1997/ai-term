use std::future::Future;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::chat::{
    ai_http_client, is_cancelled, AiCancelToken, AI_TERM_CLIENT_NAME, AI_TERM_CLIENT_VERSION,
};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(super) async fn wait_for_stream<T>(
    operation: impl Future<Output = T>,
    timeout_seconds: u32,
    cancel_token: Option<&AiCancelToken>,
) -> Result<Option<T>> {
    let deadline = async {
        if timeout_seconds == 0 {
            std::future::pending::<()>().await;
        } else {
            tokio::time::sleep(Duration::from_secs(u64::from(timeout_seconds))).await;
        }
    };
    tokio::pin!(operation, deadline);
    loop {
        if is_cancelled(cancel_token) {
            return Ok(None);
        }
        tokio::select! {
            result = &mut operation => return Ok(Some(result)),
            _ = &mut deadline => bail!(
                "AI 流式响应超时：连续 {timeout_seconds} 秒未收到数据，可调整 AI 配置中的请求超时后重试"
            ),
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL), if cancel_token.is_some() => {}
        }
    }
}

/// 流式请求的建立结果:网关拒绝时状态码与错误正文已经读出,由调用方决定文案。
pub(super) enum StreamStart {
    Cancelled,
    Rejected { status: u16, body: String },
    Open(reqwest::Response),
}

/// 建立 SSE 流。网关不认识 `stream_options`(OpenAI 协议里请求携带 usage 的字段)
/// 时会以 4xx 拒绝整个请求,此时去掉该字段重试一次:用量统计不能挡住回答本身。
pub(super) async fn open_stream(
    endpoint: &str,
    api_key: &str,
    mut payload: Value,
    timeout_seconds: u32,
    cancel_token: Option<&AiCancelToken>,
) -> Result<StreamStart> {
    loop {
        let Some(response) =
            send_stream_request(endpoint, api_key, &payload, timeout_seconds, cancel_token).await?
        else {
            return Ok(StreamStart::Cancelled);
        };
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(StreamStart::Open(response));
        }
        let body = stream_error_body(response, timeout_seconds, cancel_token).await;
        if rejects_stream_options(&payload, &body) {
            if let Some(object) = payload.as_object_mut() {
                object.remove("stream_options");
            }
            continue;
        }
        return Ok(StreamStart::Rejected { status, body });
    }
}

fn rejects_stream_options(payload: &Value, body: &str) -> bool {
    if payload.get("stream_options").is_none() {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("stream_options") || lower.contains("include_usage")
}

async fn send_stream_request(
    endpoint: &str,
    api_key: &str,
    payload: &Value,
    timeout_seconds: u32,
    cancel_token: Option<&AiCancelToken>,
) -> Result<Option<reqwest::Response>> {
    let request = ai_http_client()?
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("X-Client-Name", AI_TERM_CLIENT_NAME)
        .header("X-Client-Version", AI_TERM_CLIENT_VERSION)
        .bearer_auth(api_key.trim())
        .body(payload.to_string());
    wait_for_stream(request.send(), timeout_seconds, cancel_token)
        .await?
        .transpose()
        .with_context(|| format!("AI 流式网络请求失败：{endpoint}"))
}

async fn stream_error_body(
    response: reqwest::Response,
    timeout_seconds: u32,
    cancel_token: Option<&AiCancelToken>,
) -> String {
    match wait_for_stream(response.text(), timeout_seconds, cancel_token).await {
        Ok(Some(Ok(body))) => body,
        Ok(Some(Err(error))) => format!("读取模型错误正文失败：{error}"),
        Err(error) => format!("读取模型错误正文失败：{error:#}"),
        Ok(None) => String::new(),
    }
}

#[derive(Default)]
pub(super) struct SseEventBuffer {
    text: String,
    previous_cr: bool,
}

impl SseEventBuffer {
    pub(super) fn push(&mut self, text: &str) {
        for character in text.chars() {
            if character == '\r' {
                self.text.push('\n');
            } else if character != '\n' || !self.previous_cr {
                self.text.push(character);
            }
            self.previous_cr = character == '\r';
        }
    }

    pub(super) fn next_event(&mut self) -> Option<String> {
        let index = self.text.find("\n\n")?;
        let event = self.text[..index].to_string();
        self.text.drain(..index + 2);
        Some(event)
    }

    pub(super) fn remaining(&self) -> &str {
        &self.text
    }
}

pub(super) fn is_stream_done(event: &str) -> bool {
    event.lines().any(|line| {
        line.trim()
            .strip_prefix("data:")
            .is_some_and(|data| data.trim() == "[DONE]")
    })
}

pub(super) fn sse_data_payloads(event: &str) -> Vec<String> {
    event
        .split("\n\n")
        .filter_map(|block| {
            let data = block
                .lines()
                .map(str::trim)
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            (!data.trim().is_empty()).then_some(data)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::Ordering, Arc};

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn active_stream_restarts_configured_idle_timeout() {
        let started = tokio::time::Instant::now();
        for _ in 0..4 {
            let chunk = wait_for_stream(
                async {
                    tokio::time::sleep(Duration::from_secs(40)).await;
                    "chunk"
                },
                60,
                None,
            )
            .await
            .unwrap();
            assert_eq!(chunk, Some("chunk"));
        }
        assert_eq!(started.elapsed(), Duration::from_secs(160));
    }

    #[tokio::test(start_paused = true)]
    async fn idle_stream_uses_configured_timeout() {
        let started = tokio::time::Instant::now();
        let error = wait_for_stream(std::future::pending::<()>(), 30, None)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("连续 30 秒未收到数据"));
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn zero_timeout_allows_long_silence() {
        let result = wait_for_stream(
            async {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                "late chunk"
            },
            0,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result, Some("late chunk"));
    }

    #[tokio::test(start_paused = true)]
    async fn polling_cancellation_does_not_reset_timeout() {
        let token = AiCancelToken::default();
        let started = tokio::time::Instant::now();
        assert!(
            wait_for_stream(std::future::pending::<()>(), 5, Some(&token))
                .await
                .is_err()
        );
        assert_eq!(started.elapsed(), Duration::from_secs(5));
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_interrupts_an_idle_read() {
        let token = AiCancelToken::default();
        let cancel = Arc::clone(&token);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            cancel.store(true, Ordering::Relaxed);
        });
        let started = tokio::time::Instant::now();
        assert!(
            wait_for_stream(std::future::pending::<()>(), 0, Some(&token))
                .await
                .unwrap()
                .is_none()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn accepts_all_sse_line_endings_across_chunks() {
        for separator in ["\n", "\r\n", "\r"] {
            let mut buffer = SseEventBuffer::default();
            for character in format!("data: hello{separator}{separator}").chars() {
                buffer.push(&character.to_string());
            }
            assert_eq!(buffer.next_event().as_deref(), Some("data: hello"));
            assert!(buffer.next_event().is_none());
        }
    }

    #[test]
    fn only_done_data_finishes_stream() {
        assert!(is_stream_done("data: [DONE]"));
        assert!(!is_stream_done(": [DONE]"));
        assert!(!is_stream_done("data: {\"text\":\"[DONE]\"}"));
    }

    #[test]
    fn joins_multiline_sse_data_and_keeps_events_separate() {
        assert_eq!(
            sse_data_payloads("event: message\ndata: {\"value\":\ndata: 1}\n\ndata: [DONE]"),
            vec!["{\"value\":\n1}", "[DONE]"]
        );
    }

    #[test]
    fn retries_without_stream_options_only_when_gateway_names_the_field() {
        let with_usage =
            serde_json::json!({"stream": true, "stream_options": {"include_usage": true}});
        assert!(rejects_stream_options(
            &with_usage,
            r#"{"error":{"message":"Unrecognized request argument supplied: stream_options"}}"#
        ));
        assert!(rejects_stream_options(
            &with_usage,
            "400 Bad Request: include_usage is not supported"
        ));
        // 其他 4xx(鉴权、超长上下文)不能靠去掉字段重试掩盖
        assert!(!rejects_stream_options(
            &with_usage,
            r#"{"error":{"message":"context_length_exceeded"}}"#
        ));
        let plain = serde_json::json!({"stream": true});
        assert!(!rejects_stream_options(&plain, "stream_options rejected"));
    }
}
