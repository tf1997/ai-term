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

/// What a word made of literal text and plain parameter reads (`$name`,
/// `${name}`) can turn into. Reading a parameter runs nothing by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Reads {
    /// Only `$?`, `$$` or `$#`: always digits, never an option or a pattern.
    Number,
    /// Any other parameter: an arbitrary runtime string.
    Text,
}

#[derive(Clone)]
pub(super) struct Word {
    pub value: Option<String>,
    pub range: SourceRange,
    // Maps decoded UTF-8 bytes back to the original (outermost) command.
    pub origins: Vec<usize>,
    /// Set when `value` is unknown only because of plain parameter reads.
    pub reads: Option<Reads>,
    pub brace_expansion: bool,
    pub brace_values: Option<Vec<String>>,
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
            commands: Vec::new(),
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
    // Zsh shares the Bourne grammar for the constructs modeled here; its own
    // expansions are rejected word by word in `foreign_expansion`, and what
    // its line editor rewrites before parsing in `line_rewrites`. An unprobed
    // shell gets the same treatment plus the cmd/PowerShell metacharacters, so
    // only plain read-only commands can pass before the context is confirmed.
    if matches!(shell, ShellDialect::Powershell | ShellDialect::Cmd) {
        analyzer.unknown(
            "unsupported-shell",
            "尚未完整支持该 Shell 方言，不能套用 Bash 分析结果自动放行。",
            range.clone(),
        );
        // Never present a Bash partial tree as analysis of PowerShell/cmd.
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
    if analyzer.result.decision != Decision::Allow
        || analyzer.result.analysis_status != AnalysisStatus::Complete
    {
        analyzer.result.commands.clear();
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
        if depth == 0 && self.loosely_modeled_shell() {
            self.line_rewrites(tree.root_node(), source, origins);
        }
        self.walk(tree.root_node(), source, origins, depth);
    }

    /// Zsh and an unprobed shell are read through the Bourne grammar. Where
    /// the two may disagree about what runs, the command is confirmed per run.
    fn loosely_modeled_shell(&self) -> bool {
        matches!(self.shell, ShellDialect::Zsh | ShellDialect::Unknown)
    }

    /// An interactive zsh edits the typed line before parsing it, so the tree
    /// can describe text that never runs. Outside single quotes `!` starts
    /// history expansion, and `!"` is deleted, which moves every later quote.
    /// Inside double quotes zsh still expands and splits `$=x`, `$~x`, `$^x`
    /// and `$+x`, which the Bourne grammar reads as literal text.
    fn line_rewrites(&mut self, root: Node<'_>, source: &str, origins: &[usize]) {
        let bytes = source.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            let (code, message) = match (byte, bytes.get(index + 1)) {
                (b'!', Some(next)) if !matches!(next, b' ' | b'\t' | b'\n' | b'=' | b'(') => (
                    "history-expansion",
                    "当前 Shell 可能把 ! 当作历史展开并改写整条命令，需要逐次确认。",
                ),
                (b'$', Some(b'=' | b'~' | b'^' | b'+')) => (
                    "foreign-expansion",
                    "该写法在当前 Shell 中可能触发额外展开或执行，需要逐次确认。",
                ),
                _ => continue,
            };
            let single_quoted = root
                .descendant_for_byte_range(index, index + 1)
                .is_some_and(|node| node.kind() == "raw_string");
            if !single_quoted {
                let range = self.range(origins, index, index + 1);
                self.unknown(code, message, range);
            }
        }
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
        // Argument nodes that need no further walk.
        let mut skip: Vec<usize> = Vec::new();
        match node.kind() {
            "command" => {
                self.result.commands.push(source[node.byte_range()].into());
                let mut parts = Vec::new();
                if let Some(name) = node.child_by_field_name("name") {
                    parts.push(name);
                }
                let mut cursor = node.walk();
                parts.extend(node.children_by_field_name("argument", &mut cursor));
                let mut words: Vec<Word> = Vec::new();
                // The word each name or argument node ended up in.
                let mut owners: Vec<(usize, usize)> = Vec::new();
                let mut previous_end = 0;
                for part in parts {
                    if self.foreign_expansion(&source[part.byte_range()]) {
                        let part_range = self.range(origins, part.start_byte(), part.end_byte());
                        self.unknown(
                            "foreign-expansion",
                            "该写法在当前 Shell 中可能触发额外展开或执行，需要逐次确认。",
                            part_range,
                        );
                    }
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
                        // A read split by a line continuation is not modeled.
                        previous.reads = None;
                        previous.brace_expansion |= word.brace_expansion;
                        previous.brace_values = None;
                    } else {
                        words.push(word);
                    }
                    owners.push((part.id(), words.len() - 1));
                    previous_end = part.end_byte();
                }
                // `echo "exit=$?"` only prints the value it reads: that word
                // decides neither what runs nor which file is touched.
                let printed = rules::printed_operands(&words);
                let printed_reads: Vec<bool> = words
                    .iter()
                    .enumerate()
                    .map(|(index, word)| match (word.reads, printed) {
                        (Some(reads), Some((first, widest))) => index >= first && reads <= widest,
                        _ => false,
                    })
                    .collect();
                // Such a word holds nothing else to analyze.
                skip = owners
                    .into_iter()
                    .filter(|(_, word)| printed_reads[*word])
                    .map(|(id, _)| id)
                    .collect();
                if words
                    .iter()
                    .zip(&printed_reads)
                    .any(|(word, printed)| word.value.is_none() && !printed)
                {
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
                let mut variants = vec![words.clone()];
                let mut expansion_failed = false;
                for (word_index, word) in words.iter().enumerate() {
                    if !word.brace_expansion {
                        continue;
                    }
                    let Some(values) = word.brace_values.as_ref() else {
                        expansion_failed = true;
                        continue;
                    };
                    let expanded_count = variants.len().saturating_mul(values.len());
                    if expanded_count > 64 {
                        expansion_failed = true;
                        continue;
                    }
                    let mut expanded = Vec::with_capacity(expanded_count);
                    for variant in &variants {
                        for value in values {
                            let mut candidate = variant.clone();
                            candidate[word_index].value = Some(value.clone());
                            candidate[word_index].reads = None;
                            expanded.push(candidate);
                        }
                    }
                    variants = expanded;
                }
                if expansion_failed {
                    self.unknown(
                        "brace-expansion",
                        "花括号展开无法完整静态枚举，需要逐次确认。",
                        range.clone(),
                    );
                    self.risk(
                        "execution.brace-expansion",
                        RiskKind::Execution,
                        RiskSeverity::High,
                        "无法排除花括号展开改变命令或参数语义。",
                        range.clone(),
                        vec![],
                    );
                }
                let risk_count = self.result.risks.len();
                let mut expansion_requires_review = false;
                for variant in &variants {
                    let unknown_count = self.result.unknown_reasons.len();
                    rules::analyze_words(self, variant, depth);
                    if variant.iter().any(|word| word.brace_expansion)
                        && self.result.unknown_reasons[unknown_count..]
                            .iter()
                            .any(|reason| {
                                matches!(
                                    reason.code.as_str(),
                                    "unmodeled-command" | "git-operation" | "resource-operation"
                                )
                            })
                    {
                        expansion_requires_review = true;
                    }
                }
                expansion_requires_review |= self.result.risks.len() > risk_count
                    && words.iter().any(|word| word.brace_expansion);
                if expansion_requires_review {
                    self.risk(
                        "execution.brace-expansion",
                        RiskKind::Execution,
                        RiskSeverity::High,
                        "花括号展开改变了命令或参数的安全相关语义。",
                        range,
                        vec![],
                    );
                }
            }
            "file_redirect" => self.redirect(node, source, origins),
            // An interactive zsh only treats `#` as a comment when
            // INTERACTIVE_COMMENTS is set; otherwise the rest of the line runs.
            "comment" if self.loosely_modeled_shell() => {
                self.unknown(
                    "interactive-comment",
                    "当前 Shell 可能不把 # 之后的内容当作注释，其后的文本会照常执行，需要逐次确认。",
                    range.clone(),
                );
            }
            "variable_assignment" => {
                let name = node
                    .child_by_field_name("name")
                    .map(|name| source[name.byte_range()].replace("\\\n", ""));
                if !self.is_benign_environment_prefix(node, source, origins) {
                    self.risk(
                        "execution.environment",
                        RiskKind::Execution,
                        RiskSeverity::High,
                        "环境赋值可能改变命令、Shell 钩子或后续执行环境。",
                        range.clone(),
                        name.into_iter().collect(),
                    );
                    self.unknown(
                        "variable-assignment",
                        "环境赋值的执行副作用未建模，需要逐次确认。",
                        range,
                    );
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
            if skip.contains(&child.id()) {
                continue;
            }
            self.walk(child, source, origins, depth + 1);
        }
    }

    /// Zsh glob qualifiers (`file(e:'cmd':)`), `=cmd`, `^`/`#` patterns and,
    /// for an unidentified shell, cmd `%VAR%`/`^` and PowerShell `@(...)`
    /// are not Bourne syntax. Quoted text is checked too: over-asking is safe.
    fn foreign_expansion(&self, raw: &str) -> bool {
        match self.shell {
            ShellDialect::Zsh => {
                raw.starts_with('=') || raw.contains(['(', ')', '^', '#', '<', '>'])
            }
            ShellDialect::Unknown => {
                raw.starts_with('=') || raw.contains(['(', ')', '^', '#', '<', '>', '%', '@'])
            }
            _ => false,
        }
    }

    fn redirect(&mut self, node: Node<'_>, source: &str, origins: &[usize]) {
        let range = self.range(origins, node.start_byte(), node.end_byte());
        let mut cursor = node.walk();
        let operator = node
            .children(&mut cursor)
            .find(|n| {
                matches!(
                    n.kind(),
                    "<" | ">" | ">>" | ">|" | "&>" | "&>>" | "<>" | ">&"
                )
            })
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
            if operator == "<" {
                self.unknown(
                    "redirect-target",
                    "输入路径无法静态确定，可能读取敏感文件。",
                    range.clone(),
                );
                self.risk(
                    "permission.sensitive-path",
                    RiskKind::Permission,
                    RiskSeverity::High,
                    "输入重定向的目标未知，需要确认其读取权限。",
                    range,
                    vec![],
                );
                return;
            }
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
        if operator == "<" {
            let sensitive = target.brace_expansion
                && target.brace_values.as_ref().is_none_or(|values| {
                    values.iter().any(|value| rules::is_sensitive_path(value))
                })
                || rules::is_sensitive_path(&value);
            if sensitive {
                self.risk(
                    "permission.sensitive-path",
                    RiskKind::Permission,
                    RiskSeverity::High,
                    "输入重定向会读取凭据或敏感路径。",
                    target.range,
                    vec![value],
                );
            }
            return;
        }
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
        let raw = &source[node.byte_range()];
        let decoded = decode_literal(node, source, origins);
        let reads = match decoded {
            Some(_) => None,
            None => self.reads(node, source, origins).flatten(),
        };
        let brace_expansion = has_brace_list_expansion(raw);
        let brace_values = brace_expansion
            .then(|| expand_simple_brace_lists(raw))
            .flatten();
        Word {
            value: decoded.as_ref().map(|(v, _)| v.clone()),
            range,
            origins: decoded.map(|(_, o)| o).unwrap_or_default(),
            reads,
            brace_expansion,
            brace_values,
        }
    }

    fn is_benign_environment_prefix(
        &self,
        node: Node<'_>,
        source: &str,
        origins: &[usize],
    ) -> bool {
        if !matches!(
            self.shell,
            ShellDialect::Bash | ShellDialect::Posix | ShellDialect::Zsh
        ) {
            return false;
        }
        let Some(parent) = node.parent().filter(|parent| parent.kind() == "command") else {
            return false;
        };
        let Some(name) = node.child_by_field_name("name") else {
            return false;
        };
        let Some(value) = node.child_by_field_name("value") else {
            return false;
        };
        if !parent
            .child_by_field_name("name")
            .is_some_and(|command| node.end_byte() <= command.start_byte())
        {
            return false;
        }
        if !matches!(
            &source[name.byte_range()],
            "LANG" | "LC_ALL" | "LC_CTYPE" | "LC_MESSAGES"
        ) {
            return false;
        }
        decode_literal(value, source, origins).is_some()
    }

    /// `Some(None)` is a literal and `Some(Some(_))` a literal with plain
    /// parameter reads. `None` is anything else that is evaluated at runtime:
    /// substitution, arithmetic, `${x:=y}`, subscripts, globs or history
    /// expansion.
    fn reads(&self, node: Node<'_>, source: &str, origins: &[usize]) -> Option<Option<Reads>> {
        if decode_literal(node, source, origins).is_some() {
            return Some(None);
        }
        let bytes = source.as_bytes();
        match node.kind() {
            "simple_expansion" | "expansion" => self.parameter(node, source, false).map(Some),
            "concatenation" => {
                let mut reads = None;
                let mut at = node.start_byte();
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    // An unnamed piece such as a bare `$` is not modeled.
                    if child.start_byte() != at {
                        return None;
                    }
                    at = child.end_byte();
                    reads = reads.max(self.reads(child, source, origins)?);
                }
                (at == node.end_byte()).then_some(reads)
            }
            // `$"…"` is a locale translation rather than a plain string.
            "string" if bytes.get(node.start_byte()) == Some(&b'"') => {
                let mut reads = None;
                let mut at = node.start_byte() + 1;
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.kind() == "string_content" {
                        continue;
                    }
                    decode_escapes(source, origins, at, child.start_byte(), true)?;
                    reads = reads.max(Some(self.parameter(child, source, true)?));
                    at = child.end_byte();
                }
                decode_escapes(source, origins, at, node.end_byte() - 1, true)?;
                Some(reads)
            }
            _ => None,
        }
    }

