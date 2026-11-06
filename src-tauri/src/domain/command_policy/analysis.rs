use std::ops::ControlFlow;
use std::time::{Duration, Instant};

use tree_sitter::{Node, ParseOptions, Parser};

use super::rules;
use super::{
    AnalysisIssue, AnalysisStatus, CommandAnalysis, CommandRisk, Decision, RiskKind, RiskSeverity,
    ShellDialect, SourceRange, POLICY_VERSION,
};

#[derive(Clone, Copy)]
pub struct AnalysisBudget {
    pub max_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub timeout: Duration,
}

impl Default for AnalysisBudget {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024,
            max_depth: 32,
            max_nodes: 32_768,
            timeout: Duration::from_millis(50),
        }
    }
}

#[derive(Clone)]
pub(super) struct Word {
    pub value: Option<String>,
    pub range: SourceRange,
    // Maps decoded UTF-8 bytes back to the original (outermost) command.
    pub origins: Vec<usize>,
}

pub(super) struct Analyzer<'a> {
    pub root: &'a str,
    pub result: CommandAnalysis,
    budget: AnalysisBudget,
    deadline: Instant,
    nodes: usize,
    positions: Vec<(usize, usize)>,
    shell: ShellDialect,
}

pub fn analyze_command(
    source: &str,
    shell: ShellDialect,
    budget: AnalysisBudget,
) -> CommandAnalysis {
    let mut analyzer = Analyzer {
        root: source,
        result: CommandAnalysis {
            analysis_status: AnalysisStatus::Complete,
            decision: Decision::Allow,
            risks: Vec::new(),
            unknown_reasons: Vec::new(),
            highest_severity: None,
            policy_version: POLICY_VERSION.into(),
        },
        budget,
        deadline: Instant::now() + budget.timeout,
        nodes: 0,
        positions: Vec::new(),
        shell,
    };
    let range = SourceRange::new(source, 0, source.len());
    if source.len() > budget.max_bytes {
        analyzer.unknown(
            "input-limit",
            "命令超过分析字节上限，请提供可完整审查的命令。",
            range,
        );
        analyzer.result.decision = Decision::Deny;
        return analyzer.result;
    }
    if source
        .bytes()
        .any(|b| (b < 0x20 && !matches!(b, b'\n' | b'\t')) || b == 0x7f)
    {
        analyzer.unknown(
            "terminal-control",
            "命令包含终端控制字符或回车，不能作为完整命令派发。",
            range,
        );
        analyzer.result.decision = Decision::Deny;
        return analyzer.result;
    }
    if !matches!(shell, ShellDialect::Bash | ShellDialect::Posix) {
        analyzer.unknown(
            "unsupported-shell",
            "尚未完整支持该 Shell 方言，不能套用 Bash 分析结果自动放行。",
            range.clone(),
        );
        // Never present a Bash partial tree as analysis of PowerShell/cmd/zsh.
        return analyzer.result;
    }
    if source.trim().is_empty() {
        analyzer.unknown("empty-command", "命令为空。", range);
        analyzer.result.decision = Decision::Deny;
        return analyzer.result;
    }
    let origins: Vec<usize> = (0..source.len()).collect();
    // Precompute once: long single-line commands must not rescan their entire
    // UTF-8 prefix for every AST node merely to produce display columns.
    let (mut line, mut column) = (1, 1);
    for character in source.chars() {
        analyzer
            .positions
            .extend(std::iter::repeat_n((line, column), character.len_utf8()));
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += character.len_utf16();
        }
    }
    analyzer.positions.push((line, column));
    analyzer.parse(source, &origins, 0);
    if Instant::now() >= analyzer.deadline {
        analyzer.unknown(
            "time-limit",
            "命令分析超时，结果不完整。",
            SourceRange::new(source, 0, source.len()),
        );
    }
    analyzer.result
}

