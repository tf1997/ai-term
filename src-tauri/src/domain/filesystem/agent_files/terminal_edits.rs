use super::*;
use base64::Engine;
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct TerminalFileEditRequest {
    framing: TerminalFileRequest,
    payload: String,
}
impl TerminalFileEditRequest {
    pub fn from_dispatch(dispatch: &FileEditDispatch) -> FileResult<Self> {
        let p = dispatch.proposal();
        if p.provider != FileProvider::CurrentTerminal {
            return Err(FileError::new(
                FileErrorKind::InvalidRequest,
                "写入提供方与文件基线不一致",
            ));
        }
        let framing = TerminalFileRequest::inspect(p.path.clone())?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            nonce: &'a str,
            path: &'a str,
            resolved_path: &'a str,
            scope: &'a str,
            revision: &'a Option<String>,
            before_hash: Option<String>,
            after_base64: Option<String>,
            restore_attributes: &'a Option<FileEditAttributes>,
        }
        let payload = base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_vec(&Payload {
                nonce: framing.nonce(),
                path: &p.path,
                resolved_path: &p.resolved_path,
                scope: &p.environment_scope,
                revision: &p.revision,
                before_hash: p.before.as_deref().map(file_content_hash),
                after_base64: p.after.as_ref().map(|value| {
                    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
                }),
                restore_attributes: &p.restore_attributes,
            })
            .expect("serializable mutation"),
        );
        let request = Self { framing, payload };
        if request.source().len() > 196608 {
            return Err(FileError::new(
                FileErrorKind::ScanLimit,
                "文件内容和恢复元数据超过终端传输预算",
            ));
        }
        Ok(request)
    }
    pub fn source(&self) -> String {
        let script = format!(
            "__name__ = 'ai_term_file_helpers'\n{}\n{}\n{}",
            include_str!("terminal.py"),
            include_str!("terminal_metadata.py"),
            include_str!("terminal_edits.py")
        );
        let script = base64::engine::general_purpose::STANDARD.encode(script);
        // Separate argv chunks keep each argument below platform exec limits;
        // all variable bytes are base64, never shell source from the model.
        let payload = self
            .payload
            .as_bytes()
            .chunks(16000)
            .map(|chunk| format!(" '{}'", std::str::from_utf8(chunk).unwrap()))
            .collect::<String>();
        format!("command python3 -I -c 'import base64; exec(compile(base64.b64decode(\"{script}\"), \"<ai-term-edit>\", \"exec\"))'{payload}")
    }
    pub fn parse(&self, output: &str) -> FileResult<FileEditOutcome> {
        self.framing.parse(output)
    }
}
