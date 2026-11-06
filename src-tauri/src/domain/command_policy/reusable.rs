//! Draft material derived from a live, reviewed command. This conveys no
//! approval. Secrets are replaced before the material can enter a checkpoint.
use std::ops::ControlFlow;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tree_sitter::{Node, ParseOptions, Parser};

use super::analysis::decode_literal;
use super::transport::shell_quote;
use super::{AnalysisBudget, ShellDialect};

pub const EXPORT_SECRET_PREFIX: &str = "AI_TERM_EXPORT_SECRET_";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandScriptSecret {
    pub variable: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandScriptSource {
    pub version: u8,
    pub shell: ShellDialect,
    pub source: String,
    pub secrets: Vec<CommandScriptSecret>,
}

#[derive(Clone, Debug, Default)]
pub struct CommandExportAnalysis {
    pub sensitive: bool,
    pub source: Option<CommandScriptSource>,
}

fn secret_name(name: &str) -> bool {
    let name = name
        .trim_start_matches('-')
        .to_ascii_lowercase()
        .replace(['_', '-'], "");
    name.contains("password")
        || name.contains("passwd")
        || name.contains("secret")
        || name.ends_with("token")
        || name.ends_with("apikey")
        || name.ends_with("privatekey")
        || name == "authorization"
}

fn credential_url(value: &str) -> bool {
    value.split_once("://").is_some_and(|(_, rest)| {
        rest.split('/')
            .next()
            .and_then(|authority| authority.split_once('@'))
            .is_some_and(|(login, _)| login.contains(':'))
    })
}

fn potential_secret(value: &str) -> bool {
    let lower = value
        .to_ascii_lowercase()
        .replace("\\\n", "")
        .replace(['\'', '"'], "");
    lower.contains("private key-----")
        || lower.contains("authorization:")
        || credential_url(&lower)
        || lower
            .split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '{' | '}'))
            .any(|part| {
                part.split_once(['=', ':'])
                    .is_some_and(|(name, _)| secret_name(name))
                    || part.starts_with("--") && secret_name(part.split('=').next().unwrap_or(part))
            })
}

struct Mask {
    start: usize,
    end: usize,
    prefix: String,
    label: String,
    value: Option<String>,
    comment: bool,
}

struct Slot {
    start: usize,
    end: usize,
    value: String,
}

