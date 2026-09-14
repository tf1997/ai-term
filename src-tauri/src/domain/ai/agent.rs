//! Agent 模式的模型协议层：payload 构造、轮次校验、流式 tool_calls 解析。
//! 设计见 docs/ai-agent-mode-development.md 第 5 节；HTTP/SSE 基础设施复用 chat 模块。

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::ai::chat::{
    build_context_bundle, build_user_context_prompt, chat_completions_endpoint,
    conversation_context_chars, conversation_context_was_compressed,
    conversation_messages_for_payload, conversation_summary_message, extract_chat_answer,
    extract_stream_delta, is_cancelled, parse_model_error, reject_html_response,
    stream_usage_options, truncate_for_prompt, AiCancelToken, AiConversationRole,
    AiConversationTurn, ContextBundle, MAX_CONVERSATION_SUMMARY_CHARS,
};
use crate::domain::ai::stream::{
    is_stream_done, open_stream, sse_data_payloads, wait_for_stream, SseEventBuffer, StreamStart,
};
use crate::domain::ai::usage::{merge_usage, usage_from_json, AiTokenUsage};
use crate::domain::connection::models::AiProviderConfig;
use crate::domain::text::Utf8StreamDecoder;

/// 任务轮次的字符总量上限；超限直接报错，轮次压缩由前端负责（文档第 8 节）。
/// 前端在 24k 软预算处开始压缩旧证据;此处保留独立的协议硬上限。
const MAX_AGENT_TURN_CHARS: usize = 80_000;
/// Short outputs cost less than a reference and should remain verbatim.
const MIN_DUPLICATE_OUTPUT_CHARS: usize = 256;
/// 缺失工具结果时自动补发的 tool 消息内容（文档 5.3）。
const SKIPPED_TOOL_RESULT_CONTENT: &str = r#"{"status":"skipped"}"#;
/// 网关疑似不支持 function calling 时前置的提示（文档 5.7）。
const TOOLS_UNSUPPORTED_HINT: &str =
    "当前模型或网关可能不支持工具调用(Agent 模式),请更换模型或切回普通对话。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentTurnRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    /// 用户任务描述（整个任务期间不变）。
    pub goal: String,
    /// 本任务内已发生的轮次，按序。
    pub turns: Vec<AiAgentTurn>,
    pub terminal_snapshot: String,
    pub command_history: Vec<String>,
    /// 会话内普通对话历史与压缩摘要，作为背景（复用 chat 的结构）。
    #[serde(default)]
    pub conversation_messages: Vec<AiConversationTurn>,
    #[serde(default)]
    pub conversation_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiAgentTurn {
    /// 模型上一轮输出：文本 + 工具调用。
    Assistant {
        text: String,
        tool_calls: Vec<AiToolCall>,
    },
    /// 某个工具调用的结果（执行输出 / 跳过 / 超时说明）。
    ToolResult {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    /// 原样透传的 JSON 字符串，前端负责解析 command/reason。
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentTurnResponse {
    pub text: String,
    /// 空数组 = 模型认为任务完成。
    pub tool_calls: Vec<AiToolCall>,
    pub context_compressed: bool,
    pub context_chars: usize,
    /// 本轮请求的 token 用量;网关不返回 usage 时为 None,不做估算。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AiTokenUsage>,
}

pub async fn agent_turn_with_provider_stream<F>(
    request: AiAgentTurnRequest,
    on_delta: F,
    cancel_token: Option<&AiCancelToken>,
) -> Result<AiAgentTurnResponse>
where
    F: FnMut(String) + Send,
{
    validate_agent_turn_request(&request)?;
    let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
    let conversation = conversation_messages_for_payload(&request.conversation_messages);
    let summary_chars = conversation_summary_chars(&request);
    let endpoint = chat_completions_endpoint(&request.config.base_url);
    let payload = build_agent_payload(&request, &context, &conversation, true)?;

    let (text, tool_calls, usage) = send_agent_stream_request(
        &endpoint,
        &request.api_key,
        payload,
        request.config.timeout_seconds,
        on_delta,
        cancel_token,
    )
    .await?;

    Ok(AiAgentTurnResponse {
        text,
        tool_calls,
        context_compressed: context.compressed
            || summary_chars > 0
            || conversation_context_was_compressed(&request.conversation_messages, &conversation),
        context_chars: context.chars + conversation_context_chars(&conversation) + summary_chars,
        usage,
    })
}

fn validate_agent_turn_request(request: &AiAgentTurnRequest) -> Result<()> {
    if request.config.base_url.trim().is_empty() {
        bail!("请先配置 AI Base URL");
    }
    if request.config.model.trim().is_empty() {
        bail!("请先配置 AI Model");
    }
    if request.api_key.trim().is_empty() {
        bail!("请在 AI 配置中填写 API Key 并保存");
    }
    if request.goal.trim().is_empty() {
        bail!("任务目标不能为空");
    }
    let turn_chars = agent_turn_chars(&request.turns);
    if turn_chars > MAX_AGENT_TURN_CHARS {
        bail!(
            "任务轮次过长：共 {turn_chars} 字符，超出上限 {MAX_AGENT_TURN_CHARS} 字符，请压缩早期轮次后重试"
        );
    }
    Ok(())
}

fn agent_turn_chars(turns: &[AiAgentTurn]) -> usize {
    turns
        .iter()
        .map(|turn| match turn {
            AiAgentTurn::Assistant { text, tool_calls } => {
                text.chars().count()
                    + tool_calls
                        .iter()
                        .map(|call| call.arguments.chars().count())
                        .sum::<usize>()
            }
            AiAgentTurn::ToolResult { content, .. } => content.chars().count(),
        })
        .sum()
}

fn build_agent_payload(
    request: &AiAgentTurnRequest,
    context: &ContextBundle,
    conversation: &[AiConversationTurn],
    stream: bool,
) -> Result<Value> {
    let mut messages = vec![json!({
        "role": "system",
        "content": build_agent_system_prompt(&request.config.system_prompt)
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
        "content": build_user_context_prompt(&request.goal, context)
    }));
    append_turn_messages(&mut messages, &request.turns)?;

    let mut payload = json!({
        "model": request.config.model,
        "messages": messages,
        "tools": [run_command_tool_definition()],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "temperature": 0.2,
        "stream": stream
    });
    if stream {
        payload["stream_options"] = stream_usage_options();
    }
    Ok(payload)
}

fn build_agent_system_prompt(custom_prompt: &str) -> String {
    [
        custom_prompt.trim(),
        "你是 AI Term 的终端操作 Agent,通过 run_command 工具在用户当前终端执行命令来完成用户任务。",
        "工作方式:自主推进。先依据已有上下文定位缺口,用有针对性的只读检查验证;只读检查通常自动执行,可连续多次调用,不要因为担心打扰而提前收尾。证据足够即收尾,避免重复查询或与目标无关的全面巡检;证据不足时继续查,不要猜测。",
        "每轮只调用一次 run_command,根据输出和退出码决定下一步。工具调用的 reason 用一句话说明目的,不再用正文重复计划或历史输出。",
        "删除、覆盖、重启、服务变更等破坏性操作之前,必须先只读确认目标存在且正确,在 reason 说明依据,等待用户审批。",
        "命令完整可直接执行,不用交互式编辑器(vim/nano)或分页器(less)。长输出用过滤、head/tail 或行数限制,优先获取与问题相关的片段。",
        "结果标注 skipped 时不要原样重发;改用其他方法,或在需要用户决策、授权或补充无法查到的信息时询问。",
        "以最新工具结果和终端内容为准;任务完成或确实无法继续时,简洁说明结果、关键证据和遗留问题。",
    ]
    .iter()
    .map(|item| item.trim())
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn run_command_tool_definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "在用户当前终端执行一条 shell 命令并返回输出与退出码。只读检查命令通常自动执行,可连续多次调用来收集证据;写入和危险操作会先展示给用户审批。一次只提出一条命令;危险操作必须先用只读命令确认目标。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "完整的单条 shell 命令" },
                    "reason": { "type": "string", "description": "为什么执行这条命令(一句话,展示给用户)" }
                },
                "required": ["command"]
            }
        }
    })
}

