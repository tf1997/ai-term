use anyhow::{bail, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::OperationKind;

pub const CAPTURE_PROBE_SOURCE: &str = "(printf 'AI_TERM_CAPTURE_OK\\n'; exit 7)";
pub const BRACKETED_CAPTURE_PROBE_SOURCE: &str =
    "printf 'AI_TERM_MULTILINE_FIRST\\n'\nprintf 'AI_TERM_CAPTURE_OK\\n'\n(exit 7)";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    #[default]
    None,
    Markers,
    Bracketed,
    Sentinel,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTransport {
    pub kind: CaptureKind,
    pub nonce: String,
    pub internal: bool,
}

impl CaptureTransport {
    pub fn new(kind: CaptureKind, internal: bool) -> Self {
        Self {
            kind,
            nonce: uuid::Uuid::new_v4().simple().to_string(),
            internal,
        }
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn shell_eval(source: &str) -> String {
    let program = format!("eval {}", shell_quote(source));
    if !source.contains(['\n', '\r', '\t']) {
        return program;
    }
    // Quoting alone does not protect literal newlines/tabs from the interactive
    // line editor. Decode them inside the shell after submitting one input line.
    // Escape existing backslashes first so printf %b cannot interpret source
    // escapes (including \c) or change quoted data. eval stays in the current
    // shell, preserving cwd/export and the command's exit status.
    // Encode the quoted eval program, whose last byte is a quote: command
    // substitution must not strip meaningful trailing newlines from the source.
    let escaped = program
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("eval \"$(command printf '%b' {})\"", shell_quote(&escaped))
}

fn internal_history_guard(nonce: &str) -> String {
    format!("if [ -n \"${{BASH_VERSION-}}\" ]; then case \"$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)\" in *'AI_TERM_INTERNAL_{nonce}'*) builtin history -d \"$(HISTTIMEFORMAT= builtin history 1 2>/dev/null | command awk 'NR == 1 && $1 ~ /^[0-9]+$/ {{ print $1 }}')\" 2>/dev/null || : ;; esac; fi")
}

pub fn render_transport(
    source: &str,
    operation: OperationKind,
    capture: &CaptureTransport,
) -> String {
    if capture.internal && capture.kind == CaptureKind::Bracketed {
        // A fixed multiline input exercises the real line editor. No eval or
        // grouping can make an unbracketed editor look batch-capable. Leading
        // space follows the existing internal-history convention.
        let nonce = &capture.nonce;
        let guard = internal_history_guard(nonce);
        let input = format!(" {guard}; printf '\\nAI_TERM_PROBE_BEGIN_{nonce}\\n'; printf '\\n__AI_TERM_%s__\\n' {nonce}B; printf '\\nAI_TERM_MULTILINE_FIRST\\n'\nprintf '\\nAI_TERM_CAPTURE_OK\\n'\nprintf '\\n__AI_TERM_%s__:7\\n' {nonce}E; printf '\\nAI_TERM_PROBE_END_{nonce}\\n'; (exit 7)");
        return format!("\x1b[200~{input}\x1b[201~\r");
    }
    let mut command = match operation {
        OperationKind::Command => source.to_owned(),
        OperationKind::BashScript => {
            let payload = base64::engine::general_purpose::STANDARD.encode(source.as_bytes());
            format!("if command -v base64 >/dev/null 2>&1; then printf '%s' '{payload}' | (base64 --decode 2>/dev/null || base64 -D 2>/dev/null) | bash; else printf '%s\\n' 'AI Term: base64 decoder not found' >&2; fi")
        }
    };
    if capture.kind == CaptureKind::Sentinel {
        // Quoted eval keeps cwd/export in the current shell and prevents a
        // trailing comment, semicolon or multiline body swallowing the footer.
        // Both the source and transport are fixed before approval.
        let nonce = &capture.nonce;
        command = format!("printf '\\n__AI_TERM_%s__\\n' {nonce}B; {}; printf '\\n__AI_TERM_%s__:%d\\n' {nonce}E $?", shell_eval(&command));
    }
    if capture.internal {
        let nonce = &capture.nonce;
        let body = format!("printf '\\nAI_TERM_PROBE_BEGIN_{nonce}\\n'; {command}; printf '\\nAI_TERM_PROBE_END_{nonce}\\n'");
        let guard = internal_history_guard(nonce);
        command = format!(" {guard}; {}", shell_eval(&body));
        // Validate the actual shell's nonzero completion marker too. The two
        // framing printf calls otherwise mask the probe's status with zero.
        if source == CAPTURE_PROBE_SOURCE {
            command.push_str("; (exit 7)");
        }
    }
    if capture.kind == CaptureKind::Bracketed {
        format!("\x1b[200~{command}\x1b[201~\r")
    } else {
        format!("{command}\r")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum InternalProbe {
    Capture {},
    BracketedCapture {},
    Context {},
    ShellIntegration {},
    FileSnapshot {
        paths: Vec<String>,
        nonce: String,
    },
    #[serde(skip_deserializing)]
    FileReader {
        request: crate::domain::filesystem::agent_files::TerminalFileRequest,
    },
}

impl InternalProbe {
    pub fn source(&self) -> Result<String> {
        match self {
            Self::FileReader { request } => Ok(request.source()),
            Self::Capture {} => Ok(CAPTURE_PROBE_SOURCE.into()),
            Self::BracketedCapture {} => Ok(BRACKETED_CAPTURE_PROBE_SOURCE.into()),
            Self::ShellIntegration {} => Ok(crate::domain::terminal::shell_integration::session_integration_source()),
            Self::Context {} => Ok(r#"( command -v base64 >/dev/null 2>&1 || exit 1
if [ -n "${BASH_VERSION-}" ]; then printf 'bash\n'; elif [ -n "${ZSH_VERSION-}" ]; then printf 'zsh\n'; else printf 'unknown\n'; fi
pwd -P | base64
printf '\nAI_TERM_CONTEXT_USER\n'
id -u | base64
printf '\nAI_TERM_CONTEXT_SCOPE\n'
{ hostname; id -u; ls -id /; readlink /proc/self/ns/mnt 2>/dev/null || :; } | base64
printf '\nAI_TERM_CONTEXT_END\n'
)"#.into()),
            Self::FileSnapshot { paths, nonce } => {
                if paths.is_empty() || paths.len() > 100 || nonce.is_empty() || nonce.len() > 80 || !nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                    bail!("无效的文件快照请求");
                }
                for path in paths {
                    if !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control) || path.split('/').any(|part| matches!(part, "." | "..")) || sensitive_snapshot_path(path) {
                        bail!("文件快照需要明确且非敏感的绝对路径");
                    }
                }
                Ok(include_str!("file_snapshot.sh")
                    .replace("@TAG@", &format!("AI_TERM_SNAPSHOT_{nonce}"))
                    .replace("@PATHS@", &paths.iter().map(|p| shell_quote(p)).collect::<Vec<_>>().join(" ")))
            }
        }
    }
}

fn sensitive_snapshot_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    [".pem", ".key", ".p12", ".pfx", ".jks", ".keychain-db"]
        .iter()
        .any(|suffix| base.ends_with(suffix))
        || [
            "/.ssh/",
            "/.aws/",
            "/.kube/",
            "/.docker/",
            "/library/keychains/",
        ]
        .iter()
        .any(|part| lower.contains(part))
        || lower.split('/').any(|part| {
            part == ".env"
                || part.starts_with(".env.")
                || ["shadow", "gshadow", "sudoers"]
                    .iter()
                    .any(|name| part.starts_with(name))
        })
        || [
            ".netrc",
            ".npmrc",
            ".pypirc",
            "login data",
            "logins.json",
            "cookies",
        ]
        .contains(&base)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn one_line_eval_preserves_a_trailing_line_continuation() {
        for program in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(program).exists() {
                continue;
            }
            let output = std::process::Command::new(program)
                .args(["-c", &shell_eval("printf '<%s>' \\\n")])
                .output()
                .unwrap();
            assert!(output.status.success(), "{program}");
            assert_eq!(
                output.stdout, b"<>",
                "{program}: the final newline cannot be stripped"
            );
        }
    }

    #[test]
    fn one_line_eval_preserves_multiline_data_and_current_shell_state() {
        // The printf transport must preserve literal escapes, quotes, tabs,
        // substitutions and heredoc data without executing them while decoding.
        let source = "AI_TERM_TRANSPORT_VALUE=kept\ncd /\nprintf '%s\\n' '\\c \\n \\\\ 中文' \"$(printf substitution)\"\ncat <<'EOF'\nquote '\" $HOME `printf unwanted`\n\tindented\nEOF\n(exit 7)\n";
        for program in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(program).exists() {
                continue;
            }
            let encoded = shell_eval(source);
            assert!(!encoded.contains(['\n', '\r', '\t']));
            let run = |body: String| {
                std::process::Command::new(program)
                .args(["-c", &format!("{body}; rc=$?; printf 'STATE:%s:%s\\n' \"$PWD\" \"$AI_TERM_TRANSPORT_VALUE\"; exit $rc")])
                .output().unwrap()
            };
            let expected = run(format!("eval {}", shell_quote(source)));
            let actual = run(encoded);
            assert_eq!(actual.status.code(), Some(7), "{program}");
            assert_eq!(actual.stdout, expected.stdout, "{program}");
            assert_eq!(actual.stderr, expected.stderr, "{program}");
        }
    }
}
