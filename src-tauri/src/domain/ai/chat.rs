use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::ai::stream::{
    is_stream_done, open_stream, sse_data_payloads, wait_for_stream, SseEventBuffer, StreamStart,
};
use crate::domain::ai::usage::{merge_usage, usage_from_json, AiTokenUsage};
use crate::domain::connection::models::AiProviderConfig;
use crate::domain::text::{strip_terminal_control_sequences, Utf8StreamDecoder};

const MAX_CONTEXT_CHARS: usize = 12_000;
const TERMINAL_HEAD_CHARS: usize = 2_000;
const TERMINAL_TAIL_CHARS: usize = 8_000;
const MAX_HISTORY_COMMANDS: usize = 80;
const MAX_HISTORY_CHARS: usize = 2_000;
const MAX_KEY_CONTEXT_CHARS: usize = 1_500;
const MAX_CONVERSATION_MESSAGES: usize = 16;
const MAX_CONVERSATION_CHARS: usize = 8_000;
const MAX_CONVERSATION_MESSAGE_CHARS: usize = 3_000;
pub(crate) const MAX_CONVERSATION_SUMMARY_CHARS: usize = 2_000;
const MAX_COMPACT_SOURCE_MESSAGE_CHARS: usize = 1_500;
const MAX_COMPACT_SOURCE_TOTAL_CHARS: usize = 12_000;
const MAX_KEY_LINES: usize = 36;
pub(crate) const AI_TERM_CLIENT_NAME: &str = "ai-term";
pub(crate) const AI_TERM_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const AI_TERM_USER_AGENT: &str = concat!("ai-term/", env!("CARGO_PKG_VERSION"));

pub type AiCancelToken = Arc<AtomicBool>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    pub question: String,
    pub terminal_snapshot: String,
    pub command_history: Vec<String>,
    #[serde(default)]
    pub conversation_messages: Vec<AiConversationTurn>,
    /// Compressed summary of conversation turns older than
    /// `conversation_messages`, produced by `compress_conversation_context`.
    #[serde(default)]
    pub conversation_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationTurn {
    pub role: AiConversationRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiConversationRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResponse {
    pub answer: String,
    pub context_compressed: bool,
    pub context_chars: usize,
    pub history_count: usize,
    /// 网关上报的 token 用量;网关不返回 usage 时为 None,不做估算。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AiTokenUsage>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiScriptTitleRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    pub user_request: String,
    pub script_content: String,
    pub source_commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiScriptTitleResponse {
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationCompactRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    #[serde(default)]
    pub previous_summary: Option<String>,
    pub messages: Vec<AiConversationTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationCompactResponse {
    pub summary: String,
    pub source_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContextBundle {
    pub(crate) terminal: String,
    pub(crate) history: Vec<String>,
    pub(crate) key_points: Vec<String>,
    pub(crate) compressed: bool,
    pub(crate) chars: usize,
}

pub async fn chat_with_provider(request: AiChatRequest) -> Result<AiChatResponse> {
    validate_chat_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let conversation = conversation_messages_for_payload(&request.conversation_messages);
    let summary_chars = conversation_summary_chars(&request);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = build_chat_payload(&request, &context, &conversation, false);

    let response_text = send_openai_compatible_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
    )
    .await?;
    let answer = extract_chat_answer(&response_text)?;
    let usage = usage_from_json(&response_text);

    Ok(AiChatResponse {
        answer,
        context_compressed: context.compressed
            || summary_chars > 0
            || conversation_context_was_compressed(&request.conversation_messages, &conversation),
        context_chars: context.chars + conversation_context_chars(&conversation) + summary_chars,
        history_count: context.history.len(),
        usage,
    })
}

pub async fn chat_with_provider_stream<F>(
    request: AiChatRequest,
    on_delta: F,
    cancel_token: Option<&AiCancelToken>,
) -> Result<AiChatResponse>
where
    F: FnMut(String) + Send,
{
    validate_chat_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let conversation = conversation_messages_for_payload(&request.conversation_messages);
    let summary_chars = conversation_summary_chars(&request);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = build_chat_payload(&request, &context, &conversation, true);

    let (answer, usage) = send_openai_compatible_stream_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
        on_delta,
        cancel_token,
    )
    .await?;

    Ok(AiChatResponse {
        answer,
        context_compressed: context.compressed
            || summary_chars > 0
            || conversation_context_was_compressed(&request.conversation_messages, &conversation),
        context_chars: context.chars + conversation_context_chars(&conversation) + summary_chars,
        history_count: context.history.len(),
        usage,
    })
}

pub async fn generate_session_title(
    request: AiSessionTitleRequest,
) -> Result<AiSessionTitleResponse> {
    validate_title_request(&request)?;
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": "你是 AI Term 的会话命名助手。根据用户问题和 AI 回复，为当前终端助手会话生成一个简短标题。只输出标题本身，不要解释，不要加引号，不要 Markdown。中文不超过 12 个字；英文不超过 6 个词。"
            },
            {
                "role": "user",
                "content": build_title_prompt(&request)
            }
        ],
        "temperature": 0.1,
        "stream": false
    });

    let response_text = send_openai_compatible_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
    )
    .await?;
    let answer = extract_chat_answer(&response_text)?;
    let title = sanitize_session_title(&answer)
        .or_else(|| sanitize_session_title(&request.user_message))
        .unwrap_or_else(|| "Untitled".to_string());

    Ok(AiSessionTitleResponse { title })
}