/// Complete Bash/POSIX syntax may be copied even when execution needs manual
/// review. Unsupported syntax and unhandled sensitive data yield no draft.
pub fn analyze_reusable_command(source: &str, shell: ShellDialect) -> CommandExportAnalysis {
    let mut sensitive = potential_secret(source);
    let no_source = |sensitive| CommandExportAnalysis {
        sensitive,
        source: None,
    };
    let budget = AnalysisBudget::default();
    if source.trim().is_empty()
        || source.len() > budget.max_bytes
        || !matches!(shell, ShellDialect::Bash | ShellDialect::Posix)
        || source.contains(EXPORT_SECRET_PREFIX)
        || source.contains("__AI_TERM_PARAM_")
        || source.contains("_ai_term_")
        || source
            .bytes()
            .any(|c| (c < 0x20 && !matches!(c, b'\n' | b'\t')) || c == 0x7f)
    {
        return no_source(sensitive);
    }
    let deadline = Instant::now() + budget.timeout;
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return no_source(sensitive);
    }
    let mut progress = |_: &tree_sitter::ParseState| {
        if Instant::now() >= deadline {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let Some(tree) = parser.parse_with_options(
        &mut |byte, _| source.as_bytes().get(byte..).unwrap_or_default(),
        None,
        Some(ParseOptions::new().progress_callback(&mut progress)),
    ) else {
        return no_source(sensitive);
    };
    if tree.root_node().has_error() {
        return no_source(sensitive);
    }
    let origins: Vec<_> = (0..source.len()).collect();
    let literal = |node: Node<'_>| decode_literal(node, source, &origins).map(|(value, _)| value);
    let mut masks = Vec::new();
    let mut slots = Vec::new();
    let mut special = Vec::new();
    let mut audit = Vec::new();
    let mut stack = vec![(tree.root_node(), 0)];
    let mut count = 0;
    let mut unavailable = false;
    while let Some((node, depth)) = stack.pop() {
        count += 1;
        if count > budget.max_nodes || depth > budget.max_depth || Instant::now() >= deadline {
            return no_source(sensitive);
        }
        // Audit all literal contexts, including assignments, interpreter source,
        // redirection paths and fragments that are not ordinary arguments.
        if matches!(
            node.kind(),
            "word" | "string" | "raw_string" | "concatenation" | "ansi_c_string" | "heredoc_body"
        ) {
            let value = literal(node).unwrap_or_else(|| source[node.byte_range()].into());
            sensitive |= potential_secret(&value);
            audit.push(Slot {
                start: node.start_byte(),
                end: node.end_byte(),
                value,
            });
        }
        match node.kind() {
            "comment" => masks.push(Mask {
                start: node.start_byte(),
                end: node.end_byte(),
                prefix: String::new(),
                label: String::new(),
                value: None,
                comment: true,
            }),
            "variable_assignment" => {
                if let (Some(name), Some(value)) = (
                    node.child_by_field_name("name"),
                    node.child_by_field_name("value"),
                ) {
                    let name = source[name.byte_range()].replace("\\\n", "");
                    if secret_name(&name) {
                        sensitive = true;
                        if value.kind() == "array" {
                            unavailable = true;
                        }
                        masks.push(Mask {
                            start: value.start_byte(),
                            end: value.end_byte(),
                            prefix: String::new(),
                            label: format!(
                                "环境变量 {}",
                                name.chars().take(64).collect::<String>()
                            ),
                            value: literal(value),
                            comment: false,
                        });
                    }
                }
            }
            "command" => {
                let head = node
                    .child_by_field_name("name")
                    .and_then(&literal)
                    .unwrap_or_default();
                let head = head.rsplit('/').next().unwrap_or(&head);
                if [
                    "alias", "unalias", "bind", "fg", "bg", "jobs", "disown", "read", "stty",
                    "exit", "exec", "return", "trap",
                ]
                .contains(&head)
                {
                    unavailable = true;
                }
                let mut cursor = node.walk();
                let args: Vec<_> = node
                    .children_by_field_name("argument", &mut cursor)
                    .collect();
                let values: Vec<_> = args.iter().map(|node| literal(*node)).collect();
                // Credential CLIs may be behind command/sudo/env wrappers. A
                // static CLI token is enough for conservative redaction; this
                // does not infer that the wrapper itself is safe to execute.
                let credential_cli = ["curl", "sshpass", "mysql", "mariadb", "redis-cli"];
                let credential_head = if credential_cli.contains(&head) {
                    head
                } else {
                    values
                        .iter()
                        .flatten()
                        .map(|value| value.rsplit('/').next().unwrap_or(value))
                        .find(|value| credential_cli.contains(value))
                        .unwrap_or(head)
                };
                for (index, arg) in args.iter().enumerate() {
                    if arg.kind() == "variable_assignment" {
                        continue;
                    }
                    let Some(value) = values[index].as_deref() else {
                        continue;
                    };
                    slots.push(Slot {
                        start: arg.start_byte(),
                        end: arg.end_byte(),
                        value: value.into(),
                    });
                    sensitive |= potential_secret(value);
                    let short_option = match credential_head {
                        "curl" => Some("-u"),
                        "sshpass" | "mysql" | "mariadb" => Some("-p"),
                        "redis-cli" => Some("-a"),
                        _ => None,
                    };
                    if let Some(prefix) = short_option
                        .filter(|prefix| value.starts_with(prefix) && value.len() > prefix.len())
                    {
                        sensitive = true;
                        masks.push(Mask {
                            start: arg.start_byte(),
                            end: arg.end_byte(),
                            prefix: prefix.into(),
                            label: "命令凭据参数".into(),
                            value: Some(value[prefix.len()..].into()),
                            comment: false,
                        });
                        continue;
                    }
                    let (option, attached) = value
                        .split_once('=')
                        .map_or((value, None), |(key, value)| (key, Some(value)));
                    let secret_option = value.starts_with("--") && secret_name(option)
                        || credential_head == "curl"
                            && ["-u", "--user", "--proxy-user"].contains(&option)
                        || short_option == Some(option);
                    if secret_option {
                        sensitive = true;
                        if let Some(secret) = attached {
                            masks.push(Mask {
                                start: arg.start_byte(),
                                end: arg.end_byte(),
                                prefix: format!("{option}="),
                                label: "命令凭据参数".into(),
                                value: Some(secret.into()),
                                comment: false,
                            });
                        } else if let Some(next) = args.get(index + 1) {
                            masks.push(Mask {
                                start: next.start_byte(),
                                end: next.end_byte(),
                                prefix: String::new(),
                                label: "命令凭据参数".into(),
                                value: values[index + 1].clone(),
                                comment: false,
                            });
                        } else {
                            unavailable = true;
                        }
                    } else if let Some((key, secret)) =
                        value.split_once('=').filter(|(key, _)| secret_name(key))
                    {
                        masks.push(Mask {
                            start: arg.start_byte(),
                            end: arg.end_byte(),
                            prefix: format!("{key}="),
                            label: "环境或配置凭据".into(),
                            value: Some(secret.into()),
                            comment: false,
                        });
                        sensitive = true;
                    } else if value.to_ascii_lowercase().starts_with("authorization:")
                        || value
                            .to_ascii_lowercase()
                            .starts_with("proxy-authorization:")
                        || credential_url(value)
                        || value.contains("PRIVATE KEY-----")
                    {
                        // The whole header/URL/key is external input, including
                        // its required prefix; no credential fragments survive.
                        masks.push(Mask {
                            start: arg.start_byte(),
                            end: arg.end_byte(),
                            prefix: String::new(),
                            label: "认证头、地址或密钥输入".into(),
                            value: Some(value.into()),
                            comment: false,
                        });
                        sensitive = true;
                    }
                }
            }
            "heredoc_body" | "ansi_c_string" => special.push(source[node.byte_range()].to_owned()),
            _ => {}
        }
        let mut cursor = node.walk();
        stack.extend(
            node.named_children(&mut cursor)
                .map(|child| (child, depth + 1)),
        );
    }
    let secret_values: Vec<_> = masks
        .iter()
        .filter_map(|mask| mask.value.as_deref())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if masks.iter().filter(|mask| !mask.comment).count() > 32 {
        return no_source(sensitive);
    }
    let covered = |start, end, masks: &[Mask]| {
        masks
            .iter()
            .any(|mask| mask.start <= start && mask.end >= end)
    };
    for slot in slots {
        if Instant::now() >= deadline {
            return no_source(sensitive);
        }
        if covered(slot.start, slot.end, &masks) {
            continue;
        }
        if secret_values
            .iter()
            .any(|secret| slot.value == *secret || secret.len() >= 4 && slot.value.contains(secret))
        {
            masks.push(Mask {
                start: slot.start,
                end: slot.end,
                prefix: String::new(),
                label: "重复敏感输入".into(),
                value: None,
                comment: false,
            });
        } else if potential_secret(&slot.value) {
            // Option names themselves are retained, but opaque interpreter
            // programs containing another secret are never copied as data.
            let option_only = slot.value.starts_with("--")
                && !slot.value.contains('=')
                && !slot.value.chars().any(char::is_whitespace)
                && secret_name(&slot.value);
            if !option_only {
                unavailable = true;
            }
        }
    }
    for slot in audit {
        if Instant::now() >= deadline {
            return no_source(sensitive);
        }
        if covered(slot.start, slot.end, &masks) {
            continue;
        }
        let option_only = slot.value.starts_with("--")
            && !slot.value.contains('=')
            && !slot.value.chars().any(char::is_whitespace)
            && secret_name(&slot.value);
        if potential_secret(&slot.value) && !option_only
            || secret_values.iter().any(|secret| {
                slot.value == *secret || secret.len() >= 4 && slot.value.contains(secret)
            })
        {
            unavailable = true;
        }
    }
    if special.iter().any(|text| {
        potential_secret(text) || secret_values.iter().any(|value| text.contains(value))
    }) {
        sensitive = true;
        unavailable = true;
    }
    if sensitive && source.contains("\\\n") {
        unavailable = true;
    }
    masks.sort_by_key(|mask| (mask.start, std::cmp::Reverse(mask.end)));
    let mut compact: Vec<Mask> = Vec::new();
    for mask in masks {
        if Instant::now() >= deadline {
            return no_source(sensitive);
        }
        if let Some(previous) = compact.last() {
            if previous.end >= mask.end {
                continue;
            }
            if previous.end > mask.start {
                return no_source(sensitive);
            }
        }
        compact.push(mask);
    }
    let mut secrets = Vec::new();
    let mut result = String::new();
    let mut at = 0;
    for mask in compact {
        if Instant::now() >= deadline {
            return no_source(sensitive);
        }
        result.push_str(&source[at..mask.start]);
        if !mask.comment {
            if secrets.len() >= 32 {
                return no_source(sensitive);
            }
            let variable = format!("{EXPORT_SECRET_PREFIX}{}", secrets.len() + 1);
            if !mask.prefix.is_empty() {
                result.push_str(&shell_quote(&mask.prefix));
            }
            result.push_str(&format!("\"{}{{{variable}:?请提供外部凭据}}\"", '$'));
            secrets.push(CommandScriptSecret {
                variable,
                label: mask.label,
            });
        }
        at = mask.end;
    }
    result.push_str(&source[at..]);
    if unavailable || sensitive && secrets.is_empty() {
        return no_source(sensitive);
    }
    CommandExportAnalysis {
        sensitive,
        source: Some(CommandScriptSource {
            version: 1,
            shell,
            source: result,
            secrets,
        }),
    }
}