impl Analyzer<'_> {
    pub(super) fn unknown(&mut self, code: &str, message: &str, range: SourceRange) {
        self.result.analysis_status = AnalysisStatus::Unknown;
        if self.result.decision != Decision::Deny {
            self.result.decision = Decision::Ask;
        }
        if self.result.unknown_reasons.len() < 128
            && !self
                .result
                .unknown_reasons
                .iter()
                .any(|r| r.code == code && r.range == range)
        {
            self.result.unknown_reasons.push(AnalysisIssue {
                code: code.into(),
                message: message.into(),
                range,
            });
        }
    }

    pub(super) fn risk(
        &mut self,
        rule: &str,
        kind: RiskKind,
        severity: RiskSeverity,
        message: &str,
        range: SourceRange,
        targets: Vec<String>,
    ) {
        self.result.highest_severity = self.result.highest_severity.max(Some(severity));
        if self.result.decision != Decision::Deny {
            self.result.decision = Decision::Ask;
        }
        if self.result.risks.len() >= 256 {
            self.unknown(
                "finding-limit",
                "风险条目超过展示预算，需要拆分审查。",
                range,
            );
            return;
        }
        self.result.risks.push(CommandRisk {
            rule_id: rule.into(),
            kind,
            severity,
            message: message.into(),
            range,
            targets,
        });
    }

    fn within_budget(&mut self, depth: usize, range: SourceRange) -> bool {
        self.nodes += 1;
        let (code, message) = if depth > self.budget.max_depth {
            ("depth-limit", "命令嵌套超过分析深度上限。")
        } else if self.nodes > self.budget.max_nodes {
            ("node-limit", "命令语法结构超过分析预算。")
        } else if Instant::now() >= self.deadline {
            ("time-limit", "命令分析超时，结果不完整。")
        } else {
            return true;
        };
        self.unknown(code, message, range);
        false
    }

    pub(super) fn parse(&mut self, source: &str, origins: &[usize], depth: usize) {
        let range = self.range(origins, 0, source.len());
        if !self.within_budget(depth, range.clone()) {
            return;
        }
        let mut parser = Parser::new();
        if parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .is_err()
        {
            self.unknown("parser-unavailable", "Shell 语法分析器不可用。", range);
            return;
        }
        let deadline = self.deadline;
        let mut progress = |_: &tree_sitter::ParseState| {
            if Instant::now() >= deadline {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let bytes = source.as_bytes();
        let tree = parser.parse_with_options(
            &mut |offset, _| bytes.get(offset..).unwrap_or(&[]),
            None,
            Some(ParseOptions::new().progress_callback(&mut progress)),
        );
        let Some(tree) = tree else {
            self.unknown("parse-incomplete", "语法分析未完成或超时。", range);
            return;
        };
        if tree.root_node().has_error() {
            self.unknown("invalid-syntax", "命令包含无效或尚未支持的语法。", range);
        }
        self.walk(tree.root_node(), source, origins, depth);
    }

    fn walk(&mut self, node: Node<'_>, source: &str, origins: &[usize], depth: usize) {
        let range = self.range(origins, node.start_byte(), node.end_byte());
        if !self.within_budget(depth, range.clone()) {
            return;
        }
        if self.shell == ShellDialect::Posix
            && matches!(
                node.kind(),
                "array" | "herestring_redirect" | "c_style_for_statement" | "ansi_c_string"
            )
        {
            self.unknown(
                "non-posix-syntax",
                "该语法不属于已支持的 POSIX 子集。",
                range.clone(),
            );
        }
        match node.kind() {
            "command" => {
                let mut parts = Vec::new();
                if let Some(name) = node.child_by_field_name("name") {
                    parts.push(name);
                }
                let mut cursor = node.walk();
                parts.extend(node.children_by_field_name("argument", &mut cursor));
                let mut words: Vec<Word> = Vec::new();
                let mut previous_end = 0;
                for part in parts {
                    let word = self.word(part, source, origins);
                    let gap = source.get(previous_end..part.start_byte()).unwrap_or("");
                    // The Bash grammar treats an escaped newline as an extra,
                    // even inside r\\\nm. Bash removes it before tokenization.
                    // Merge only AST words separated exclusively by that extra;
                    // quoted strings remain intact and keep their own semantics.
                    if !words.is_empty() && !gap.is_empty() && gap.replace("\\\n", "").is_empty() {
                        let previous = words.last_mut().expect("nonempty words");
                        previous.value = previous
                            .value
                            .as_ref()
                            .zip(word.value.as_ref())
                            .map(|(a, b)| format!("{a}{b}"));
                        previous.origins.extend(word.origins);
                        previous.range = SourceRange::new(
                            self.root,
                            previous.range.start_byte,
                            word.range.end_byte,
                        );
                    } else {
                        words.push(word);
                    }
                    previous_end = part.end_byte();
                }
                if words.iter().any(|w| w.value.is_none()) {
                    self.unknown(
                        "dynamic-word",
                        "命令名或参数由运行时展开决定，需要逐次确认。",
                        range.clone(),
                    );
                    self.risk(
                        "execution.dynamic-word",
                        RiskKind::Execution,
                        RiskSeverity::High,
                        "展开后的命令或参数需要逐次审查。",
                        range.clone(),
                        vec![],
                    );
                }
                rules::analyze_words(self, &words, depth);
            }
            "file_redirect" => self.redirect(node, source, origins),
            "variable_assignment" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let name = &source[name.byte_range()];
                    if matches!(
                        name,
                        "PATH" | "IFS" | "ENV" | "BASH_ENV" | "SHELLOPTS" | "PS4"
                    ) || name.starts_with("LD_")
                        || name.starts_with("DYLD_")
                    {
                        self.risk(
                            "execution.environment",
                            RiskKind::Execution,
                            RiskSeverity::High,
                            "环境赋值可能改变执行程序或加载额外代码。",
                            range.clone(),
                            vec![name.into()],
                        );
                        self.unknown(
                            "execution-environment",
                            "无法静态确定环境赋值后的实际执行内容。",
                            range.clone(),
                        );
                    }
                }
            }
            "command_substitution" | "process_substitution" => {
                self.unknown(
                    "substitution",
                    "运行时替换会执行内层命令并改变外层参数。",
                    range.clone(),
                );
                self.risk(
                    "execution.substitution",
                    RiskKind::Execution,
                    RiskSeverity::High,
                    "需要检查内层执行及展开后的参数。",
                    range.clone(),
                    vec![],
                );
            }
            "function_definition" | "declaration_command" | "unset_command" => {
                self.unknown(
                    "shell-state",
                    "该结构会定义或改变 Shell 状态，影响后续执行。",
                    range.clone(),
                );
            }
            "for_statement" | "while_statement" | "c_style_for_statement" => {
                self.unknown(
                    "loop-control",
                    "循环的执行次数和后续状态无法静态确定。",
                    range.clone(),
                );
            }
            "arithmetic_expansion"
            | "arithmetic_command"
            | "test_command"
            | "subscript"
            | "expansion"
            | "simple_expansion"
            | "ansi_c_string" => {
                self.unknown(
                    "runtime-expansion",
                    "该展开结构的完整运行时语义尚未确定。",
                    range.clone(),
                );
            }
            "ERROR" => self.unknown("invalid-syntax", "此处语法不完整。", range.clone()),
            _ => {}
        }
        // Literal and heredoc data are never reparsed as commands. Executable
        // substitutions inside them are already explicit named AST children.
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.nodes > self.budget.max_nodes || Instant::now() >= self.deadline {
                break;
            }
            self.walk(child, source, origins, depth + 1);
        }
    }

    fn redirect(&mut self, node: Node<'_>, source: &str, origins: &[usize]) {
        let range = self.range(origins, node.start_byte(), node.end_byte());
        let mut cursor = node.walk();
        let operator = node
            .children(&mut cursor)
            .find(|n| matches!(n.kind(), ">" | ">>" | ">|" | "&>" | "&>>" | "<>" | ">&"))
            .map(|n| n.kind());
        let Some(operator) = operator else {
            return;
        };
        let Some(destination) = node.child_by_field_name("destination") else {
            self.unknown("redirect-target", "重定向目标无法确定。", range);
            return;
        };
        let target = self.word(destination, source, origins);
        let Some(value) = target.value else {
            self.unknown(
                "redirect-target",
                "写入目标由运行时展开决定。",
                range.clone(),
            );
            self.risk(
                "edit.redirect",
                RiskKind::Edit,
                RiskSeverity::High,
                "输出可能覆盖未知文件。",
                range,
                vec![],
            );
            return;
        };
        if value == "/dev/null"
            || (operator == ">&" && (value == "-" || value.chars().all(|c| c.is_ascii_digit())))
        {
            return;
        }
        let system = rules::is_system_path(&value);
        self.risk(
            "edit.redirect",
            RiskKind::Edit,
            if system {
                RiskSeverity::High
            } else {
                RiskSeverity::Medium
            },
            "重定向会创建或覆盖文件。",
            range,
            vec![value],
        );
    }

    fn word(&self, node: Node<'_>, source: &str, origins: &[usize]) -> Word {
        let range = self.range(origins, node.start_byte(), node.end_byte());
        let decoded = decode_literal(node, source, origins);
        Word {
            value: decoded.as_ref().map(|(v, _)| v.clone()),
            range,
            origins: decoded.map(|(_, o)| o).unwrap_or_default(),
        }
    }

    fn range(&self, origins: &[usize], start: usize, end: usize) -> SourceRange {
        let start = origins.get(start).copied().unwrap_or(self.root.len());
        let end = if end == 0 {
            start
        } else {
            origins.get(end - 1).map(|p| p + 1).unwrap_or(start)
        };
        let end = end.max(start);
        let (start_line, start_column) = self.positions[start];
        let (end_line, end_column) = self.positions[end];
        SourceRange {
            start_byte: start,
            end_byte: end,
            start_line,
            start_column,
            end_line,
            end_column,
        }
    }
}