pub async fn generate_script_title(request: AiScriptTitleRequest) -> Result<AiScriptTitleResponse> {
    validate_script_title_request(&request)?;
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": "你是 AI Term 的脚本命名助手。根据用户目标、bash 脚本和来源命令，为服务器更新脚本生成一个短名称。只输出名称本身，不要解释，不要加引号，不要 Markdown。中文不超过 14 个字；英文不超过 7 个词。名称应体现服务名、环境或更新动作。"
            },
            {
                "role": "user",
                "content": build_script_title_prompt(&request)
            }
        ],
        "temperature": 0.1,
        "stream": false
    });

    let response_text = send_openai_compatible_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
    )
    .await?;
    let answer = extract_chat_answer(&response_text)?;
    let title = sanitize_session_title(&answer)
        .or_else(|| sanitize_session_title(&request.user_request))
        .unwrap_or_else(|| "服务更新脚本".to_string());

    Ok(AiScriptTitleResponse { title })
}

/// Compresses older conversation turns (plus an optional previous summary)
/// into a compact context summary so long sessions keep bounded prompts
/// without losing earlier decisions and results.
pub async fn compress_conversation_context(
    request: AiConversationCompactRequest,
) -> Result<AiConversationCompactResponse> {
    validate_compact_request(&request)?;
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": "你是 AI Term 的会话压缩助手。把提供的历史对话（可能包含一份旧摘要）压缩成一份精炼的上下文摘要，供后续对话作为背景。必须保留：用户目标、关键结论、执行过的重要命令及其结果、涉及的主机/路径/服务名、尚未解决的问题。省略寒暄、重复内容和无效尝试的细节。直接输出摘要正文，不要解释，不要 Markdown 标题。中文为主，不超过 600 字。"
            },
            {
                "role": "user",
                "content": build_compact_prompt(&request)
            }
        ],
        "temperature": 0.1,
        "stream": false
    });

    let response_text = send_openai_compatible_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
    )
    .await?;
    let answer = extract_chat_answer(&response_text)?;
    let summary = truncate_for_prompt(answer.trim(), MAX_CONVERSATION_SUMMARY_CHARS);
    if summary.trim().is_empty() {
        bail!("AI 未返回会话摘要");
    }

    Ok(AiConversationCompactResponse {
        summary,
        source_count: request.messages.len(),
    })
}

fn validate_compact_request(request: &AiConversationCompactRequest) -> Result<()> {
    if request.config.base_url.trim().is_empty() {
        bail!("请先配置 AI Base URL");
    }
    if request.config.model.trim().is_empty() {
        bail!("请先配置 AI Model");
    }
    if request.api_key.trim().is_empty() {
        bail!("请在 AI 配置中填写 API Key 并保存");
    }
    if request
        .messages
        .iter()
        .all(|message| message.content.trim().is_empty())
    {
        bail!("会话压缩缺少历史消息");
    }
    Ok(())
}

fn build_compact_prompt(request: &AiConversationCompactRequest) -> String {
    let mut sections = Vec::new();
    if let Some(previous) = request
        .previous_summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
        sections.push(format!(
            "【旧摘要】（请把其中仍然有效的信息合并进新摘要）\n{}",
            truncate_for_prompt(previous, MAX_CONVERSATION_SUMMARY_CHARS)
        ));
    }

    // Bound the request body: cap each turn, then drop oldest turns until the
    // total fits so a very long backlog cannot blow up the compaction call.
    let mut turns = request
        .messages
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .map(|message| {
            let role = match message.role {
                AiConversationRole::User => "用户",
                AiConversationRole::Assistant => "AI",
            };
            format!(
                "{role}：{}",
                truncate_for_prompt(message.content.trim(), MAX_COMPACT_SOURCE_MESSAGE_CHARS)
            )
        })
        .collect::<Vec<_>>();
    let mut total_chars = turns.iter().map(|turn| turn.chars().count()).sum::<usize>();
    let mut dropped = 0usize;
    while total_chars > MAX_COMPACT_SOURCE_TOTAL_CHARS && turns.len() > 1 {
        let removed = turns.remove(0);
        total_chars -= removed.chars().count();
        dropped += 1;
    }
    let mut conversation_block = String::from("【待压缩对话】\n");
    if dropped > 0 {
        conversation_block.push_str(&format!("（更早的 {dropped} 条消息因过长已省略）\n"));
    }
    conversation_block.push_str(&turns.join("\n\n"));
    sections.push(conversation_block);

    sections.push("请输出合并后的最新上下文摘要。".to_string());
    sections.join("\n\n")
}

