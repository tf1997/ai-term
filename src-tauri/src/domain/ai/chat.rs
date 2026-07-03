use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::api::http::{Body, ClientBuilder, HttpRequestBuilder, ResponseType};

use crate::domain::connection::models::AiProviderConfig;

const MAX_CONTEXT_CHARS: usize = 12_000;
const TERMINAL_HEAD_CHARS: usize = 2_000;
const TERMINAL_TAIL_CHARS: usize = 8_000;
const MAX_HISTORY_COMMANDS: usize = 80;
const MAX_KEY_LINES: usize = 36;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    pub question: String,
    pub terminal_snapshot: String,
    pub command_history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResponse {
    pub answer: String,
    pub context_compressed: bool,
    pub context_chars: usize,
    pub history_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTitleRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    pub user_message: String,
    pub assistant_message: String,
    pub terminal_snapshot: String,
    pub command_history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTitleResponse {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContextBundle {
    terminal: String,
    history: Vec<String>,
    key_points: Vec<String>,
    compressed: bool,
    chars: usize,
}

pub async fn chat_with_provider(request: AiChatRequest) -> Result<AiChatResponse> {
    validate_chat_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = build_chat_payload(&request, &context, false);

    let response_text =
        send_openai_compatible_request(&endpoint, &request.api_key, payload).await?;
    let answer = extract_chat_answer(&response_text)?;

    Ok(AiChatResponse {
        answer,
        context_compressed: context.compressed,
        context_chars: context.chars,
        history_count: context.history.len(),
    })
}

pub async fn chat_with_provider_stream<F>(
    request: AiChatRequest,
    on_delta: F,
) -> Result<AiChatResponse>
where
    F: FnMut(String) + Send,
{
    validate_chat_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = build_chat_payload(&request, &context, true);

    let answer =
        send_openai_compatible_stream_request(&endpoint, &request.api_key, payload, on_delta)
            .await?;

    Ok(AiChatResponse {
        answer,
        context_compressed: context.compressed,
        context_chars: context.chars,
        history_count: context.history.len(),
    })
}

pub async fn generate_session_title(
    request: AiSessionTitleRequest,
) -> Result<AiSessionTitleResponse> {
    validate_title_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": "你是 AI Term 的会话命名助手。根据用户问题、AI 回复和终端上下文，为当前终端助手会话生成一个简短标题。只输出标题本身，不要解释，不要加引号，不要 Markdown。中文不超过 12 个字；英文不超过 6 个词。"
            },
            {
                "role": "user",
                "content": build_title_prompt(&request, &context)
            }
        ],
        "temperature": 0.1,
        "stream": false
    });

    let response_text =
        send_openai_compatible_request(&endpoint, &request.api_key, payload).await?;
    let answer = extract_chat_answer(&response_text)?;
    let title = sanitize_session_title(&answer)
        .or_else(|| sanitize_session_title(&request.user_message))
        .unwrap_or_else(|| "Untitled".to_string());

    Ok(AiSessionTitleResponse { title })
}

fn build_chat_payload(request: &AiChatRequest, context: &ContextBundle, stream: bool) -> Value {
    json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": build_system_prompt(&request.config.system_prompt)
            },
            {
                "role": "user",
                "content": build_user_context_prompt(&request.question, &context)
            }
        ],
        "temperature": 0.2,
        "stream": stream
    })
}

fn validate_chat_request(request: &AiChatRequest) -> Result<()> {
    if request.config.base_url.trim().is_empty() {
        bail!("请先配置 AI Base URL");
    }
    if request.config.model.trim().is_empty() {
        bail!("请先配置 AI Model");
    }
    if request.api_key.trim().is_empty() {
        bail!("请在 AI 配置中填写 API Key 并保存");
    }
    if request.question.trim().is_empty() {
        bail!("问题不能为空");
    }
    Ok(())
}