pub(super) fn decode_literal(
    node: Node<'_>,
    source: &str,
    origins: &[usize],
) -> Option<(String, Vec<usize>)> {
    match node.kind() {
        "command_name" | "concatenation" => {
            let mut value = String::new();
            let mut map = Vec::new();
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                let (part, positions) = decode_literal(child, source, origins)?;
                value.push_str(&part);
                map.extend(positions);
            }
            Some((value, map))
        }
        "raw_string" => Some((
            source[node.start_byte() + 1..node.end_byte() - 1].into(),
            origins[node.start_byte() + 1..node.end_byte() - 1].to_vec(),
        )),
        "string" => {
            let mut cursor = node.walk();
            if node
                .named_children(&mut cursor)
                .any(|n| n.kind() != "string_content")
            {
                return None;
            }
            decode_escapes(
                source,
                origins,
                node.start_byte() + 1,
                node.end_byte() - 1,
                true,
            )
        }
        "word" | "number" | "string_content" => {
            decode_escapes(source, origins, node.start_byte(), node.end_byte(), false)
        }
        _ => None,
    }
}

fn decode_escapes(
    source: &str,
    origins: &[usize],
    start: usize,
    end: usize,
    double: bool,
) -> Option<(String, Vec<usize>)> {
    let bytes = source.as_bytes();
    let mut value = Vec::new();
    let mut map = Vec::new();
    let mut index = start;
    while index < end {
        if bytes[index] == b'\\' {
            if index + 1 >= end {
                return None;
            }
            if bytes[index + 1] == b'\n' {
                index += 2;
                continue;
            }
            if !double || matches!(bytes[index + 1], b'$' | b'`' | b'"' | b'\\') {
                index += 1;
            }
        } else if (double
            && bytes[index] == b'!'
            && index + 1 < end
            && !matches!(bytes[index + 1], b' ' | b'\t' | b'\n' | b'=' | b'(' | b'"'))
            || (!double && matches!(bytes[index], b'$' | b'`' | b'*' | b'?' | b'[' | b'~' | b'!'))
        {
            return None;
        }
        value.push(bytes[index]);
        map.push(origins[index]);
        index += 1;
    }
    Some((String::from_utf8(value).ok()?, map))
}
