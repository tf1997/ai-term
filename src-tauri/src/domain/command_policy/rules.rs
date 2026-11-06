use super::analysis::{Analyzer, Word};
use super::{Decision, RiskKind as K, RiskSeverity as S};

pub(super) fn is_system_path(path: &str) -> bool {
    ["/etc", "/boot", "/usr", "/var", "/opt", "/dev", "/root"]
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

pub(super) fn analyze_words(analyzer: &mut Analyzer<'_>, words: &[Word], depth: usize) {
    let Some(first) = words.first() else {
        return;
    };
    let Some(name) = first.value.as_deref() else {
        return;
    };
    if depth > 32 {
        analyzer.unknown(
            "wrapper-depth",
            "命令包装超过分析深度上限。",
            first.range.clone(),
        );
        return;
    }
    let head = name.rsplit('/').next().unwrap_or(name);
    let args: Vec<&str> = words[1..]
        .iter()
        .map(|w| w.value.as_deref().unwrap_or(""))
        .collect();
    let range = first.range.clone();
    let targets = || {
        args.iter()
            .filter(|a| !a.is_empty() && !a.starts_with('-'))
            .map(|a| (*a).into())
            .collect()
    };
    let options_end = args.iter().position(|a| *a == "--").unwrap_or(args.len());
    let options = &args[..options_end];
    let short_flag = |flag: char| {
        options
            .iter()
            .any(|a| a.starts_with('-') && !a.starts_with("--") && a.contains(flag))
    };

    for word in &words[1..] {
        if let Some(value) = &word.value {
            if value == "/etc/shadow"
                || value.contains("/.ssh/id_") && !value.ends_with(".pub")
                || value.contains("/.aws/credentials")
                || value.contains("/.kube/config")
                || value.ends_with("/.env")
                || value.ends_with(".pem")
            {
                analyzer.risk(
                    "permission.sensitive-path",
                    K::Permission,
                    S::High,
                    "操作涉及凭据或敏感路径。",
                    word.range.clone(),
                    vec![value.clone()],
                );
            }
        }
    }
    let printf_format = if args.first() == Some(&"--") {
        args.get(1)
    } else {
        args.first()
    };
    if head == "printf"
        && (options.iter().any(|a| a.starts_with("-v"))
            || printf_format.is_some_and(|format| printf_assigns_variable(format)))
    {
        analyzer.unknown(
            "printf-assignment",
            "printf 的变量赋值选项或格式会修改 Shell 状态。",
            range.clone(),
        );
    }

    if name.contains('/') && !name.starts_with("/bin/") && !name.starts_with("/usr/bin/") {
        analyzer.unknown(
            "external-executable",
            "执行文件内容尚未验证，不能根据文件名自动授权。",
            range.clone(),
        );
    }
    match head {
        "builtin" => {
            let offset = if args.first() == Some(&"--") { 2 } else { 1 };
            analyze_inner(analyzer, words, offset, depth);
            return;
        }
        "command" => {
            let mut offset = 1;
            while let Some(value) = words.get(offset).and_then(|w| w.value.as_deref()) {
                match value {
                    "-v" | "-V" => return,
                    "-p" => offset += 1,
                    "--" => {
                        offset += 1;
                        break;
                    }
                    _ => break,
                }
            }
            analyze_inner(analyzer, words, offset, depth);
            return;
        }
        "sudo" | "doas" | "nohup" | "nice" | "timeout" | "env" => {
            if matches!(head, "sudo" | "doas") {
                analyzer.risk(
                    "permission.elevation",
                    K::Permission,
                    S::High,
                    "执行身份或权限将发生变化。",
                    range.clone(),
                    vec![],
                );
            }
            if head == "env"
                && args
                    .iter()
                    .all(|a| matches!(*a, "-0" | "--null" | "--help" | "--version"))
            {
                return;
            }
            let mut index = 1;
            while index < words.len() {
                let Some(value) = words[index].value.as_deref() else {
                    break;
                };
                if head == "env" && (value.starts_with("-S") || value.starts_with("--split-string"))
                {
                    analyzer.risk(
                        "execution.env-split",
                        K::Execution,
                        S::High,
                        "env -S 会解析并执行新的命令。",
                        words[index].range.clone(),
                        vec![],
                    );
                    analyzer.unknown(
                        "env-split",
                        "env 的分词语义尚未完整建模。",
                        words[index].range.clone(),
                    );
                    return;
                }
                if value == "--" {
                    index += 1;
                    break;
                }
                if value.starts_with('-') {
                    let takes_value = match head {
                        "sudo" => matches!(value, "-u" | "-g" | "--user" | "--group"),
                        "doas" => value == "-u",
                        "timeout" => matches!(value, "-k" | "-s" | "--signal" | "--kill-after"),
                        "nice" => matches!(value, "-n" | "--adjustment"),
                        "env" => matches!(value, "-u" | "--unset" | "-C" | "--chdir"),
                        _ => false,
                    };
                    let flag_only = match head {
                        "sudo" => matches!(value, "-n" | "-k" | "-K" | "-E" | "-H" | "-S" | "-b"),
                        "doas" => matches!(value, "-n" | "-s"),
                        "timeout" => matches!(value, "--preserve-status" | "--foreground"),
                        "env" => matches!(value, "-i" | "--ignore-environment" | "-0" | "--null"),
                        _ => false,
                    };
                    if takes_value {
                        index += 2;
                    } else if flag_only {
                        index += 1;
                    } else {
                        analyzer.unknown(
                            "wrapper-option",
                            "包装命令包含尚未建模的选项。",
                            words[index].range.clone(),
                        );
                        index += 1;
                    }
                    continue;
                }
                if head == "env" && value.contains('=') {
                    analyzer.unknown(
                        "wrapper-environment",
                        "env 会更改内层命令的环境。",
                        words[index].range.clone(),
                    );
                    index += 1;
                    continue;
                }
                break;
            }
            if head == "timeout" {
                if words
                    .get(index)
                    .and_then(|w| w.value.as_ref())
                    .is_some_and(|v| v.starts_with(|c: char| c.is_ascii_digit()))
                {
                    index += 1;
                } else {
                    analyzer.unknown(
                        "timeout-duration",
                        "无法确定 timeout 的时长参数。",
                        range.clone(),
                    );
                }
            }
            analyze_inner(analyzer, words, index, depth);
            return;
        }
        "sh" | "bash" | "dash" | "zsh" | "ksh" | "fish" => {
            analyzer.risk(
                "execution.shell",
                K::Execution,
                S::High,
                "将启动 Shell 并执行内层代码。",
                range.clone(),
                vec![],
            );
            let command_flag = options.iter().position(|a| {
                *a == "--command"
                    || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains('c'))
            });
            if let Some(flag) = command_flag {
                if matches!(head, "bash" | "sh" | "dash") {
                    if let Some(code) = words.get(flag + 2) {
                        if let Some(value) = &code.value {
                            analyzer.parse(value, &code.origins, depth + 1);
                            return;
                        }
                    }
                }
            }
            analyzer.unknown(
                "shell-input",
                "内层源码来自运行时参数、stdin、外部脚本或其他 Shell 方言。",
                range,
            );
            return;
        }
        "eval" => {
            analyzer.risk(
                "execution.eval",
                K::Execution,
                S::High,
                "eval 会重新解析并执行参数。",
                range.clone(),
                vec![],
            );
            let arguments = if args.first() == Some(&"--") {
                &words[2..]
            } else {
                &words[1..]
            };
            if arguments.iter().all(|w| w.value.is_some()) && !arguments.is_empty() {
                let mut code = String::new();
                let mut origins = Vec::new();
                for word in arguments {
                    if !code.is_empty() {
                        code.push(' ');
                        origins.push(word.range.start_byte);
                    }
                    code.push_str(word.value.as_deref().unwrap_or(""));
                    origins.extend_from_slice(&word.origins);
                }
                analyzer.parse(&code, &origins, depth + 1);
            } else {
                analyzer.unknown("eval-input", "eval 的实际源码无法静态确定。", range);
            }
            return;
        }
        "." | "source" | "exec" | "xargs" | "busybox" | "python" | "python2" | "python3"
        | "perl" | "ruby" | "node" | "php" | "lua" | "awk" | "gawk" | "mawk" | "pwsh"
        | "powershell" | "cmd" => {
            analyzer.risk(
                "execution.dynamic",
                K::Execution,
                S::High,
                "该工具可执行外部脚本或动态代码。",
                range.clone(),
                vec![],
            );
            analyzer.unknown(
                "unmodeled-code",
                "实际执行源码或解释器语义尚未完整分析。",
                range,
            );
            return;
        }
        "rm" | "rmdir" | "unlink" => {
            let recursive = short_flag('r') || short_flag('R') || options.contains(&"--recursive");
            let force = short_flag('f') || options.contains(&"--force");
            analyzer.risk(
                "delete.files",
                K::Delete,
                if recursive || force {
                    S::High
                } else {
                    S::Medium
                },
                "将删除文件或目录。",
                range,
                targets(),
            );
            if recursive
                && args
                    .iter()
                    .any(|a| !a.is_empty() && a.chars().all(|c| c == '/'))
            {
                analyzer.result.decision = Decision::Deny;
            }
            return;
        }
        "find" => {
            for (index, arg) in args.iter().enumerate() {
                match *arg {
                    "-delete" => analyzer.risk(
                        "delete.find",
                        K::Delete,
                        S::High,
                        "find 将批量删除匹配文件。",
                        words[index + 1].range.clone(),
                        targets(),
                    ),
                    "-exec" | "-execdir" | "-ok" | "-okdir" => {
                        analyzer.risk(
                            "execution.find",
                            K::Execution,
                            S::High,
                            "find 会对匹配项执行命令。",
                            words[index + 1].range.clone(),
                            vec![],
                        );
                        let end = args[index + 1..]
                            .iter()
                            .position(|a| matches!(*a, ";" | "+"))
                            .map(|i| i + index + 2)
                            .unwrap_or(words.len());
                        analyze_inner(analyzer, &words[..end], index + 2, depth);
                    }
                    "-fprint" | "-fprint0" | "-fprintf" | "-fls" => analyzer.risk(
                        "edit.find",
                        K::Edit,
                        S::Medium,
                        "find 将结果写入文件。",
                        words[index + 1].range.clone(),
                        targets(),
                    ),
                    _ => {}
                }
            }
            return;
        }
        "cp" | "mv" | "tee" | "install" | "touch" | "truncate" => {
            let high = args.iter().any(|a| is_system_path(a));
            analyzer.risk(
                "edit.files",
                K::Edit,
                if high { S::High } else { S::Medium },
                "将创建、修改或覆盖文件。",
                range,
                targets(),
            );
            return;
        }
        "sed" => {
            if short_flag('i') || options.iter().any(|a| a.starts_with("--in-place")) {
                analyzer.risk(
                    "edit.sed",
                    K::Edit,
                    S::Medium,
                    "sed 会原地修改文件。",
                    range.clone(),
                    targets(),
                );
            }
            analyzer.unknown(
                "sed-program",
                "sed 程序可能包含文件写入或执行指令，尚未完整建模。",
                range,
            );
            return;
        }
        "vi" | "vim" | "nano" | "emacs" => {
            analyzer.risk(
                "edit.editor",
                K::Edit,
                S::Medium,
                "将启动交互式编辑器。",
                range,
                targets(),
            );
            return;
        }
        "chmod" | "chown" | "chgrp" | "setfacl" => {
            analyzer.risk(
                "permission.files",
                K::Permission,
                S::Medium,
                "将修改访问权限或所有者。",
                range,
                targets(),
            );
            return;
        }
        "reboot" | "shutdown" | "poweroff" | "halt" => {
            analyzer.risk(
                "reboot.system",
                K::Reboot,
                S::High,
                "将重启或关闭系统。",
                range,
                targets(),
            );
            return;
        }
        "dd" | "fdisk" | "sfdisk" | "parted" | "wipefs" | "mkfs" => {
            analyzer.risk(
                "disk.operation",
                K::Disk,
                S::High,
                "磁盘操作可能覆盖设备或分区。",
                range,
                targets(),
            );
            return;
        }
        "iptables" | "nft" | "ufw" | "firewall-cmd" | "ip" => {
            let readonly_ip = head == "ip"
                && matches!(
                    args.first(),
                    Some(&"addr" | &"address" | &"route" | &"link")
                )
                && (args.len() == 1
                    || matches!(args.get(1), Some(&"show" | &"list" | &"ls" | &"get")));
            if !readonly_ip {
                analyzer.risk(
                    "network.configuration",
                    K::Network,
                    S::High,
                    "网络或防火墙变更可能中断连接。",
                    range,
                    targets(),
                );
            }
            return;
        }
        "systemctl" | "service" => {
            if head == "systemctl"
                && matches!(
                    args.first(),
                    Some(&"status" | &"is-active" | &"list-units" | &"list-timers")
                )
            {
                return;
            }
            analyzer.risk(
                "service.state",
                K::Service,
                S::Medium,
                "服务操作可能改变运行状态。",
                range,
                targets(),
            );
            return;
        }
        "apt" | "apt-get" | "dnf" | "yum" | "pacman" | "brew" | "npm" | "pip" | "pip3" => {
            analyzer.risk(
                "upgrade.packages",
                K::Upgrade,
                S::Medium,
                "软件包操作可能更改环境或执行安装脚本。",
                range,
                targets(),
            );
            return;
        }
        "docker" | "kubectl" => {
            if args
                .iter()
                .any(|a| matches!(*a, "rm" | "rmi" | "prune" | "delete"))
            {
                analyzer.risk(
                    "delete.resources",
                    K::Delete,
                    S::High,
                    "将删除容器、镜像或集群资源。",
                    range,
                    targets(),
                );
            } else if !matches!(
                args.first(),
                Some(&"ps" | &"images" | &"inspect" | &"logs" | &"get" | &"describe" | &"top")
            ) {
                analyzer.unknown(
                    "resource-operation",
                    "此资源操作或全局选项尚未完整建模。",
                    range,
                );
            }
            return;
        }
        "git" => {
            if matches!(
                args.first(),
                Some(
                    &"reset"
                        | &"clean"
                        | &"restore"
                        | &"checkout"
                        | &"switch"
                        | &"rebase"
                        | &"push"
                )
            ) || (args.first() == Some(&"branch")
                && (short_flag('D') || short_flag('d') || options.contains(&"--delete")))
            {
                analyzer.risk(
                    "delete.git-state",
                    K::Delete,
                    S::High,
                    "Git 操作可能覆盖工作区、历史或远端引用。",
                    range,
                    targets(),
                );
            } else if options.iter().any(|a| a.starts_with("--output")) {
                analyzer.risk(
                    "edit.git-output",
                    K::Edit,
                    S::Medium,
                    "Git 将输出写入文件。",
                    range,
                    targets(),
                );
            } else if !matches!(args.first(), Some(&"status" | &"log" | &"show" | &"diff"))
                || options
                    .iter()
                    .any(|a| matches!(*a, "--ext-diff" | "--textconv"))
            {
                analyzer.unknown(
                    "git-operation",
                    "Git 选项或子命令可能改变状态或执行外部程序。",
                    range,
                );
            }
            return;
        }
        "file" if short_flag('C') || options.contains(&"--compile") => {
            analyzer.risk(
                "edit.file-magic",
                K::Edit,
                S::Medium,
                "file 的编译选项会生成或覆盖 magic 数据库文件。",
                range,
                targets(),
            );
            return;
        }
        "rg" if options
            .iter()
            .any(|a| *a == "--hostname-bin" || a.starts_with("--hostname-bin=")) =>
        {
            analyzer.risk(
                "execution.rg-hostname",
                K::Execution,
                S::High,
                "搜索工具会启动指定的外部程序来获取主机名。",
                range.clone(),
                targets(),
            );
            analyzer.unknown("external-hostname-program", "外部程序内容尚未验证。", range);
            return;
        }
        "rg" if options
            .iter()
            .any(|a| *a == "--pre" || a.starts_with("--pre=")) =>
        {
            analyzer.risk(
                "execution.rg-pre",
                K::Execution,
                S::High,
                "搜索前将执行外部预处理程序。",
                range.clone(),
                targets(),
            );
            analyzer.unknown("external-preprocessor", "预处理程序内容尚未验证。", range);
            return;
        }
        _ => {}
    }
    if head.starts_with("mkfs.") {
        analyzer.risk(
            "disk.format",
            K::Disk,
            S::High,
            "格式化会覆盖文件系统。",
            range,
            targets(),
        );
    } else if !matches!(
        head,
        "echo"
            | "printf"
            | "pwd"
            | "ls"
            | "cat"
            | "head"
            | "stat"
            | "file"
            | "wc"
            | "du"
            | "df"
            | "free"
            | "uptime"
            | "who"
            | "whoami"
            | "id"
            | "uname"
            | "ps"
            | "pgrep"
            | "lsof"
            | "grep"
            | "rg"
            | "true"
            | "false"
            | ":"
    ) {
        analyzer.unknown(
            "unmodeled-command",
            "命令或参数语义尚未纳入自动允许策略。",
            range,
        );
    }
}

fn printf_assigns_variable(format: &str) -> bool {
    let mut characters = format.chars();
    while let Some(character) = characters.next() {
        if character != '%' {
            continue;
        }
        let Some(mut conversion) = characters.next() else {
            break;
        };
        if conversion == '%' {
            continue;
        }
        while conversion.is_ascii_digit() || "-+ #.*hlLjztqI".contains(conversion) {
            let Some(next) = characters.next() else {
                return false;
            };
            conversion = next;
        }
        if conversion == 'n' {
            return true;
        }
    }
    false
}

fn analyze_inner(analyzer: &mut Analyzer<'_>, words: &[Word], index: usize, depth: usize) {
    if let Some(inner) = words.get(index..) {
        if !inner.is_empty() {
            analyze_words(analyzer, inner, depth + 1);
            return;
        }
    }
    if let Some(first) = words.first() {
        analyzer.unknown(
            "missing-inner-command",
            "包装命令的实际执行内容不完整。",
            first.range.clone(),
        );
    }
}