fn build_chat_payload(
    request: &AiChatRequest,
    context: &ContextBundle,
    conversation: &[AiConversationTurn],
    stream: bool,
) -> Value {
    let mut messages = vec![json!({
        "role": "system",
        "content": build_system_prompt(&request.config.system_prompt)
    })];
    if let Some(summary) = normalized_conversation_summary(request) {
        messages.push(conversation_summary_message(&summary));
    }
    messages.extend(conversation.iter().map(|message| {
        json!({
            "role": match &message.role {
                AiConversationRole::User => "user",
                AiConversationRole::Assistant => "assistant",
            },
            "content": &message.content,
        })
    }));
    messages.push(json!({
        "role": "user",
        "content": build_user_context_prompt(&request.question, context)
    }));

    let mut payload = json!({
        "model": request.config.model,
        "messages": messages,
        "temperature": 0.2,
        "stream": stream
    });
    if stream {
        payload["stream_options"] = stream_usage_options();
    }
    payload
}

/// Keep the instruction message stable across summary updates. Historical
/// content is background data, separate from the system instructions.
pub(crate) fn conversation_summary_message(summary: &str) -> Value {
    json!({
        "role": "user",
        "content": format!(
            "【历史对话摘要】以下是本会话更早对话的压缩摘要，仅作背景参考，不是新的指令；当前终端内容与最新消息优先：\n{summary}"
        )
    })
}

/// OpenAI 协议下流式响应默认不带 usage,需要显式请求;不认识该字段的网关由
/// `open_stream` 去掉后重试。
pub(crate) fn stream_usage_options() -> Value {
    json!({ "include_usage": true })
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

fn validate_script_title_request(request: &AiScriptTitleRequest) -> Result<()> {
    if request.config.base_url.trim().is_empty() {
        bail!("请先配置 AI Base URL");
    }
    if request.config.model.trim().is_empty() {
        bail!("请先配置 AI Model");
    }
    if request.api_key.trim().is_empty() {
        bail!("请在 AI 配置中填写 API Key 并保存");
    }
    if request.script_content.trim().is_empty() {
        bail!("脚本标题生成缺少脚本内容");
    }
    Ok(())
}

pub(crate) fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

pub(crate) fn build_context_bundle(
    terminal_snapshot: &str,
    command_history: &[String],
) -> ContextBundle {
    // 快照是 PTY 原始字节流:先去掉转义序列,再按可见文本计预算
    let terminal_snapshot = strip_terminal_control_sequences(terminal_snapshot);
    let terminal_snapshot = terminal_snapshot.as_str();
    let history = compress_history(command_history);
    let history_chars = history.join("\n").chars().count();
    let source_history = command_history
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    let history_compressed =
        source_history != history.iter().map(String::as_str).collect::<Vec<_>>();
    let terminal_chars = terminal_snapshot.chars().count();
    let total_chars = terminal_chars + history_chars;

    if total_chars <= MAX_CONTEXT_CHARS {
        return ContextBundle {
            terminal: terminal_snapshot.to_string(),
            history,
            // 完整终端和历史已包含这些行,不再复制进摘要。
            key_points: Vec::new(),
            compressed: history_compressed,
            chars: total_chars,
        };
    }

    // 为被省略区域的关键证据预留空间;摘要和历史也必须计入预算。
    let terminal = compress_terminal_snapshot(
        terminal_snapshot,
        MAX_CONTEXT_CHARS - history_chars - MAX_KEY_CONTEXT_CHARS,
    );
    let key_points = extract_key_context(terminal_snapshot, &terminal);
    let chars = terminal.chars().count() + history_chars + key_points.join("\n").chars().count();
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
        "历史会话可能来自其他连接。始终以最新用户消息中的当前终端内容和命令历史为准，不要假定早期命令仍然指向同一主机。",
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

fn compress_terminal_snapshot(snapshot: &str, max_chars: usize) -> String {
    let chars = snapshot.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return snapshot.to_string();
    }

    let note = "\n\n[AI Term 已压缩终端上下文：中间内容已省略，保留开头和最近输出。]\n\n";
    let available = max_chars.saturating_sub(note.chars().count());
    let head_chars = TERMINAL_HEAD_CHARS.min(available / 3);
    let tail_chars = TERMINAL_TAIL_CHARS.min(available - head_chars);
    let head = chars.iter().take(head_chars).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len() - tail_chars)
        .collect::<String>();
    format!("{head}{note}{tail}")
}

fn compress_history(command_history: &[String]) -> Vec<String> {
    let mut selected = Vec::new();
    let mut remaining = MAX_HISTORY_CHARS;
    for command in command_history
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .rev()
        .take(MAX_HISTORY_COMMANDS)
    {
        let separator = usize::from(!selected.is_empty());
        let count = command.chars().count();
        if count + separator > remaining {
            // 超长的最新命令仍保留一个明确标注的片段,旧命令不截成可执行命令。
            if selected.is_empty() {
                let note = " [历史命令已截断，不可直接执行]";
                let prefix: String = command
                    .chars()
                    .take(remaining - note.chars().count())
                    .collect();
                selected.push(format!("{prefix}{note}"));
            }
            break;
        }
        selected.push(command.to_string());
        remaining -= count + separator;
    }
    selected.reverse();
    selected
}