fn validate_title_request(request: &AiSessionTitleRequest) -> Result<()> {
    if request.config.base_url.trim().is_empty() {
        bail!("请先配置 AI Base URL");
    }
    if request.config.model.trim().is_empty() {
        bail!("请先配置 AI Model");
    }
    if request.api_key.trim().is_empty() {
        bail!("请在 AI 配置中填写 API Key 并保存");
    }
    if request.user_message.trim().is_empty() {
        bail!("会话标题生成缺少用户消息");
    }
    Ok(())
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn build_context_bundle(terminal_snapshot: &str, command_history: &[String]) -> ContextBundle {
    let history = compress_history(command_history);
    let key_points = extract_key_context(terminal_snapshot, &history);
    let history_chars = history
        .iter()
        .map(|item| item.chars().count())
        .sum::<usize>();
    let terminal_chars = terminal_snapshot.chars().count();
    let total_chars = terminal_chars + history_chars;

    if total_chars <= MAX_CONTEXT_CHARS {
        return ContextBundle {
            terminal: terminal_snapshot.to_string(),
            history,
            key_points,
            compressed: false,
            chars: total_chars,
        };
    }

    let terminal = compress_terminal_snapshot(terminal_snapshot);
    let chars = terminal.chars().count() + history_chars;
    ContextBundle {
        terminal,
        history,
        key_points,
        compressed: true,
        chars,
    }
}

fn build_system_prompt(custom_prompt: &str) -> String {
    [
        custom_prompt.trim(),
        "你是 AI Term 的 SSH 终端助手，目标是帮助用户理解当前终端状态并生成可以直接执行的命令。",
        "必须优先依据【关键上下文摘要】、【当前终端内容】和【历史命令】回答；不要臆造不存在的服务器状态。",
        "当用户需要操作命令时，把可执行命令放在单独的 fenced code block 中，并使用 bash 或 shell 作为语言，例如 ```bash。",
        "代码块里只放命令，不要把解释文字、提示符、Markdown 列表符号混入命令。",
        "危险操作先解释风险，再给出更安全的只读检查命令；只有用户明确要求执行破坏性操作时才给危险命令。",
        "回答要短、可执行、面向终端排障；如果上下文不足，先给出用于确认环境的命令。",
    ]
    .iter()
    .map(|item| item.trim())
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn compress_terminal_snapshot(snapshot: &str) -> String {
    let chars = snapshot.chars().collect::<Vec<_>>();
    if chars.len() <= TERMINAL_HEAD_CHARS + TERMINAL_TAIL_CHARS {
        return snapshot.to_string();
    }

    let head = chars.iter().take(TERMINAL_HEAD_CHARS).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len().saturating_sub(TERMINAL_TAIL_CHARS))
        .collect::<String>();
    let omitted = chars
        .len()
        .saturating_sub(TERMINAL_HEAD_CHARS + TERMINAL_TAIL_CHARS);

    format!(
        "{head}\n\n[AI Term 已压缩终端上下文：中间省略 {omitted} 个字符，保留开头和最近输出。]\n\n{tail}"
    )
}

fn compress_history(command_history: &[String]) -> Vec<String> {
    command_history
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .rev()
        .take(MAX_HISTORY_COMMANDS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(ToOwned::to_owned)
        .collect()
}

fn extract_key_context(terminal_snapshot: &str, history: &[String]) -> Vec<String> {
    let mut points = Vec::new();
    let keywords = [
        "error",
        "failed",
        "failure",
        "fatal",
        "warn",
        "warning",
        "denied",
        "permission",
        "not found",
        "no such",
        "exception",
        "traceback",
        "panic",
        "timeout",
        "refused",
        "unreachable",
        "listening",
        "address already in use",
        "disk",
        "usage",
        "oom",
        "killed",
        "sudo",
        "ssh",
    ];

    for line in terminal_snapshot.lines() {
        let normalized = line.trim();
        if normalized.is_empty() || normalized.len() > 500 {
            continue;
        }
        let lower = normalized.to_lowercase();
        if keywords.iter().any(|keyword| lower.contains(keyword)) {
            push_unique_limited(&mut points, format!("terminal: {normalized}"));
        }
    }

    for line in terminal_snapshot
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !looks_like_shell_prompt(line))
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        push_unique_limited(&mut points, format!("recent-output: {line}"));
    }

    for command in history
        .iter()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        push_unique_limited(&mut points, format!("history: {command}"));
    }

    points
}

fn looks_like_shell_prompt(line: &str) -> bool {
    line.ends_with('$')
        || line.ends_with('#')
        || line.ends_with('%')
        || line.contains(" $ ")
        || line.contains(" # ")
        || line.contains(" % ")
}