fn normalized_conversation_summary(request: &AiAgentTurnRequest) -> Option<String> {
    let summary = request.conversation_summary.as_deref()?.trim();
    if summary.is_empty() {
        return None;
    }
    Some(truncate_for_prompt(summary, MAX_CONVERSATION_SUMMARY_CHARS))
}

fn conversation_summary_chars(request: &AiAgentTurnRequest) -> usize {
    normalized_conversation_summary(request)
        .map(|summary| summary.chars().count())
        .unwrap_or(0)
}

/// 按 OpenAI 协议展开任务轮次：每个 tool 消息必须紧跟在包含对应
/// tool_call_id 的 assistant 消息之后；缺失结果的 tool_call 自动补一条
/// skipped，防止个别网关直接 400；无前置 tool_call 的结果视为非法轮次。
fn append_turn_messages(messages: &mut Vec<Value>, turns: &[AiAgentTurn]) -> Result<()> {
    let mut pending_tool_call_ids: Vec<String> = Vec::new();
    let mut output_sources = BTreeMap::new();

    for turn in turns {
        match turn {
            AiAgentTurn::Assistant { text, tool_calls } => {
                flush_pending_tool_results(messages, &mut pending_tool_call_ids);
                let mut message = json!({
                    "role": "assistant",
                    "content": if text.trim().is_empty() {
                        Value::Null
                    } else {
                        Value::String(text.clone())
                    },
                });
                if !tool_calls.is_empty() {
                    message["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id": call.id,
                                    "type": "function",
                                    "function": {
                                        "name": call.name,
                                        "arguments": call.arguments,
                                    }
                                })
                            })
                            .collect(),
                    );
                }
                messages.push(message);
                pending_tool_call_ids = tool_calls.iter().map(|call| call.id.clone()).collect();
            }
            AiAgentTurn::ToolResult {
                tool_call_id,
                content,
            } => {
                let Some(position) = pending_tool_call_ids
                    .iter()
                    .position(|pending| pending == tool_call_id)
                else {
                    bail!("任务轮次不合法：工具结果 {tool_call_id} 没有对应的前置 tool_call");
                };
                pending_tool_call_ids.remove(position);
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": deduplicate_tool_output(content, tool_call_id, &mut output_sources),
                }));
            }
        }
    }

    flush_pending_tool_results(messages, &mut pending_tool_call_ids);
    Ok(())
}

