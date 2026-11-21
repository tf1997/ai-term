# 命令确认与安全命令识别梳理

更新：2026-11-21。策略版本 `command-policy-v3`。

## 问题

- 存在两套确认弹窗：脚本/快捷命令/普通对话走 `CommandPolicyReview`（执行前确认），Agent “查看风险”与旧派发入口走 `AiPanel` 内的 `script-risk-modal`。
- 几乎所有命令都要确认，原因有三处叠加：
  1. 后端对 zsh 和尚未探测的 Shell 直接返回 `unsupported-shell`，macOS 默认终端里任何命令都是 `ask`。
  2. 目录、用户、环境任一未确认即追加 `target-context`，把只读命令也变成 `ask`。
  3. 后端只读白名单比前端内置只读集窄（`git status`、`docker ps`、`find`、`journalctl` 等都不在内），而 `ask` 会无条件覆盖前端允许列表和“总是允许”。
- 只读命令带上 `$?` 就被判为高风险“动态执行”：`ls -l /tmp/note.txt 2>&1; echo "exit=$?"` 按 `;` 拆开是两条只读命令，但 `echo` 参数里的 `$?` 让整条命令变成“命令名或参数由运行时展开决定”。

## 弹窗

统一为 `CommandPolicyReview`，并入旧弹窗的风险类型标签、敏感内容提示和“借助 AI 分析风险”。

- 普通对话、脚本、快捷命令：由 `AppShell` 挂载，`explain` 使用当前 AI 配置。
- Agent：`AiPanel` 以 `agent` 模式挂载同一组件，增加“跳过命令”“停止任务”；独立 SSH 任务通过 `#context` 插槽显示登录目标。
- 没有后端记录的入口（旧派发、独立 SSH）用 `reviewIntentFromRisks` 生成仅供展示的记录，不携带执行授权。
- 脚本面板自己的脚本风险弹窗未改动。

## 放行规则

- zsh 与未探测 Shell 按 Bourne 语法树分析。逐词拒绝 zsh 专有展开（glob 限定符、`=cmd`、`^`、`#`）；未探测 Shell 额外拒绝 `%`、`@`。PowerShell/cmd 仍整体需要确认。
- 环境未确认时，分析完整且无任何风险/未知项的单条命令（即只读命令）保持 `allow`；其余命令与 Bash 脚本照旧追加 `target-context`。
- 后端白名单补齐：`w`、`printenv`、`which`、`type`、`hostname`（仅查询选项）、`date`（非设置）、`ss`（非 `-K`/`-D`）、`journalctl`（非清理/轮转）、`find`（非 `-delete`/`-exec`/写文件）、`git branch`（仅列出）。写入形式记为风险。
- 后端仅因 `unmodeled-command`、`git-operation`、`resource-operation` 而询问、且无风险命中时，用户允许列表与本会话精确授权可以放行；前端代为批准后端记录后派发。此类命令在卡片上不再显示为“风险”，可直接“仅执行本次”或“总是允许”。
- 不变：风险规则命中、命令替换、运行时展开、写重定向、sudo、危险环境变量、敏感路径、`deny` 均不能被允许列表或会话授权覆盖。

### 打印型参数读取

`echo` 和 `printf` 只打印操作数，操作数里的参数读取既不决定执行哪个程序，也不决定选项或文件。操作数由字面量和纯参数读取（`$?`、`$$`、`$#`、`$name`、`${name}`、`$@`、`$*`、`$1`）组成时不再算动态词。

- `printf` 的格式串必须是字面量。`-v`、`%n` 照旧询问。格式里有 `%s`、`%b`、`%q`、`%%` 以外的转换时，操作数只接受 `$?`、`$$`、`$#`：zsh 和 ksh 会把数字型转换的操作数当算术表达式求值。
- zsh 与未探测 Shell：读取文本的参数必须在双引号内（未加引号的值可能被 glob，限定符可以执行代码）；`"$x[1]"`、`"$x:h"` 这类下标和修饰符照旧询问。
- 照旧询问：`${x:=y}`、`${!x}`、`${#x}`、数组下标、算术展开、`$!`、紧跟在 `!` 后的 `$`，以及值会决定程序、选项或文件的位置（`"$cmd" arg`、`cat "$file"`、`ls $?`、重定向目标、`X=$? echo hi`、`builtin echo "$?"`）。

### zsh 与未探测 Shell 的原样派发

命令以原文键入交互式 Shell。下列写法在 zsh 里实际执行的内容和 Bourne 语法树不同，或会改变后续命令的行为，在这两种方言下一律逐次确认（原因码见括号）：