fn push_unique_limited(points: &mut Vec<String>, value: String) {
    if points.len() >= MAX_KEY_LINES || points.iter().any(|item| item == &value) {
        return;
    }
    points.push(value);
}

fn build_user_context_prompt(question: &str, context: &ContextBundle) -> String {
    [
        format!("用户问题：{}", question.trim()),
        format!(
            "上下文状态：{}",
            if context.compressed {
                "终端内容过长，已压缩，保留开头和最近输出"
            } else {
                "完整上下文"
            }
        ),
        format!(
            "当前终端内容：\n{}",
            if context.terminal.trim().is_empty() {
                "-"
            } else {
                context.terminal.as_str()
            }
        ),
        format!(
            "关键上下文摘要：\n{}",
            if context.key_points.is_empty() {
                "-".to_string()
            } else {
                context.key_points.join("\n")
            }
        ),
        format!(
            "历史命令：\n{}",
            if context.history.is_empty() {
                "-".to_string()
            } else {
                context.history.join("\n")
            }
        ),
    ]
    .join("\n\n")
}

fn build_title_prompt(request: &AiSessionTitleRequest, context: &ContextBundle) -> String {
    [
        format!("用户问题：{}", request.user_message.trim()),
        format!(
            "AI 回复：{}",
            truncate_for_prompt(request.assistant_message.trim(), 1200)
        ),
        format!(
            "关键上下文摘要：\n{}",
            if context.key_points.is_empty() {
                "-".to_string()
            } else {
                context.key_points.join("\n")
            }
        ),
    ]
    .join("\n\n")
}

fn truncate_for_prompt(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let head = chars.iter().take(max_chars).collect::<String>();
    format!("{head}...")
}

async fn send_openai_compatible_request(
    endpoint: &str,
    api_key: &str,
    payload: Value,
) -> Result<String> {
    let client = ClientBuilder::new()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .context("failed to build AI HTTP client")?;

    let request = HttpRequestBuilder::new("POST", endpoint)
        .with_context(|| format!("invalid AI Base URL: {endpoint}"))?
        .header("Content-Type", "application/json")?
        .header("Authorization", format!("Bearer {}", api_key.trim()))?
        .body(Body::Json(payload))
        .timeout(Duration::from_secs(90))
        .response_type(ResponseType::Text);

    let response = client
        .send(request)
        .await
        .with_context(|| format!("AI 网络请求失败：{endpoint}"))?;
    let status = response.status().as_u16();
    let data = response
        .read()
        .await
        .context("failed to read AI response")?;
    let raw = data.data.as_str().unwrap_or("").to_string();

    if !(200..300).contains(&status) {
        bail!("模型请求失败：HTTP {status}\n{}", parse_model_error(&raw));
    }
    reject_html_response(&raw, endpoint)?;

    Ok(raw)
}

async fn send_openai_compatible_stream_request<F>(
    endpoint: &str,
    api_key: &str,
    payload: Value,
    mut on_delta: F,
) -> Result<String>
where
    F: FnMut(String) + Send,
{
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(90))
        .build()
        .context("failed to build AI streaming HTTP client")?;

    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .bearer_auth(api_key.trim())
        .body(payload.to_string())
        .send()
        .await
        .with_context(|| format!("AI 流式网络请求失败：{endpoint}"))?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = response.text().await.unwrap_or_default();
        bail!("模型请求失败：HTTP {status}\n{}", parse_model_error(&raw));
    }

    let mut stream = response.bytes_stream();
    let mut raw = String::new();
    let mut event_buffer = String::new();
    let mut answer = String::new();
    let mut saw_sse_delta = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("failed to read AI stream chunk")?;
        let text = String::from_utf8_lossy(&chunk);
        raw.push_str(&text);
        event_buffer.push_str(&text);

        while let Some(index) = event_buffer.find("\n\n") {
            let event = event_buffer[..index].to_string();
            event_buffer = event_buffer[index + 2..].to_string();
            for delta in parse_sse_event_deltas(&event)? {
                saw_sse_delta = true;
                answer.push_str(&delta);
                on_delta(delta);
            }
        }
    }

    if !event_buffer.trim().is_empty() {
        for delta in parse_sse_event_deltas(&event_buffer)? {
            saw_sse_delta = true;
            answer.push_str(&delta);
            on_delta(delta);
        }
    }

    if saw_sse_delta {
        return Ok(answer);
    }

    reject_html_response(&raw, endpoint)?;
    let answer = extract_chat_answer(&raw)?;
    if !answer.is_empty() {
        on_delta(answer.clone());
    }
    Ok(answer)
}