/// References are rebuilt from the actual messages in this request, so an
/// earlier compaction can never leave a reference to a missing full output.
/// The transcript and tool status/exit code remain untouched.
fn deduplicate_tool_output(
    content: &str,
    tool_call_id: &str,
    sources: &mut BTreeMap<String, String>,
) -> String {
    let Ok(mut payload) = serde_json::from_str::<Value>(content) else {
        return content.to_string();
    };
    let Some(output) = payload.get("output").and_then(Value::as_str) else {
        return content.to_string();
    };
    if output.chars().count() < MIN_DUPLICATE_OUTPUT_CHARS {
        return content.to_string();
    }
    let Some(source_id) = sources.get(output) else {
        sources.insert(output.to_string(), tool_call_id.to_string());
        return content.to_string();
    };
    let reference = format!("[输出与前面的工具结果 {source_id} 完全相同，请引用该结果中的 output]");
    if reference.chars().count() >= output.chars().count() {
        return content.to_string();
    }
    payload["output"] = Value::String(reference);
    let compact = payload.to_string();
    if compact.chars().count() < content.chars().count() {
        compact
    } else {
        content.to_string()
    }
}

fn flush_pending_tool_results(messages: &mut Vec<Value>, pending_tool_call_ids: &mut Vec<String>) {
    for tool_call_id in pending_tool_call_ids.drain(..) {
        messages.push(json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": SKIPPED_TOOL_RESULT_CONTENT,
        }));
    }
}

/// 流循环结构与 chat 的 send_openai_compatible_stream_request 一致：
/// 文本增量经 on_delta 外发，工具调用增量按 index 累积，usage 帧合并进用量，
/// 全程无 SSE 增量时走非流式兜底。
async fn send_agent_stream_request<F>(
    endpoint: &str,
    api_key: &str,
    payload: Value,
    timeout_seconds: u32,
    mut on_delta: F,
    cancel_token: Option<&AiCancelToken>,
) -> Result<(String, Vec<AiToolCall>, Option<AiTokenUsage>)>
where
    F: FnMut(String) + Send,
{
    let response =
        match open_stream(endpoint, api_key, payload, timeout_seconds, cancel_token).await? {
            StreamStart::Cancelled => return Ok((String::new(), Vec::new(), None)),
            StreamStart::Rejected { status, body } => bail!(
                "模型请求失败：HTTP {status}\n{}",
                agent_model_error_detail(&body)
            ),
            StreamStart::Open(response) => response,
        };

    let mut stream = response.bytes_stream();
    let mut decoder = Utf8StreamDecoder::default();
    let mut raw = String::new();
    let mut event_buffer = SseEventBuffer::default();
    let mut text = String::new();
    let mut accumulator: BTreeMap<u64, AiToolCall> = BTreeMap::new();
    let mut usage = None;
    let mut saw_sse_delta = false;

    while let Some(chunk) = wait_for_stream(stream.next(), timeout_seconds, cancel_token)
        .await?
        .flatten()
    {
        if is_cancelled(cancel_token) {
            return Ok((text, finalize_tool_calls(accumulator), usage));
        }
        let chunk = chunk.context("AI 流式响应读取中断：网络连接或模型服务提前关闭了响应")?;
        let chunk_text = decoder.push(&chunk);
        if chunk_text.is_empty() {
            continue;
        }
        // raw 仅在整个流没有任何 SSE 增量时作为非流式兜底使用，
        // 一旦确认处于流式模式就停止累积完整响应副本。
        if !saw_sse_delta {
            raw.push_str(&chunk_text);
        }
        event_buffer.push(&chunk_text);

        while let Some(event) = event_buffer.next_event() {
            for delta in parse_agent_sse_event(&event, &mut accumulator, &mut usage)? {
                if is_cancelled(cancel_token) {
                    return Ok((text, finalize_tool_calls(accumulator), usage));
                }
                saw_sse_delta = true;
                text.push_str(&delta);
                on_delta(delta);
            }
            saw_sse_delta = saw_sse_delta || !accumulator.is_empty();
            if is_stream_done(&event) {
                if !saw_sse_delta {
                    bail!("模型返回为空");
                }
                return Ok((text, finalize_tool_calls(accumulator), usage));
            }
        }
    }

    if is_cancelled(cancel_token) {
        return Ok((text, finalize_tool_calls(accumulator), usage));
    }

    if !event_buffer.remaining().trim().is_empty() {
        for delta in parse_agent_sse_event(event_buffer.remaining(), &mut accumulator, &mut usage)?
        {
            if is_cancelled(cancel_token) {
                return Ok((text, finalize_tool_calls(accumulator), usage));
            }
            saw_sse_delta = true;
            text.push_str(&delta);
            on_delta(delta);
        }
        saw_sse_delta = saw_sse_delta || !accumulator.is_empty();
    }

    if saw_sse_delta {
        return Ok((text, finalize_tool_calls(accumulator), usage));
    }

    reject_html_response(&raw, endpoint)?;
    let (text, tool_calls) = extract_agent_completion(&raw)?;
    if !text.is_empty() {
        on_delta(text.clone());
    }
    Ok((text, tool_calls, usage_from_json(&raw)))
}