- `#` 注释（`interactive-comment`）：交互式 zsh 默认不开 `INTERACTIVE_COMMENTS`，`echo hi # ; rm -rf x` 中 `#` 之后的内容会照常执行。
- 单引号外的 `!`，后跟空白、`=`、`(` 的除外（`history-expansion`）：zsh 会删除 `!"` 并使其后的引号全部错位，`echo "a!" "; cmd; echo " #"` 会把引号里的 `cmd` 执行出来；`echo "done!"` 会停在续行提示符。
- 双引号内的 `$=x`、`$~x`、`$^x`、`$+x`（`foreign-expansion`）：Bourne 语法把它们读成字面量，zsh 却会展开，`$=x` 还会分词，`find dir "$=x"` 可以带入 `-delete`。
- 任何变量赋值，含命令前的环境前缀（`variable-assignment`）：提示符、分页器和钩子变量因 Shell 而异，未建模。

Bash 与 POSIX sh 的判定不受这四条影响。

## 本轮收紧（2026-11-21）

- 仅字面量 `LANG`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES` 作为 Bash/POSIX/zsh 命令前缀时按无执行副作用处理，例如 `LC_ALL=C ls`。其他变量前缀、独立变量赋值和未探测 Shell 中的赋值均为高风险；因此 `GIT_PAGER='程序' git log`、`PROMPT_COMMAND='程序'; ls` 与自定义钩子变量不能被允许列表或精确会话授权覆盖。
- 简单逗号花括号列表最多枚举 64 个候选，再逐个按命令规则分析。若候选触发风险或非只读命令，整条命令需要确认；无法完整枚举或超预算时也按高风险处理。因此 `find . {-delete,-name} x`、`cat /etc/shado{w,}` 不再自动放行，而 `echo {one,two}`、`find . -name file{one,two}.log` 仍可通过。范围展开等未支持形式不作安全枚举。
- Agent 前端的回退分类和精确授权也拒绝环境赋值及 `export`、`declare` 等 Shell 状态修改命令，避免后端策略不可用时由允许列表绕过。
- 输入重定向会复用后端敏感路径规则；静态敏感目标、含敏感候选的花括号展开及动态目标都要求高风险确认，例如 `cat < /etc/shadow`、`cat < /etc/shado{w,}`、`cat < "$TARGET"`。普通临时文件输入仍不额外提示。

仍会误报为高风险“动态执行”的只读写法：`ls ~/logs`（波浪号）、`ls /var/log/*.log`（通配符）、zsh 下未加引号的 `echo $HOME`。`[ -f x ] && echo yes` 需要逐次确认；`test -f x` 属于未建模命令，可以用允许列表放行。

## 验证

2026-11-21，macOS（zsh 5.9、bash 3.2）。本轮新增环境钩子/赋值、花括号展开和敏感输入重定向回归用例。

- 后端：`cargo fmt --check` 通过。`LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 cargo test --no-fail-fast` 全部通过，`tests/command_policy.rs` 22 项。不设 UTF-8 locale 时 `shell_capture_integration` 有 3 项超时：zsh 在 C locale 下把多字节字符回显成非 UTF-8 序列，测试夹具等不到提示符，与策略改动无关。
- 前端：`vue-tsc`、`vite build`、`test:scripts`（679）、`test:ai`（344）、`test:transfer`（93）、`test:terminal-debug`（78）、`test:tabs`（45）、`test:settings`（26）、`test:workspace-data`（25）、`test:overlays`（19）、`test:workspace`（18）、`test:routing`（17）、`test:configuration`（8）、`test:architecture`（4）、`test:ui` 通过。
- 浏览器（Vite `5173` + 无头 Chrome `9231`）：`command-policy`、`ai-chat`（统一弹窗的普通、Agent 和独立 SSH 三种形态）、`agent-command-wait`、`task-script`、`host-knowledge`、`terminal-font` 通过。`ai-background` 失败（任务 A 的命令提议后会话状态未进入“待确认”），在未含本次改动的 `2ee9099` 上以同样方式失败。
- 真实交互式 Shell：上面“原样派发”四条里的示例各用只含 `echo` 的无害版本键入 zsh 和 bash，确认 zsh 的实际行为与语法树不符、bash 相符。
- 未运行：真实 Tauri 应用内的端到端操作；`bracketed-capture`（需先由 `shell_capture_integration` 生成回放文件）及需要独立预览服务器的浏览器套件（`script-editor`、`terminal-workspace`、`sftp-workspace`、`performance`、`terminal-debug`、`terminal-reconnect`、`terminal-selection`）。