pub(crate) fn conversation_messages_for_payload(
    messages: &[AiConversationTurn],
) -> Vec<AiConversationTurn> {
    let mut remaining_chars = MAX_CONVERSATION_CHARS;
    let mut selected = Vec::new();

    for message in messages.iter().rev().take(MAX_CONVERSATION_MESSAGES) {
        let content = message.content.trim();
        if content.is_empty() || remaining_chars == 0 {
            continue;
        }
        let content_chars = content.chars().count();
        let kept_chars = content_chars
            .min(MAX_CONVERSATION_MESSAGE_CHARS)
            .min(remaining_chars);
        selected.push(AiConversationTurn {
            role: message.role.clone(),
            content: content.chars().take(kept_chars).collect(),
        });
        remaining_chars = remaining_chars.saturating_sub(kept_chars);
    }

    selected.reverse();
    while selected
        .first()
        .is_some_and(|message| matches!(message.role, AiConversationRole::Assistant))
    {
        selected.remove(0);
    }
    selected
}

pub(crate) fn conversation_context_chars(messages: &[AiConversationTurn]) -> usize {
    messages
        .iter()
        .map(|message| message.content.chars().count())
        .sum()
}

pub(crate) fn conversation_context_was_compressed(
    source: &[AiConversationTurn],
    selected: &[AiConversationTurn],
) -> bool {
    let source_messages = source
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .collect::<Vec<_>>();
    source_messages.len() != selected.len()
        || source_messages
            .iter()
            .map(|message| message.content.trim().chars().count())
            .sum::<usize>()
            != conversation_context_chars(selected)
}

fn normalized_conversation_summary(request: &AiChatRequest) -> Option<String> {
    let summary = request.conversation_summary.as_deref()?.trim();
    if summary.is_empty() {
        return None;
    }
    Some(truncate_for_prompt(summary, MAX_CONVERSATION_SUMMARY_CHARS))
}

fn conversation_summary_chars(request: &AiChatRequest) -> usize {
    normalized_conversation_summary(request)
        .map(|summary| summary.chars().count())
        .unwrap_or(0)
}

fn extract_key_context(terminal_snapshot: &str, retained_terminal: &str) -> Vec<String> {
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

    // 仅补充压缩终端中不再可见的关键行,优先保留较新的证据。
    for line in terminal_snapshot.lines().rev() {
        let normalized = line.trim();
        if normalized.is_empty()
            || normalized.chars().count() > 500
            || retained_terminal.contains(normalized)
        {
            continue;
        }
        let lower = normalized.to_lowercase();
        if keywords.iter().any(|keyword| lower.contains(keyword)) {
            push_unique_limited(&mut points, format!("terminal: {normalized}"));
        }
    }
    points.reverse();
    points
}

fn push_unique_limited(points: &mut Vec<String>, value: String) {
    let used = points.join("\n").chars().count();
    let separator = usize::from(!points.is_empty());
    if points.len() >= MAX_KEY_LINES
        || points.iter().any(|item| item == &value)
        || used + separator + value.chars().count() > MAX_KEY_CONTEXT_CHARS
    {
        return;
    }
    points.push(value);
}