/// 解析一个 SSE 事件：返回文本增量，工具调用增量累积进 accumulator，
/// usage 快照合并进 usage。
fn parse_agent_sse_event(
    event: &str,
    accumulator: &mut BTreeMap<u64, AiToolCall>,
    usage: &mut Option<AiTokenUsage>,
) -> Result<Vec<String>> {
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
        accumulate_tool_call_deltas(accumulator, &payload);
        merge_usage(usage, &payload);
    }

    Ok(deltas)
}

/// 按 index 累积工具调用增量：id/name/arguments 都兼容分片下发。
/// 部分兼容网关会重复发送完整 id/name，合并时避免把重复值拼接两次。
fn accumulate_tool_call_deltas(accumulator: &mut BTreeMap<u64, AiToolCall>, payload: &Value) {
    let streamed = payload
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array);
    let complete = streamed.is_none();
    let Some(deltas) = streamed.or_else(|| {
        payload
            .pointer("/choices/0/message/tool_calls")
            .and_then(Value::as_array)
    }) else {
        return;
    };

    for (position, delta) in deltas.iter().enumerate() {
        let index = delta
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(position as u64);
        let call = accumulator.entry(index).or_insert_with(empty_tool_call);
        if let Some(id) = delta
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            merge_stream_field(&mut call.id, id);
        }
        if let Some(name) = delta
            .pointer("/function/name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            merge_stream_field(&mut call.name, name);
        }
        if let Some(arguments) = delta.pointer("/function/arguments") {
            match arguments {
                Value::String(value) if complete => call.arguments = value.clone(),
                Value::String(fragment) => call.arguments.push_str(fragment),
                Value::Null => {}
                other => call.arguments = serde_json::to_string(other).unwrap_or_default(),
            }
        }
    }
}

fn merge_stream_field(target: &mut String, fragment: &str) {
    if target.is_empty() {
        target.push_str(fragment);
    } else if fragment.starts_with(target.as_str()) {
        target.clear();
        target.push_str(fragment);
    } else if !target.starts_with(fragment) {
        target.push_str(fragment);
    }
}

fn empty_tool_call() -> AiToolCall {
    AiToolCall {
        id: String::new(),
        name: String::new(),
        arguments: String::new(),
    }
}

/// 个别网关把 function.arguments 返回为 JSON 对象而非字符串，统一归一化为字符串。
fn tool_call_arguments_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// 累积表非空即输出 tool_calls，不依赖 finish_reason（部分网关不回传）。
fn finalize_tool_calls(accumulator: BTreeMap<u64, AiToolCall>) -> Vec<AiToolCall> {
    accumulator
        .into_iter()
        .filter_map(|(index, mut call)| {
            if call.id.is_empty() && call.name.is_empty() && call.arguments.is_empty() {
                return None;
            }
            if call.id.is_empty() {
                call.id = format!("ai-term-call-{index}");
            }
            Some(call)
        })
        .collect()
}