fn parse_sse_event_deltas(event: &str) -> Result<Vec<String>> {
    let mut deltas = Vec::new();

    for line in event.lines().map(str::trim) {
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }

        let payload = serde_json::from_str::<Value>(data)
            .with_context(|| format!("模型流式返回不是合法 JSON：{data}"))?;
        if let Some(error) = payload.pointer("/error/message").and_then(Value::as_str) {
            bail!("模型流式返回错误：{error}");
        }
        if let Some(delta) = extract_stream_delta(&payload) {
            deltas.push(delta);
        }
    }

    Ok(deltas)
}

fn extract_stream_delta(payload: &Value) -> Option<String> {
    for pointer in [
        "/choices/0/delta/content",
        "/choices/0/text",
        "/delta/content",
        "/message/content",
        "/content",
        "/response",
        "/answer",
    ] {
        if let Some(content) = payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(content.to_string());
        }
    }

    None
}

fn extract_chat_answer(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("模型返回为空");
    }
    reject_html_response(trimmed, "AI endpoint")?;

    let Ok(payload) = serde_json::from_str::<Value>(trimmed) else {
        return Ok(trimmed.to_string());
    };

    for pointer in [
        "/choices/0/message/content",
        "/choices/0/text",
        "/message/content",
        "/content",
        "/text",
        "/response",
        "/answer",
    ] {
        if let Some(content) = payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(content.to_string());
        }
    }

    Ok(serde_json::to_string_pretty(&payload).unwrap_or_else(|_| trimmed.to_string()))
}

fn parse_model_error(raw: &str) -> String {
    if raw.trim().is_empty() {
        return "模型未返回错误正文".into();
    }

    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return raw.trim().to_string();
    };

    if let Some(message) = payload.pointer("/error/message").and_then(Value::as_str) {
        let mut parts = vec![message.to_string()];
        if let Some(kind) = payload.pointer("/error/type").and_then(Value::as_str) {
            parts.push(format!("type: {kind}"));
        }
        if let Some(code) = payload.pointer("/error/code").and_then(Value::as_str) {
            parts.push(format!("code: {code}"));
        }
        return parts.join("\n");
    }

    for key in ["message", "detail", "error_description"] {
        if let Some(value) = payload.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }

    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| raw.trim().to_string())
}

fn reject_html_response(raw: &str, endpoint: &str) -> Result<()> {
    let trimmed = raw.trim_start();
    let lower = trimmed.chars().take(512).collect::<String>().to_lowercase();
    let looks_like_html = lower.starts_with("<!doctype html")
        || lower.starts_with("<html")
        || lower.contains("<head")
        || lower.contains("<body")
        || lower.contains("<script");

    if looks_like_html {
        let title = extract_html_title(raw)
            .map(|value| format!("，页面标题：{value}"))
            .unwrap_or_default();
        bail!(
            "AI 接口返回了 HTML 页面{title}，这通常表示 Base URL 填成了网页入口、网关登录页或接口路径不正确。\n当前请求地址：{endpoint}\n请把 Base URL 配置为 OpenAI 兼容 API 根路径，例如 https://你的网关域名/v1；如果配置项已经包含 /chat/completions，本客户端会直接使用它。"
        );
    }

    Ok(())
}