pub(crate) fn build_user_context_prompt(question: &str, context: &ContextBundle) -> String {
    [
        format!("用户问题：{}", question.trim()),
        format!(
            "上下文状态：{}",
            if context.compressed {
                "终端内容或命令历史已压缩；省略处有标注，历史仅保留最近记录"
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

fn build_title_prompt(request: &AiSessionTitleRequest) -> String {
    // 命名只需问题和结论,不再为短标题重发终端日志和命令历史。
    [
        format!(
            "用户问题：{}",
            truncate_for_prompt(request.user_message.trim(), 600)
        ),
        format!(
            "AI 回复：{}",
            truncate_for_prompt(request.assistant_message.trim(), 900)
        ),
    ]
    .join("\n\n")
}

fn build_script_title_prompt(request: &AiScriptTitleRequest) -> String {
    [
        format!("用户目标：{}", request.user_request.trim()),
        format!(
            "来源命令：\n{}",
            if request.source_commands.is_empty() {
                "-".to_string()
            } else {
                request.source_commands.join("\n")
            }
        ),
        format!(
            "脚本内容：\n{}",
            truncate_for_prompt(request.script_content.trim(), 1800)
        ),
    ]
    .join("\n\n")
}

pub(crate) fn truncate_for_prompt(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let head = chars.iter().take(max_chars).collect::<String>();
    format!("{head}...")
}

/// Shared HTTP client reused across all AI requests.
///
/// Building a client per request re-initializes TLS and discards the connection
/// pool every call. A single lazily-built client keeps connections warm.
/// Non-streaming requests use a total deadline; streams time out only when idle.
pub(crate) fn ai_http_client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent(AI_TERM_USER_AGENT)
        .build()
        .context("failed to build AI HTTP client")?;
    Ok(CLIENT.get_or_init(|| client))
}

async fn send_openai_compatible_request(
    endpoint: &str,
    api_key: &str,
    payload: Value,
    timeout_seconds: u32,
) -> Result<String> {
    let mut request = ai_http_client()?
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("X-Client-Name", AI_TERM_CLIENT_NAME)
        .header("X-Client-Version", AI_TERM_CLIENT_VERSION)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .body(payload.to_string());
    if timeout_seconds > 0 {
        request = request.timeout(Duration::from_secs(u64::from(timeout_seconds)));
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("AI 网络请求失败：{endpoint}"))?;
    let status = response.status().as_u16();
    let raw = response
        .text()
        .await
        .context("failed to read AI response")?;

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
    timeout_seconds: u32,
    mut on_delta: F,
    cancel_token: Option<&AiCancelToken>,
) -> Result<(String, Option<AiTokenUsage>)>
where
    F: FnMut(String) + Send,
{
    let response =
        match open_stream(endpoint, api_key, payload, timeout_seconds, cancel_token).await? {
            StreamStart::Cancelled => return Ok((String::new(), None)),
            StreamStart::Rejected { status, body } => {
                bail!("模型请求失败：HTTP {status}\n{}", parse_model_error(&body))
            }
            StreamStart::Open(response) => response,
        };

    let mut stream = response.bytes_stream();
    let mut decoder = Utf8StreamDecoder::default();
    let mut raw = String::new();
    let mut event_buffer = SseEventBuffer::default();
    let mut answer = String::new();
    let mut usage = None;
    let mut saw_sse_delta = false;

    while let Some(chunk) = wait_for_stream(stream.next(), timeout_seconds, cancel_token)
        .await?
        .flatten()
    {
        if is_cancelled(cancel_token) {
            return Ok((answer, usage));
        }
        let chunk = chunk.context("AI 流式响应读取中断：网络连接或模型服务提前关闭了响应")?;
        let text = decoder.push(&chunk);
        if text.is_empty() {
            continue;
        }
        // `raw` is only consulted as a fallback when the stream carries no SSE
        // deltas, so stop growing a full copy of the response once we have one.
        if !saw_sse_delta {
            raw.push_str(&text);
        }
        event_buffer.push(&text);

        while let Some(event) = event_buffer.next_event() {
            for delta in parse_sse_event_deltas(&event, &mut usage)? {
                if is_cancelled(cancel_token) {
                    return Ok((answer, usage));
                }
                saw_sse_delta = true;
                answer.push_str(&delta);
                on_delta(delta);
            }
            if is_stream_done(&event) {
                if !saw_sse_delta {
                    bail!("模型返回为空");
                }
                return Ok((answer, usage));
            }
        }
    }

    if is_cancelled(cancel_token) {
        return Ok((answer, usage));
    }

    if !event_buffer.remaining().trim().is_empty() {
        for delta in parse_sse_event_deltas(event_buffer.remaining(), &mut usage)? {
            if is_cancelled(cancel_token) {
                return Ok((answer, usage));
            }
            saw_sse_delta = true;
            answer.push_str(&delta);
            on_delta(delta);
        }
    }

    if saw_sse_delta {
        return Ok((answer, usage));
    }

    reject_html_response(&raw, endpoint)?;
    let answer = extract_chat_answer(&raw)?;
    if !answer.is_empty() {
        on_delta(answer.clone());
    }
    Ok((answer, usage_from_json(&raw)))
}

pub(crate) fn is_cancelled(cancel_token: Option<&AiCancelToken>) -> bool {
    cancel_token
        .map(|token| token.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 解析一个 SSE 事件的文本增量;usage 事件(通常是 [DONE] 前 choices 为空的
/// 一帧)合并进 `usage`,不产生增量。
fn parse_sse_event_deltas(event: &str, usage: &mut Option<AiTokenUsage>) -> Result<Vec<String>> {
    let mut deltas = Vec::new();

    for data in sse_data_payloads(event) {
        if data == "[DONE]" {
            break;
        }

        let payload = serde_json::from_str::<Value>(&data)
            .with_context(|| format!("模型流式返回不是合法 JSON：{data}"))?;
        if let Some(error) = payload.pointer("/error/message").and_then(Value::as_str) {
            bail!("模型流式返回错误：{error}");
        }
        if let Some(delta) = extract_stream_delta(&payload) {
            deltas.push(delta);
        }
        merge_usage(usage, &payload);
    }

    Ok(deltas)
}

pub(crate) fn extract_stream_delta(payload: &Value) -> Option<String> {
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

pub(crate) fn extract_chat_answer(raw: &str) -> Result<String> {
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

pub(crate) fn parse_model_error(raw: &str) -> String {
    if raw.trim().is_empty() {
        return "\u{6a21}\u{578b}\u{672a}\u{8fd4}\u{56de}\u{9519}\u{8bef}\u{6b63}\u{6587}".into();
    }

    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return append_client_restricted_hint(raw.trim().to_string());
    };

    if let Some(message) = payload.pointer("/error/message").and_then(Value::as_str) {
        let mut parts = vec![message.to_string()];
        if let Some(kind) = payload.pointer("/error/type").and_then(Value::as_str) {
            parts.push(format!("type: {kind}"));
        }
        if let Some(code) = payload.pointer("/error/code").and_then(Value::as_str) {
            parts.push(format!("code: {code}"));
        }
        return append_client_restricted_hint(parts.join("\n"));
    }

    for key in ["message", "detail", "error_description"] {
        if let Some(value) = payload.get(key).and_then(Value::as_str) {
            return append_client_restricted_hint(value.to_string());
        }
    }

    append_client_restricted_hint(
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| raw.trim().to_string()),
    )
}

fn append_client_restricted_hint(message: String) -> String {
    if !is_client_restricted_error(&message) {
        return message;
    }

    format!(
        "{message}\n{} User-Agent: {AI_TERM_USER_AGENT}; X-Client-Name: {AI_TERM_CLIENT_NAME}. {}",
        "\u{7f51}\u{5173}\u{62d2}\u{7edd}\u{4e86}\u{5f53}\u{524d}\u{5ba2}\u{6237}\u{7aef}\u{6807}\u{8bc6}\u{3002}ai-term \u{5df2}\u{643a}\u{5e26}",
        "\u{5982}\u{679c}\u{4ecd}\u{5931}\u{8d25}\u{ff0c}\u{8bf7}\u{5728} New API \u{6e20}\u{9053}\u{914d}\u{7f6e}\u{4e2d}\u{5141}\u{8bb8} ai-term\u{ff0c}\u{6216}\u{5173}\u{95ed}\u{8be5}\u{6e20}\u{9053}\u{7684}\u{5ba2}\u{6237}\u{7aef}\u{9650}\u{5236}\u{3002}"
    )
}

fn is_client_restricted_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("channel:client_restricted") || lower.contains("client_restricted")
}

pub(crate) fn reject_html_response(raw: &str, endpoint: &str) -> Result<()> {
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
    fn bounds_conversation_history_for_model_context() {
        let messages = (0..24)
            .map(|index| AiConversationTurn {
                role: if index % 2 == 0 {
                    AiConversationRole::User
                } else {
                    AiConversationRole::Assistant
                },
                content: format!("turn-{index} {}", "x".repeat(700)),
            })
            .collect::<Vec<_>>();

        let selected = conversation_messages_for_payload(&messages);
        let total_chars = selected
            .iter()
            .map(|message| message.content.chars().count())
            .sum::<usize>();

        assert!(selected.len() <= MAX_CONVERSATION_MESSAGES);
        assert!(total_chars <= MAX_CONVERSATION_CHARS);
        assert!(conversation_context_was_compressed(&messages, &selected));
        assert!(selected
            .last()
            .is_some_and(|message| message.content.starts_with("turn-23")));
    }

    #[test]
    fn avoids_repeating_retained_terminal_and_history_in_key_context() {
        let snapshot = "Permission denied while reading /var/log/app.log\nservice failed to start";
        let context = build_context_bundle(snapshot, &["systemctl status app".into()]);
        let prompt = build_user_context_prompt("诊断", &context);
        assert!(context.key_points.is_empty());
        assert!(!context.compressed);
        assert_eq!(prompt.matches("Permission denied").count(), 1);
        assert_eq!(prompt.matches("service failed").count(), 1);
        assert_eq!(prompt.matches("systemctl status app").count(), 1);
    }

    #[test]
    fn retains_omitted_evidence_without_repeating_visible_lines() {
        let snapshot = format!(
            "{}\nPermission denied in omitted region\n{}\nservice failed at end",
            "a".repeat(6_000),
            "b".repeat(10_000)
        );
        let context = build_context_bundle(&snapshot, &[]);
        assert!(context.compressed);
        assert!(!context.terminal.contains("Permission denied"));
        assert!(context
            .key_points
            .iter()
            .any(|line| line.contains("Permission denied")));
        assert!(!context
            .key_points
            .iter()
            .any(|line| line.contains("service failed at end")));
        assert!(context.chars <= MAX_CONTEXT_CHARS);
    }

    #[test]
    fn bounds_all_context_sections_including_long_lines_and_commands() {
        let snapshot = format!(
            "{}\n{}",
            "error: diagnostic message\n".repeat(1_000),
            "终".repeat(30_000)
        );
        let context = build_context_bundle(&snapshot, &["长命令".repeat(20_000)]);
        assert!(context.chars <= MAX_CONTEXT_CHARS);
        assert!(context.key_points.join("\n").chars().count() <= MAX_KEY_CONTEXT_CHARS);
        assert!(context.history.join("\n").chars().count() <= MAX_HISTORY_CHARS);
        assert!(context.history[0].contains("不可直接执行"));
        assert_eq!(
            context.chars,
            context.terminal.chars().count()
                + context.history.join("\n").chars().count()
                + context.key_points.join("\n").chars().count()
        );
    }

    #[test]
    fn history_budget_keeps_a_recent_suffix_without_reordering_repeated_commands() {
        let commands = vec![
            "x".repeat(1_990),
            "pwd".into(),
            "git status".into(),
            "pwd".into(),
        ];
        let context = build_context_bundle("", &commands);
        assert_eq!(context.history, vec!["pwd", "git status", "pwd"]);
        assert!(context.compressed);
    }

    #[test]
    fn bounds_key_evidence_and_prefers_recent_omitted_lines() {
        let snapshot = (0..100)
            .map(|index| format!("error-{index}: {}", "细节".repeat(60)))
            .collect::<Vec<_>>()
            .join("\n");
        let points = extract_key_context(&snapshot, "");
        assert!(points.join("\n").chars().count() <= MAX_KEY_CONTEXT_CHARS);
        assert!(points.last().unwrap().contains("error-99:"));
        assert!(!points.iter().any(|line| line.contains("error-0:")));
    }

    #[test]
    fn session_title_uses_bounded_exchange_without_terminal_logs() {
        let request = AiSessionTitleRequest {
            config: compact_test_config(),
            api_key: "test-key".into(),
            user_message: "问题".repeat(10_000),
            assistant_message: "结论".repeat(10_000),
            terminal_snapshot: "DO_NOT_REPEAT_LOGS".repeat(10_000),
            command_history: vec!["DO_NOT_REPEAT_HISTORY".into()],
        };
        let prompt = build_title_prompt(&request);
        assert!(prompt.chars().count() < 1_550);
        assert!(!prompt.contains("DO_NOT_REPEAT"));
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
    fn explains_client_restricted_gateway_error() {
        let raw = r#"{"error":{"message":"blocked client","type":"new_api_error","code":"channel:client_restricted"}}"#;
        let parsed = parse_model_error(raw);

        assert!(parsed.contains("code: channel:client_restricted"));
        assert!(parsed.contains("User-Agent: ai-term/"));
        assert!(parsed.contains("X-Client-Name: ai-term"));
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
            parse_sse_event_deltas(&event, &mut None).unwrap(),
            vec!["hello".to_string(), " world".to_string()]
        );
    }

    #[test]
    fn ignores_data_after_stream_done() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"完成\"}}]}\n\ndata: [DONE]\n\ndata: {\"error\":{\"message\":\"late error\"}}";
        assert_eq!(
            parse_sse_event_deltas(event, &mut None).unwrap(),
            vec!["完成"]
        );
    }

    #[test]
    fn merges_stream_usage_snapshots_without_emitting_deltas() {
        let mut usage = None;
        let events = [
            r#"data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":40,"completion_tokens":1}}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":3,"total_tokens":43,"prompt_tokens_details":{"cached_tokens":32}}}"#,
            "data: [DONE]",
        ];
        let deltas = events
            .iter()
            .flat_map(|event| parse_sse_event_deltas(event, &mut usage).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(deltas, vec!["hi"]);
        let usage = usage.unwrap();
        assert_eq!(usage.input_tokens, Some(40));
        assert_eq!(usage.output_tokens, Some(3));
        assert_eq!(usage.total_tokens, Some(43));
        assert_eq!(usage.cached_input_tokens, Some(32));
    }

    #[test]
    fn requests_stream_usage_only_for_streaming_payloads() {
        let request = chat_request_with_summary(None);
        let context = build_context_bundle("", &[]);
        let streaming = build_chat_payload(&request, &context, &[], true);
        assert_eq!(
            streaming.pointer("/stream_options/include_usage"),
            Some(&Value::Bool(true))
        );
        let blocking = build_chat_payload(&request, &context, &[], false);
        assert!(blocking.get("stream_options").is_none());
    }

    #[test]
    fn context_bundle_budgets_visible_text_not_control_bytes() {
        let snapshot = format!(
            "\u{1b}]133;A\u{7}\u{1b}[32muser@host\u{1b}[0m:~$ ls\r\n{}\r\n",
            "\u{1b}[1;34mlogs\u{1b}[0m  \u{1b}[1;34mbin\u{1b}[0m"
        );
        let context = build_context_bundle(&snapshot, &[]);
        assert_eq!(context.terminal, "user@host:~$ ls\nlogs  bin\n");
        assert_eq!(context.chars, context.terminal.chars().count());
        assert!(!context.compressed);

        // 进度条的每一帧都在原始快照里,预算只按最后一帧计
        let progress = format!("{}\r下载 100%\r\n", "下载 1%\r".repeat(5_000));
        let context = build_context_bundle(&progress, &[]);
        assert_eq!(context.terminal, "下载 100%\n");
        assert!(!context.compressed);
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

    fn compact_test_config() -> AiProviderConfig {
        AiProviderConfig {
            id: "config-1".into(),
            provider: crate::domain::connection::models::AiProviderType::OpenAiCompatible,
            base_url: "https://provider.example/v1".into(),
            model: "test-model".into(),
            api_key_ref: String::new(),
            api_key: None,
            context_policy: crate::domain::connection::models::ContextPolicy::SelectedOutputOnly,
            system_prompt: String::new(),
            risk_policy: String::new(),
            timeout_seconds: 0,
        }
    }

    fn chat_request_with_summary(summary: Option<&str>) -> AiChatRequest {
        AiChatRequest {
            config: compact_test_config(),
            api_key: "key".into(),
            question: "内存占用怎么看".into(),
            terminal_snapshot: String::new(),
            command_history: Vec::new(),
            conversation_messages: Vec::new(),
            conversation_summary: summary.map(str::to_string),
        }
    }

    #[test]
    fn chat_payload_keeps_instructions_stable_when_summary_changes() {
        let request = chat_request_with_summary(Some("早期对话：已在 web-1 上排查过 nginx 502。"));
        let no_history: Vec<String> = Vec::new();
        let no_turns: Vec<AiConversationTurn> = Vec::new();
        let context = build_context_bundle("", &no_history);
        let payload = build_chat_payload(&request, &context, &no_turns, false);

        let system = payload
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(!system.contains("【历史对话摘要】"));
        let summary = payload
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(summary.contains("【历史对话摘要】"));
        assert!(summary.contains("nginx 502"));
        assert_eq!(
            payload.pointer("/messages/1/role").and_then(Value::as_str),
            Some("user")
        );
        let newer = build_chat_payload(
            &chat_request_with_summary(Some("最新摘要：问题已解决。")),
            &context,
            &no_turns,
            false,
        );
        assert_eq!(payload["messages"][0], newer["messages"][0]);
        assert_ne!(payload["messages"][1], newer["messages"][1]);
        assert!(conversation_summary_chars(&request) > 0);
    }

    #[test]
    fn chat_payload_ignores_blank_conversation_summary() {
        let request = chat_request_with_summary(Some("   "));
        let no_history: Vec<String> = Vec::new();
        let no_turns: Vec<AiConversationTurn> = Vec::new();
        let context = build_context_bundle("", &no_history);
        let payload = build_chat_payload(&request, &context, &no_turns, false);

        let system = payload
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(!system.contains("【历史对话摘要】"));
        assert_eq!(conversation_summary_chars(&request), 0);
        assert_eq!(
            conversation_summary_chars(&chat_request_with_summary(None)),
            0
        );
    }

    #[test]
    fn caps_overlong_conversation_summary() {
        let long_summary = "长".repeat(MAX_CONVERSATION_SUMMARY_CHARS + 500);
        let request = chat_request_with_summary(Some(&long_summary));

        let normalized = normalized_conversation_summary(&request).unwrap();
        assert!(normalized.chars().count() <= MAX_CONVERSATION_SUMMARY_CHARS + 3);
        assert!(normalized.ends_with("..."));
    }

    #[test]
    fn compact_prompt_merges_previous_summary_and_turns() {
        let request = AiConversationCompactRequest {
            config: compact_test_config(),
            api_key: "key".into(),
            previous_summary: Some("旧摘要：目标主机 web-1。".into()),
            messages: vec![
                AiConversationTurn {
                    role: AiConversationRole::User,
                    content: "查看 nginx 日志".into(),
                },
                AiConversationTurn {
                    role: AiConversationRole::Assistant,
                    content: "tail -n 100 /var/log/nginx/error.log".into(),
                },
            ],
        };

        let prompt = build_compact_prompt(&request);
        assert!(prompt.contains("【旧摘要】"));
        assert!(prompt.contains("web-1"));
        assert!(prompt.contains("用户：查看 nginx 日志"));
        assert!(prompt.contains("AI：tail -n 100"));
        assert!(validate_compact_request(&request).is_ok());
    }

    #[test]
    fn compact_prompt_drops_oldest_turns_when_over_budget() {
        let request = AiConversationCompactRequest {
            config: compact_test_config(),
            api_key: "key".into(),
            previous_summary: None,
            messages: (0..20)
                .map(|index| AiConversationTurn {
                    role: AiConversationRole::User,
                    content: format!("turn-{index} {}", "x".repeat(1_400)),
                })
                .collect(),
        };

        let prompt = build_compact_prompt(&request);
        assert!(prompt.chars().count() < MAX_COMPACT_SOURCE_TOTAL_CHARS + 500);
        assert!(prompt.contains("因过长已省略"));
        assert!(!prompt.contains("turn-0 "));
        assert!(prompt.contains("turn-19"));
    }

    #[test]
    fn rejects_compact_request_without_messages() {
        let request = AiConversationCompactRequest {
            config: compact_test_config(),
            api_key: "key".into(),
            previous_summary: None,
            messages: vec![AiConversationTurn {
                role: AiConversationRole::User,
                content: "   ".into(),
            }],
        };

        assert!(validate_compact_request(&request).is_err());
    }
}