/// 非流式兜底：整体 JSON 里取 choices/0/message/content 为 text、
/// choices/0/message/tool_calls 为工具调用；没有工具调用时按普通文本
/// 回答处理，复用 chat 的提取逻辑与错误文案。
fn extract_agent_completion(raw: &str) -> Result<(String, Vec<AiToolCall>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("模型返回为空");
    }

    let payload = serde_json::from_str::<Value>(trimmed).ok();
    let tool_calls = payload
        .as_ref()
        .and_then(|payload| payload.pointer("/choices/0/message/tool_calls"))
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(parse_message_tool_call)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if tool_calls.is_empty() {
        return Ok((extract_chat_answer(trimmed)?, Vec::new()));
    }

    let text = payload
        .as_ref()
        .and_then(|payload| payload.pointer("/choices/0/message/content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    Ok((text, tool_calls))
}

fn parse_message_tool_call(value: &Value) -> AiToolCall {
    AiToolCall {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: value
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        arguments: value
            .pointer("/function/arguments")
            .map(tool_call_arguments_text)
            .unwrap_or_default(),
    }
}

/// 错误正文提及 tool/function 关键字时，前置切换建议（文档 5.7）。
fn agent_model_error_detail(raw: &str) -> String {
    let detail = parse_model_error(raw);
    if error_mentions_tool_support(&detail) {
        return format!("{TOOLS_UNSUPPORTED_HINT}\n{detail}");
    }
    detail
}

fn error_mentions_tool_support(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("tool") || lower.contains("function")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_test_config() -> AiProviderConfig {
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

    fn agent_request(turns: Vec<AiAgentTurn>) -> AiAgentTurnRequest {
        AiAgentTurnRequest {
            config: agent_test_config(),
            api_key: "key".into(),
            goal: "排查磁盘占用".into(),
            turns,
            terminal_snapshot: String::new(),
            command_history: Vec::new(),
            conversation_messages: Vec::new(),
            conversation_summary: None,
        }
    }

    fn tool_call(id: &str, arguments: &str) -> AiToolCall {
        AiToolCall {
            id: id.into(),
            name: "run_command".into(),
            arguments: arguments.into(),
        }
    }

    fn build_test_payload(request: &AiAgentTurnRequest) -> Result<Value> {
        let context = build_context_bundle(&request.terminal_snapshot, &request.command_history);
        let conversation = conversation_messages_for_payload(&request.conversation_messages);
        build_agent_payload(request, &context, &conversation, true)
    }

    fn apply_events(events: &[&str]) -> (String, BTreeMap<u64, AiToolCall>) {
        let (text, accumulator, _) = apply_events_with_usage(events);
        (text, accumulator)
    }

    fn apply_events_with_usage(
        events: &[&str],
    ) -> (String, BTreeMap<u64, AiToolCall>, Option<AiTokenUsage>) {
        let mut accumulator = BTreeMap::new();
        let mut usage = None;
        let mut text = String::new();
        for event in events {
            for delta in parse_agent_sse_event(event, &mut accumulator, &mut usage).unwrap() {
                text.push_str(&delta);
            }
        }
        (text, accumulator, usage)
    }

    #[test]
    fn payload_includes_tool_definition_and_disables_parallel_calls() {
        let request = agent_request(Vec::new());
        let payload = build_test_payload(&request).unwrap();

        assert_eq!(
            payload
                .pointer("/tools/0/function/name")
                .and_then(Value::as_str),
            Some("run_command")
        );
        assert_eq!(
            payload.pointer("/tool_choice").and_then(Value::as_str),
            Some("auto")
        );
        assert_eq!(
            payload
                .pointer("/parallel_tool_calls")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            payload.pointer("/stream").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            payload
                .pointer("/stream_options/include_usage")
                .and_then(Value::as_bool),
            Some(true)
        );

        let system = payload
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(system.contains("终端操作 Agent"));
        let user = payload
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(user.contains("排查磁盘占用"));
    }

    #[test]
    fn payload_expands_turns_in_protocol_order() {
        let request = agent_request(vec![
            AiAgentTurn::Assistant {
                text: "先看磁盘使用".into(),
                tool_calls: vec![tool_call("call-1", r#"{"command":"df -h"}"#)],
            },
            AiAgentTurn::ToolResult {
                tool_call_id: "call-1".into(),
                content: r#"{"exitCode":0,"output":"/dev/disk1 90%"}"#.into(),
            },
            AiAgentTurn::Assistant {
                text: String::new(),
                tool_calls: vec![tool_call("call-2", r#"{"command":"du -sh /var/*"}"#)],
            },
            AiAgentTurn::ToolResult {
                tool_call_id: "call-2".into(),
                content: r#"{"exitCode":0,"output":"2G /var/log"}"#.into(),
            },
        ]);
        let payload = build_test_payload(&request).unwrap();
        let messages = payload
            .pointer("/messages")
            .and_then(Value::as_array)
            .unwrap();

        let roles = messages
            .iter()
            .map(|message| message.get("role").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            roles,
            vec!["system", "user", "assistant", "tool", "assistant", "tool"]
        );
        assert_eq!(
            messages[2].get("content").and_then(Value::as_str),
            Some("先看磁盘使用")
        );
        assert_eq!(
            messages[2]
                .pointer("/tool_calls/0/id")
                .and_then(Value::as_str),
            Some("call-1")
        );
        assert_eq!(
            messages[2]
                .pointer("/tool_calls/0/type")
                .and_then(Value::as_str),
            Some("function")
        );
        assert_eq!(
            messages[2]
                .pointer("/tool_calls/0/function/arguments")
                .and_then(Value::as_str),
            Some(r#"{"command":"df -h"}"#)
        );
        assert_eq!(
            messages[3].get("tool_call_id").and_then(Value::as_str),
            Some("call-1")
        );
        // text 为空的 assistant 轮次 content 必须为 null。
        assert!(messages[4].get("content").unwrap().is_null());
        assert_eq!(
            messages[5].get("tool_call_id").and_then(Value::as_str),
            Some("call-2")
        );
    }

    fn output_turns(results: &[(&str, Value)]) -> Vec<AiAgentTurn> {
        results
            .iter()
            .flat_map(|(id, result)| {
                [
                    AiAgentTurn::Assistant {
                        text: String::new(),
                        tool_calls: vec![tool_call(id, r#"{"command":"tail -n 100 app.log"}"#)],
                    },
                    AiAgentTurn::ToolResult {
                        tool_call_id: (*id).into(),
                        content: result.to_string(),
                    },
                ]
            })
            .collect()
    }

    fn tool_results(payload: &Value) -> Vec<Value> {
        payload["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "tool")
            .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn duplicate_outputs_reference_existing_content_and_preserve_metadata() {
        let output = "complete log line\n".repeat(250);
        let mut request = agent_request(output_turns(&[
            ("first", json!({"exitCode": 0, "output": output})),
            (
                "second",
                json!({"exitCode": 1, "durationMs": 75, "truncated": true, "output": output}),
            ),
        ]));
        let original_turns = request.turns.clone();
        let payload = build_test_payload(&request).unwrap();
        let results = tool_results(&payload);
        assert_eq!(results[0]["output"], output);
        assert!(results[1]["output"].as_str().unwrap().contains("first"));
        assert!(results[1]["output"].as_str().unwrap().chars().count() < 100);
        assert_eq!(results[1]["exitCode"], 1);
        assert_eq!(results[1]["durationMs"], 75);
        assert_eq!(results[1]["truncated"], true);
        assert_eq!(
            request.turns, original_turns,
            "stored transcript is not rewritten"
        );

        request.turns.extend(output_turns(&[(
            "third",
            json!({"exitCode": 0, "output": output}),
        )]));
        let next = build_test_payload(&request).unwrap();
        let previous_messages = payload["messages"].as_array().unwrap();
        assert_eq!(
            &next["messages"].as_array().unwrap()[..previous_messages.len()],
            previous_messages
        );
        assert!(tool_results(&next)[2]["output"]
            .as_str()
            .unwrap()
            .contains("first"));
    }

    #[test]
    fn output_references_are_rebuilt_after_earlier_turns_are_compacted() {
        let output = "full output\n".repeat(300);
        let request = agent_request(output_turns(&[
            (
                "compacted",
                json!({"exitCode": 0, "output": "only the tail", "note": "仅保留输出尾部"}),
            ),
            ("full", json!({"exitCode": 0, "output": output})),
            ("repeat", json!({"exitCode": 0, "output": output})),
        ]));
        let results = tool_results(&build_test_payload(&request).unwrap());
        assert_eq!(results[1]["output"], output);
        assert!(results[2]["output"].as_str().unwrap().contains("full"));
        assert!(!results[2]["output"].as_str().unwrap().contains("compacted"));
    }

    #[test]
    fn different_or_short_outputs_are_not_replaced_with_references() {
        let output = "log data\n".repeat(100);
        let changed = format!("{output}ERROR: disk full");
        let request = agent_request(output_turns(&[
            ("one", json!({"output": output})),
            ("two", json!({"output": changed})),
            ("three", json!({"output": "ok"})),
            ("four", json!({"output": "ok"})),
        ]));
        let results = tool_results(&build_test_payload(&request).unwrap());
        assert_eq!(results[0]["output"], output);
        assert_eq!(results[1]["output"], changed);
        assert_eq!(results[2]["output"], "ok");
        assert_eq!(results[3]["output"], "ok");
    }

    #[test]
    fn payload_fills_missing_tool_results_as_skipped() {
        let request = agent_request(vec![
            AiAgentTurn::Assistant {
                text: String::new(),
                tool_calls: vec![
                    tool_call("call-1", r#"{"command":"df -h"}"#),
                    tool_call("call-2", r#"{"command":"free -h"}"#),
                ],
            },
            AiAgentTurn::ToolResult {
                tool_call_id: "call-2".into(),
                content: r#"{"exitCode":0,"output":"ok"}"#.into(),
            },
            AiAgentTurn::Assistant {
                text: "继续".into(),
                tool_calls: vec![tool_call("call-3", r#"{"command":"uptime"}"#)],
            },
        ]);
        let payload = build_test_payload(&request).unwrap();
        let messages = payload
            .pointer("/messages")
            .and_then(Value::as_array)
            .unwrap();

        // assistant(双调用) → 实际结果(call-2) → 自动补 call-1 → assistant → 末尾补 call-3。
        assert_eq!(
            messages[3].get("tool_call_id").and_then(Value::as_str),
            Some("call-2")
        );
        assert_eq!(
            messages[4].get("tool_call_id").and_then(Value::as_str),
            Some("call-1")
        );
        assert_eq!(
            messages[4].get("content").and_then(Value::as_str),
            Some(SKIPPED_TOOL_RESULT_CONTENT)
        );
        assert_eq!(
            messages[5].get("role").and_then(Value::as_str),
            Some("assistant")
        );
        assert_eq!(
            messages[6].get("tool_call_id").and_then(Value::as_str),
            Some("call-3")
        );
        assert_eq!(
            messages[6].get("content").and_then(Value::as_str),
            Some(SKIPPED_TOOL_RESULT_CONTENT)
        );
        assert_eq!(messages.len(), 7);
    }

    #[test]
    fn ignores_data_after_stream_done() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"完成\"}}]}\n\ndata: [DONE]\n\ndata: {\"error\":{\"message\":\"late error\"}}";
        let mut accumulator = BTreeMap::new();
        assert_eq!(
            parse_agent_sse_event(event, &mut accumulator, &mut None).unwrap(),
            vec!["完成"]
        );
        assert!(accumulator.is_empty());
    }

    #[test]
    fn merges_usage_frame_alongside_tool_call_deltas() {
        let (text, accumulator, usage) = apply_events_with_usage(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"command\":\"df -h\"}"}}]}}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":18,"total_tokens":1218,"prompt_tokens_details":{"cached_tokens":1024}}}"#,
            "data: [DONE]",
        ]);

        assert_eq!(text, "");
        assert_eq!(finalize_tool_calls(accumulator).len(), 1);
        let usage = usage.unwrap();
        assert_eq!(usage.input_tokens, Some(1200));
        assert_eq!(usage.cached_input_tokens, Some(1024));
        assert_eq!(usage.output_tokens, Some(18));
    }

    #[test]
    fn rejects_tool_result_without_matching_tool_call() {
        let request = agent_request(vec![AiAgentTurn::ToolResult {
            tool_call_id: "call-x".into(),
            content: "{}".into(),
        }]);
        let error = build_test_payload(&request).unwrap_err().to_string();
        assert!(error.contains("没有对应的前置 tool_call"));
    }

    #[test]
    fn payload_injects_custom_prompt_and_conversation_summary() {
        let mut request = agent_request(Vec::new());
        request.config.system_prompt = "自定义提示词".into();
        request.conversation_summary = Some("早期对话：已在 web-1 上排查过 nginx 502。".into());
        let payload = build_test_payload(&request).unwrap();

        let system = payload
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(system.starts_with("自定义提示词"));
        assert!(system.contains("终端操作 Agent"));
        assert!(!system.contains("【历史对话摘要】"));
        let summary = payload
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(summary.contains("nginx 502"));
        assert_eq!(payload["messages"][1]["role"], "user");
        request.conversation_summary = Some("更新后的摘要".into());
        let newer = build_test_payload(&request).unwrap();
        assert_eq!(payload["messages"][0], newer["messages"][0]);
        assert_eq!(payload["tools"], newer["tools"]);
    }

    #[test]
    fn payload_places_conversation_background_before_goal() {
        let mut request = agent_request(Vec::new());
        request.conversation_messages = vec![
            AiConversationTurn {
                role: AiConversationRole::User,
                content: "之前问过 nginx 502".into(),
            },
            AiConversationTurn {
                role: AiConversationRole::Assistant,
                content: "给过 tail 命令".into(),
            },
        ];
        let payload = build_test_payload(&request).unwrap();
        let messages = payload
            .pointer("/messages")
            .and_then(Value::as_array)
            .unwrap();

        assert_eq!(
            messages[1].get("role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("之前问过 nginx 502")
        );
        assert_eq!(
            messages[2].get("role").and_then(Value::as_str),
            Some("assistant")
        );
        assert!(messages[3]
            .get("content")
            .and_then(Value::as_str)
            .unwrap()
            .contains("排查磁盘占用"));
    }

    #[test]
    fn accumulates_streamed_tool_call_argument_fragments() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"comm"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\":\"df -h\"}"}}]}}]}"#,
            "data: [DONE]",
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "run_command");
        assert_eq!(calls[0].arguments, r#"{"command":"df -h"}"#);
    }

    #[test]
    fn accumulates_fragmented_and_repeated_tool_metadata() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-","function":{"name":"run_","arguments":"{\"command\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"command","arguments":"\"uptime\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command"}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "run_command");
        assert_eq!(calls[0].arguments, r#"{"command":"uptime"}"#);
    }

    #[test]
    fn complete_message_tool_call_replaces_partial_stream_arguments() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"comm"}}]}}]}"#,
            r#"data: {"choices":[{"message":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"command\":\"uptime\"}"}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls[0].arguments, r#"{"command":"uptime"}"#);
    }

    #[test]
    fn object_arguments_replace_partial_string_arguments() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"comm"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":{"command":"uptime"}}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls[0].arguments, r#"{"command":"uptime"}"#);
    }

    #[test]
    fn supplies_id_when_compatible_gateway_omits_it() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":3,"function":{"name":"run_command","arguments":"{\"command\":\"uptime\"}"}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "ai-term-call-3");
        assert_eq!(calls[0].name, "run_command");
    }

    #[test]
    fn orders_tool_calls_by_stream_index() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"run_command","arguments":"{\"command\":\"free -h\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"run_command","arguments":"{\"command\":\"df -h\"}"}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(
            calls
                .iter()
                .map(|call| call.id.as_str())
                .collect::<Vec<_>>(),
            vec!["call-a", "call-b"]
        );
    }

    #[test]
    fn accepts_single_delta_complete_tool_call() {
        let (_, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"uptime\"}"}}]}}]}"#,
        ]);

        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].arguments, r#"{"command":"uptime"}"#);
    }

    #[test]
    fn parses_mixed_text_and_tool_calls_without_finish_reason() {
        let (text, accumulator) = apply_events(&[
            r#"data: {"choices":[{"delta":{"content":"我先看"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"磁盘。"}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_command","arguments":"{\"command\":\"df -h\"}"}}]}}]}"#,
        ]);

        assert_eq!(text, "我先看磁盘。");
        let calls = finalize_tool_calls(accumulator);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "run_command");
    }

    #[test]
    fn surfaces_stream_error_events() {
        let mut accumulator = BTreeMap::new();
        let error = parse_agent_sse_event(
            r#"data: {"error":{"message":"boom"}}"#,
            &mut accumulator,
            &mut None,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("模型流式返回错误：boom"));
    }

    #[test]
    fn extracts_tool_calls_from_non_stream_response() {
        let raw = r#"{"choices":[{"message":{"content":"看下磁盘","tool_calls":[{"id":"call-1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"df -h\"}"}}]},"finish_reason":"tool_calls"}]}"#;
        let (text, calls) = extract_agent_completion(raw).unwrap();

        assert_eq!(text, "看下磁盘");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "run_command");
        assert_eq!(calls[0].arguments, r#"{"command":"df -h"}"#);
    }

    #[test]
    fn normalizes_object_arguments_in_non_stream_response() {
        let raw = r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call-1","function":{"name":"run_command","arguments":{"command":"df -h"}}}]}}]}"#;
        let (text, calls) = extract_agent_completion(raw).unwrap();

        assert_eq!(text, "");
        assert_eq!(calls.len(), 1);
        let parsed = serde_json::from_str::<Value>(&calls[0].arguments).unwrap();
        assert_eq!(
            parsed.pointer("/command").and_then(Value::as_str),
            Some("df -h")
        );
    }

    #[test]
    fn falls_back_to_chat_answer_when_no_tool_calls() {
        let raw = r#"{"choices":[{"message":{"content":"任务完成：磁盘已清理"}}]}"#;
        let (text, calls) = extract_agent_completion(raw).unwrap();

        assert_eq!(text, "任务完成：磁盘已清理");
        assert!(calls.is_empty());
        assert!(extract_agent_completion("   ").is_err());
    }

    #[test]
    fn rejects_overlong_task_turns() {
        let request = agent_request(vec![AiAgentTurn::ToolResult {
            tool_call_id: "call-1".into(),
            content: "x".repeat(MAX_AGENT_TURN_CHARS + 1),
        }]);
        let error = validate_agent_turn_request(&request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("任务轮次过长"));

        let within_budget = agent_request(vec![AiAgentTurn::Assistant {
            text: "x".repeat(MAX_AGENT_TURN_CHARS),
            tool_calls: Vec::new(),
        }]);
        assert!(validate_agent_turn_request(&within_budget).is_ok());
    }

    #[test]
    fn validates_agent_turn_request_fields() {
        let mut request = agent_request(Vec::new());
        request.config.base_url = "  ".into();
        let error = validate_agent_turn_request(&request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Base URL"));

        let mut request = agent_request(Vec::new());
        request.config.model = String::new();
        let error = validate_agent_turn_request(&request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Model"));

        let mut request = agent_request(Vec::new());
        request.api_key = " ".into();
        let error = validate_agent_turn_request(&request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("API Key"));

        let mut request = agent_request(Vec::new());
        request.goal = "\n".into();
        let error = validate_agent_turn_request(&request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("任务目标不能为空"));
    }

    #[test]
    fn prepends_tools_unsupported_hint_for_tool_related_errors() {
        let raw = r#"{"error":{"message":"Unknown parameter: 'tools' is not supported"}}"#;
        let detail = agent_model_error_detail(raw);
        assert!(detail.starts_with(TOOLS_UNSUPPORTED_HINT));
        assert!(detail.contains("Unknown parameter"));

        let upper = r#"{"error":{"message":"FUNCTION calling disabled"}}"#;
        assert!(agent_model_error_detail(upper).starts_with(TOOLS_UNSUPPORTED_HINT));

        let unrelated = r#"{"error":{"message":"bad key"}}"#;
        assert_eq!(agent_model_error_detail(unrelated), "bad key");
    }

    #[test]
    fn serializes_agent_turns_with_camel_case_tags() {
        let assistant = AiAgentTurn::Assistant {
            text: "查看磁盘".into(),
            tool_calls: vec![tool_call("call-1", r#"{"command":"df -h"}"#)],
        };
        let value = serde_json::to_value(&assistant).unwrap();
        assert_eq!(value.get("kind").and_then(Value::as_str), Some("assistant"));
        assert_eq!(
            value.pointer("/toolCalls/0/id").and_then(Value::as_str),
            Some("call-1")
        );

        let result = AiAgentTurn::ToolResult {
            tool_call_id: "call-1".into(),
            content: SKIPPED_TOOL_RESULT_CONTENT.into(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            value.get("kind").and_then(Value::as_str),
            Some("toolResult")
        );
        assert_eq!(
            value.get("toolCallId").and_then(Value::as_str),
            Some("call-1")
        );

        for turn in [assistant, result] {
            let roundtrip =
                serde_json::from_str::<AiAgentTurn>(&serde_json::to_string(&turn).unwrap())
                    .unwrap();
            assert_eq!(roundtrip, turn);
        }
    }
}