    /// A bare `$name` or `${name}`: nothing edits, indexes or evaluates it.
    /// `$!` is left out because `!` also starts history expansion.
    fn parameter(&self, node: Node<'_>, source: &str, quoted: bool) -> Option<Reads> {
        // Inside a string the grammar keeps leading blanks on this node.
        let text = source[node.byte_range()].trim_start_matches([' ', '\t', '\n']);
        let name = match node.kind() {
            "simple_expansion" => text.strip_prefix('$')?,
            "expansion" => text.strip_prefix("${")?.strip_suffix('}')?,
            _ => return None,
        };
        // `!$` is history expansion in an interactive shell.
        if source[..node.end_byte() - text.len()].ends_with('!') {
            return None;
        }
        let reads = if matches!(name, "?" | "$" | "#") {
            Reads::Number
        } else if matches!(name, "@" | "*" | "-")
            || (!name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        {
            Reads::Text
        } else {
            return None;
        };
        if self.loosely_modeled_shell() {
            // Zsh evaluates a subscript or `:x` modifier that follows a bare
            // `$name`, and with GLOB_SUBST it globs an unquoted value, where a
            // `(e:…:)` qualifier runs code. `$#name` never gets here: `#` is
            // already a foreign expansion.
            let evaluated = match &source.as_bytes()[node.end_byte()..] {
                [b'[', ..] => true,
                [b':', next, ..] => next.is_ascii_alphabetic() || *next == b'&',
                _ => false,
            };
            if (node.kind() == "simple_expansion" && evaluated) || (reads == Reads::Text && !quoted)
            {
                return None;
            }
        }
        Some(reads)
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

fn has_brace_list_expansion(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut index = 0;
    let mut quote = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(current) = quote {
            if byte == b'\\' && current == b'"' {
                index += 2;
                continue;
            }
            if byte == current {
                quote = None;
            }
            index += 1;
            continue;
        }
        match byte {
            b'\\' => index += 2,
            b'\'' | b'"' => {
                quote = Some(byte);
                index += 1;
            }
            b'{' if index == 0 || bytes[index - 1] != b'$' => {
                if matching_brace_list(bytes, index).is_some() {
                    return true;
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    false
}

fn matching_brace_list(bytes: &[u8], open: usize) -> Option<(usize, usize, Vec<usize>)> {
    let mut depth = 1;
    let mut commas = Vec::new();
    let mut index = open + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'{' => {
                depth += 1;
                index += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (!commas.is_empty()).then_some((open, index, commas));
                }
                index += 1;
            }
            b',' if depth == 1 => {
                commas.push(index);
                index += 1;
            }
            _ => index += 1,
        }
    }
    None
}

fn expand_simple_brace_lists(raw: &str) -> Option<Vec<String>> {
    if raw.bytes().any(|byte| {
        matches!(
            byte,
            b'\'' | b'"' | b'\\' | b'$' | b'`' | b' ' | b'\t' | b'\n'
        )
    }) {
        return None;
    }
    expand_simple_brace_lists_inner(raw, 0)
}

fn expand_simple_brace_lists_inner(raw: &str, depth: usize) -> Option<Vec<String>> {
    if depth >= 8 {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut expansion = None;
    for open in 0..bytes.len() {
        if bytes[open] != b'{' || (open > 0 && bytes[open - 1] == b'$') {
            continue;
        }
        if let Some(found) = matching_brace_list(bytes, open) {
            expansion = Some(found);
            break;
        }
    }
    let Some((open, close, commas)) = expansion else {
        return Some(vec![raw.into()]);
    };
    let mut boundaries = Vec::with_capacity(commas.len() + 2);
    boundaries.push(open + 1);
    boundaries.extend(commas.iter().map(|comma| comma + 1));
    boundaries.push(close + 1);
    let mut alternatives = Vec::new();
    for index in 0..boundaries.len() - 1 {
        let arm_start = boundaries[index];
        let arm_end = if index + 1 == boundaries.len() - 1 {
            close
        } else {
            commas[index]
        };
        let candidate = format!(
            "{}{}{}",
            &raw[..open],
            &raw[arm_start..arm_end],
            &raw[close + 1..]
        );
        alternatives.extend(expand_simple_brace_lists_inner(&candidate, depth + 1)?);
        if alternatives.len() > 64 {
            return None;
        }
    }
    Some(alternatives)
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