fn extract_html_title(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = lower[start..].find("</title>")? + start;
    let title = raw.get(start..end)?.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn sanitize_session_title(raw: &str) -> Option<String> {
    let mut value = raw
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();

    for prefix in ["标题：", "标题:", "会话：", "会话:", "Title:", "title:"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped.trim().to_string();
        }
    }

    value = value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();

    if value.is_empty() {
        return None;
    }

    let mut compact = value.chars().take(28).collect::<String>();
    compact = compact
        .trim_matches(['。', '.', '，', ',', '；', ';', '：', ':'])
        .trim()
        .to_string();

    if compact.is_empty() {
        None
    } else {
        Some(compact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compresses_long_terminal_context() {
        let snapshot = "x".repeat(20_000);
        let context = build_context_bundle(&snapshot, &["df -h".into()]);

        assert!(context.compressed);
        assert!(context.terminal.contains("已压缩终端上下文"));
        assert!(context.terminal.len() < snapshot.len());
        assert_eq!(context.history, vec!["df -h"]);
    }

    #[test]
    fn keeps_recent_history_commands() {
        let commands = (0..100)
            .map(|index| format!("cmd-{index}"))
            .collect::<Vec<_>>();
        let context = build_context_bundle("", &commands);

        assert_eq!(context.history.len(), MAX_HISTORY_COMMANDS);
        assert_eq!(context.history.first().map(String::as_str), Some("cmd-20"));
        assert_eq!(context.history.last().map(String::as_str), Some("cmd-99"));
    }

    #[test]
    fn extracts_key_context_from_terminal_and_history() {
        let snapshot = [
            "normal output",
            "Permission denied while reading /var/log/app.log",
            "service failed to start",
            "last useful line",
        ]
        .join("\n");
        let context = build_context_bundle(&snapshot, &["systemctl status app".into()]);

        assert!(context
            .key_points
            .iter()
            .any(|line| line.contains("Permission denied")));
        assert!(context
            .key_points
            .iter()
            .any(|line| line.contains("service failed")));
        assert!(context
            .key_points
            .iter()
            .any(|line| line.contains("history: systemctl status app")));
    }

    #[test]
    fn parses_openai_error_payload() {
        let raw = r#"{"error":{"message":"bad key","type":"auth","code":"invalid_api_key"}}"#;
        assert_eq!(
            parse_model_error(raw),
            "bad key\ntype: auth\ncode: invalid_api_key"
        );
    }

    #[test]
    fn accepts_plain_text_model_answer() {
        let raw = "可以执行：\n```bash\ndf -h\n```";
        assert_eq!(extract_chat_answer(raw).unwrap(), raw);
    }

    #[test]
    fn accepts_openai_compatible_json_answer() {
        let raw = r#"{"choices":[{"message":{"content":"```bash\nfree -h\n```"}}]}"#;
        assert_eq!(extract_chat_answer(raw).unwrap(), "```bash\nfree -h\n```");
    }

    #[test]
    fn accepts_common_text_json_answer() {
        let raw = r#"{"response":"```bash\nuptime\n```"}"#;
        assert_eq!(extract_chat_answer(raw).unwrap(), "```bash\nuptime\n```");
    }

    #[test]
    fn parses_openai_stream_deltas() {
        let event = [
            r#"data: {"choices":[{"delta":{"content":"hello"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":" world"}}]}"#,
            "data: [DONE]",
        ]
        .join("\n\n");

        assert_eq!(
            parse_sse_event_deltas(&event).unwrap(),
            vec!["hello".to_string(), " world".to_string()]
        );
    }

    #[test]
    fn sanitizes_model_session_title() {
        assert_eq!(
            sanitize_session_title("标题：\"查看 CPU 使用率。\"").as_deref(),
            Some("查看 CPU 使用率")
        );
        assert_eq!(
            sanitize_session_title("```内存压力排查```").as_deref(),
            Some("内存压力排查")
        );
        assert!(sanitize_session_title("   ").is_none());
    }

    #[test]
    fn rejects_gateway_html_as_model_answer() {
        let raw = r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <title>Sub2API - AI API Gateway</title>
  </head>
  <body><div id="app"></div></body>
</html>"#;

        let error = extract_chat_answer(raw).unwrap_err().to_string();

        assert!(error.contains("AI 接口返回了 HTML 页面"));
        assert!(error.contains("Sub2API - AI API Gateway"));
        assert!(error.contains("https://你的网关域名/v1"));
    }

    #[test]
    fn keeps_full_chat_completions_endpoint_when_configured() {
        assert_eq!(
            chat_completions_endpoint("https://gateway.example/v1/chat/completions"),
            "https://gateway.example/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://gateway.example/v1/"),
            "https://gateway.example/v1/chat/completions"
        );
    }
}
