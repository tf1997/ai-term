use super::SshTaskRequest;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn render_command(request: &SshTaskRequest, nonce: &str) -> String {
    let env = request
        .effective_environment()
        .iter()
        .map(|(k, v)| quote(&format!("{k}={v}")))
        .collect::<Vec<_>>()
        .join(" ");
    let prefix = format!("\\036AI_TERM_SSH_{nonce}_");
    let wrapper = format!(
        "if cd {}; then printf '{prefix}START\\037' >&2; /usr/bin/env -i {env} /bin/sh -c {}; ai_term_rc=$?; printf '{prefix}EXIT:%s\\037' \"$ai_term_rc\" >&2; exit \"$ai_term_rc\"; else ai_term_rc=$?; printf '{prefix}SETUP:%s\\037' \"$ai_term_rc\" >&2; exit \"$ai_term_rc\"; fi",
        quote(&request.working_directory), quote(&request.command),
    );
    format!("exec /bin/sh -c {}", quote(&wrapper))
}

/// Only records bearing this task's unguessable nonce are removed. Pending
/// data is bounded even for arbitrary/binary stderr or an unterminated record.
pub(super) struct ExitProtocol {
    prefix: Vec<u8>,
    pending: Vec<u8>,
    pub started: bool,
    pub exit: Option<i32>,
    pub setup_failed: Option<i32>,
    pub invalid: bool,
}

impl ExitProtocol {
    pub fn new(nonce: &str) -> Self {
        Self {
            prefix: format!("\x1eAI_TERM_SSH_{nonce}_").into_bytes(),
            pending: vec![],
            started: false,
            exit: None,
            setup_failed: None,
            invalid: false,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(bytes);
        let mut output = vec![];
        loop {
            if let Some(start) = self
                .pending
                .windows(self.prefix.len())
                .position(|w| w == self.prefix)
            {
                output.extend(self.pending.drain(..start));
                let end = self.pending[self.prefix.len()..]
                    .iter()
                    .position(|b| *b == 0x1f)
                    .map(|p| p + self.prefix.len());
                match end {
                    Some(end) if end <= self.prefix.len() + 16 => {
                        let record = String::from_utf8_lossy(&self.pending[self.prefix.len()..end])
                            .into_owned();
                        if self.record(&record) {
                            self.pending.drain(..=end);
                        } else {
                            output.push(self.pending.remove(0));
                        }
                    }
                    None if self.pending.len() <= self.prefix.len() + 16 => break,
                    _ => output.push(self.pending.remove(0)),
                }
            } else {
                let keep = (1..self.prefix.len())
                    .rev()
                    .find(|&n| self.pending.ends_with(&self.prefix[..n]))
                    .unwrap_or(0);
                output.extend(self.pending.drain(..self.pending.len() - keep));
                break;
            }
        }
        output
    }

    fn record(&mut self, value: &str) -> bool {
        if value == "START" {
            self.invalid |= self.started || self.setup_failed.is_some();
            self.started = true;
            return true;
        }
        let Some((kind, code)) = value.split_once(':') else {
            return false;
        };
        let Ok(code) = code.parse::<u8>() else {
            return false;
        };
        match kind {
            "EXIT" => {
                self.invalid |= !self.started || self.exit.is_some() || self.setup_failed.is_some();
                self.exit = Some(code.into());
            }
            "SETUP" => {
                self.invalid |= self.started || self.setup_failed.is_some();
                self.setup_failed = Some(code.into());
            }
            _ => return false,
        }
        true
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

/// Stateful decoding avoids replacement characters for a UTF-8 scalar split
/// across SSH packets. Invalid sequences are replaced without unbounded carry.
#[derive(Default)]
pub(super) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn feed(&mut self, bytes: &[u8], finish: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(value) => {
                    output.push_str(value);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(
                        std::str::from_utf8(&self.pending[..valid]).expect("valid prefix"),
                    );
                    self.pending.drain(..valid);
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{fffd}');
                            self.pending.drain(..length);
                        }
                        None => {
                            if finish {
                                output.push_str(&String::from_utf8_lossy(&self.pending));
                                self.pending.clear();
                            }
                            break;
                        }
                    }
                }
            }
        }
        output
    }
}
