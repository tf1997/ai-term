use serde::Serialize;

pub const TERMINAL_DATA: &str = "terminal:data";
pub const TERMINAL_CLOSED: &str = "terminal:closed";
pub const AI_CHAT_STREAM: &str = "ai-chat:stream";

pub fn terminal_data_event_name(session_id: &str) -> String {
    format!("{TERMINAL_DATA}:{session_id}")
}

pub fn terminal_closed_event_name(session_id: &str) -> String {
    format!("{TERMINAL_CLOSED}:{session_id}")
}

pub fn ai_chat_stream_event_name(request_id: &str) -> String {
    format!("{AI_CHAT_STREAM}:{request_id}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosedEvent {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamEvent {
    pub request_id: String,
    pub kind: AiChatStreamEventKind,
    pub delta: String,
    pub error: Option<String>,
    pub context_compressed: Option<bool>,
    pub context_chars: Option<usize>,
    pub history_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiChatStreamEventKind {
    Chunk,
    Done,
    Error,
}
