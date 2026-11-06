# Shell Integration 语义标记改造开发文档

## 1. 背景

AI Term 当前对"命令的开始与结束"的识别完全依赖启发式推断：

- 提示符识别：用正则匹配输出的最后一行（`parseShellPrompt` / `recognizedShellPrompt`，`frontend/src/components/TerminalPane.vue`），按 powershell / cmd / posix / bare / generic 五类签名学习并复认。
- 输入跟踪：拦截键盘输入做影子跟踪（`trackUserInput`），维护 `inputCommandBuffer` / `inputCommandCursor` / `inputCommandReliable`，并在 Tab、方向键、Alt 序列等场景失效后依赖屏幕行反推恢复（`recoverTrackedTerminalInputFromRenderedLine`）。
- 命令捕获：回车时若跟踪不可信，用延迟轮询屏幕行猜测命令文本（`deferredCommandCapture`）。

这套机制存在结构性缺陷，且已在实际使用中造成可感知的问题：

1. 每次回车后上下文重置为 `unknown`，必须重新识别提示符才能恢复补全推荐。用户在提示符被识别前开始输入（type-ahead）会永久阻塞该行的识别，整行推荐失效。
2. generic 类提示符（oh-my-zsh、starship 等带动态段的主题）复认条件苛刻；Ctrl+C 路径不设置 `shellCommandAwaitingPrompt`，识别可能连续多行失败。
3. 影子跟踪对 Tab 补全、zsh-autosuggestions、↑/↓ 历史、Alt 词跳转等常规操作全部失效，恢复依赖屏幕行前缀匹配，多行/右侧提示符下恢复失败。
4. 命令历史捕获是猜测性的，无法获得退出码、耗时、cwd 等语义信息（这也是历史推荐文档中列为非目标的原因）。

业界标准解法是 shell integration 语义标记：由 shell 通过 hook 主动输出 OSC 133 转义序列上报提示符与命令的边界（VS Code、iTerm2、Kitty、WezTerm、Windows Terminal 均采用）。本次改造引入该机制，并保留现有启发式作为兜底层。

## 2. 目标

### 2.1 行为目标

- 收到语义标记的会话中，命令的开始、结束、文本、退出码来自 shell 上报，不再猜测。
- 输入补全推荐的门控由状态机驱动：处于"提示符输入态"即可推荐，Tab 补全、autosuggestions、↑/↓ 历史、type-ahead 均不再导致推荐失效。
- 当前输入行文本从屏幕真实内容读取（B 标记位置 → 光标），废除该模式下的影子跟踪可信性判断。
- 命令历史记录精确的命令文本与退出码；失败命令可在推荐排序中降权。
- 脚本 / 快捷命令的就绪判定（`commandExecutionReadiness`）由状态机驱动。

### 2.2 兼容目标

- 未收到标记的会话（裸远端、老 shell、cmd）回落到现有启发式，行为与现状完全一致。
- 敏感输入检测（密码/OTP 提示符）在两种模式下均保留。
- 本地注入可在设置中关闭；关闭后等同兜底模式。

## 3. 非目标

- SSH 远端的自动注入交互（阶段 3 单独设计，本文档只定义策略方向）。
- Windows cmd 的语义标记（无 hook 机制）。
- PowerShell 集成脚本（后续补充）。
- 基于 cwd / 耗时的推荐排序算法调整（数据先落库，算法另行迭代）。

## 4. 协议与状态机

### 4.1 采用的转义序列

| 序列 | 含义 | 来源 |
| --- | --- | --- |
| `OSC 133;A ST` | 提示符开始 | 标准 FinalTerm/133 |
| `OSC 133;B ST` | 提示符结束，用户输入区开始 | 标准 |
| `OSC 133;C ST` | 命令开始执行 | 标准 |
| `OSC 133;D;<exit> ST` | 命令结束，附退出码 | 标准 |
| `OSC 633;E;<cmd> ST` | 完整命令文本（自带脚本时发送，base64 编码规避转义问题） | VS Code 扩展协议 |
| `OSC 7;file://host/path ST` / `OSC 1337;CurrentDir=` | cwd 上报 | 通用 |

### 4.2 状态机

```
        A               B                C                    D;exit
idle ──────▶ prompt ──────▶ input ──────▶ executing ──────▶ (回到 prompt/idle)
```

- `input` 态：收到 B 时用 `terminal.registerMarker(0)` 锚定行（marker 随滚动与 reflow 自动跟踪），并记录列号。`commandLine()` 返回 B 锚点到光标的渲染文本。
- 输入起点和光标位置按终端显示列传给 xterm 的 `translateToString`，不能用作 UTF-16 字符串切片下标。中文、组合字符提示符的宽度与字符串长度不同，旧实现会截掉命令字符并误触发 Agent 命令不匹配；浏览器回归覆盖这两种提示符、自动折行及真正不同的命令。
- `executing` 态：收到 C 时截取命令文本（优先用最近一次 `633;E`，否则读 B→C 的渲染行）。
- 收到 D 时产出 `{ command, exitCode, startedAt, finishedAt }` 事件。
- 乱序 / 缺失容错：任何时刻收到 A 都强制回到 `prompt`；只收到 133 无 633 时全部功能可用，仅命令文本走渲染行截取。

### 4.3 macOS 长组合命令回归（2026-11-05）

针对用户提供的 `uptime`、`ps`、`memory_pressure`、`vm_stat`、`df` 组合命令，原文保存于 `src-tauri/tests/fixtures/macos-system-status.sh`。`shell_capture_integration` 的 `macos_status_command_retains_source_through_real_shell_echo` 在真实本机 PTY 中按 40、80、120、160 列运行；系统 Zsh 默认覆盖，现代 Bash 通过 `AI_TERM_TEST_BASH` 显式指定。命令使用生产命令意图审批和原样派发，运行前执行真实内部探针，Zsh 的 `633;E` 上报需与原文逐字一致。

`AI_TERM_COMMAND_REPLAY_FILE` 可保存这些输出，再交给 `test:bracketed-capture-browser`。浏览器先隐藏内部探针，再把后续原始输出分片送入生产过滤器、xterm 和 `useTerminalCapture`；断言每段只产生一个结果、命令原文一致、退出码为 0、四组结果标题齐全且没有 `commandMismatch`。回放必须等整段输出写完后再重置终端，避免前一用例的末尾提示符污染后一用例。真实 PTY 测试同样等待 D 后的提示符，不能把编辑长行时的提示符重绘当成命令结束；UTF-8 字节在合并后解码，防止测试工具自身破坏跨块中文。

本次系统 Zsh 5.9 与 Bash 5.2.37 的 8 组实际输出回放通过，另有中文／组合字符提示符、原命令不同列宽的屏幕回显和真正不同命令的拒绝用例。没有复现此前该条命令的失败。只读核对的旧任务记录缺少当时捕获到的命令和输出，因此不能把已修复的提示符列宽问题断言为那次失败的唯一原因；这些测试也不代表已验证用户当时的整个 Tauri 会话。

关联回归：前端 644/644、AI 313/313、现代 Bash 的原生 Shell 套件 7/7、构建、架构 4/4 和 UI 契约通过。浏览器另通过 2 组真实多行回放和 15 组命令文本核对，并确认真正不同的命令仍被拒绝。日志保存在本机 `/tmp/ai-term-status-final-*.log`。

```sh
AI_TERM_TEST_BASH='/path/to/modern/bash' AI_TERM_COMMAND_REPLAY_FILE=/tmp/ai-term-command-replay.json cargo test --manifest-path src-tauri/Cargo.toml --test shell_capture_integration macos_status_command -- --nocapture
# 沿用已有真实多行回放文件；需要先启动 Vite 与 Chrome CDP。
AI_TERM_CAPTURE_REPLAY_FILE=/tmp/ai-term-macos-replay.json AI_TERM_COMMAND_REPLAY_FILE=/tmp/ai-term-command-replay.json npm --prefix frontend run test:bracketed-capture-browser
```

### 4.4 探针后的旧提示符与 Zsh 语法错误收尾（2026-11-05）

用户后续截图明确为 macOS 本地终端：出现 `zsh: parse error near 'then'` 后已经回到提示符，Agent 仍等待完成。这里是错误后返回 Shell，不是命令成功的证据。

完整 `TerminalPane` 浏览器测试复现了一个派发竞态：隐藏探针的外层 END 到达后，过滤器已不再占用输出，但下一次提示符还没解析；原 `commandExecutionReadiness()` 此时读取旧的空提示符并返回 `ready`。现在在应用命令入队前保留等待状态，必须等 Shell 完成后的新提示符解析完，才允许准备／派发下一条命令。行编辑器只重绘 A/B 或 B 不会解除等待；非集成 Shell 使用新解析的可识别提示符恢复，连接重置和派发失败清理等待状态。回归用例把探针 END 与提示符分开 400 ms，确认期间不能填入命令。

真实系统 Zsh 另证明：`echo before; then` 的语法错误不调用 `preexec`，只发送无退出码的 D 和后续提示符。原捕获只等待 C→D，因此一直不结束。现在显式派发的捕获在收到无 C 的 D、执行开始后缺 D 却返回新提示符，或 D 缺退出码时，立即返回 `completionUnconfirmed`。Agent 停止后续步骤，保留观察到的错误输出并说明 Shell 已返回但结果未确认；不伪造退出码、不记录成功历史，也不自动重放。未收到 C/D 的行编辑器提示符重绘不会提前结束捕获。结果未知的效果仍保留恢复核对要求。

`zsh_syntax_error_returns_a_prompt_without_preexec_or_a_completion_status` 可通过 `AI_TERM_PARSE_ERROR_REPLAY_FILE` 导出真实输出；设置同一变量运行 `test:bracketed-capture-browser`，验证生产捕获立即返回且保留语法错误。完整终端组件另验证错误收尾后就绪状态恢复，Agent 循环用例确认不会再询问超时或再次执行。该证据确认了等待状态的缺陷；没有把旧截图中的那次具体语法错误归因于某个未经保留的原始输入流。

最终回归：前端 649/649、AI 314/314、原生 Shell 8/8；完整终端浏览器 19 项、真实流回放（2 组多行、16 组命令与错误场景）、完整 AI 界面、构建、架构、UI 契约、格式与空白检查通过。AI 界面用例确认不再显示活动计时，发送按钮恢复，重开后仍保留错误输出，且没有额外模型请求或命令重放。日志为本机 `/tmp/ai-term-prompt-lifecycle-*.log`。

### 4.5 内部多行探针破坏 Zsh 输入（2026-11-06）

第二张 macOS 本地终端截图的原命令已保存到 `src-tauri/tests/fixtures/macos-display-status.sh`：包含 `echo "cores: $(sysctl -n hw.ncpu)"`、WindowServer 采样及显示器信息。单独运行原文没有语法错误；将真实 Capture、Context 探针放在它之前后，原生 Zsh PTY 测试在 Context 阶段复现了输入错乱，5 秒内没有返回完成标记和新提示符，后续业务命令尚未派发。失败日志为 `/tmp/ai-term-display-quoted-native.log`。

问题位于后端 `command_policy/transport.rs`：`eval '…'` 虽然保护了 Shell 引号，却仍把内部程序的真实换行、Tab 直接发送给交互行编辑器。修复后的内部程序和哨兵兜底传输只提交一个物理输入行，由 Shell 内的 `printf %b` 还原，再在当前 Shell 中执行。先转义已有反斜杠，避免改变 `\\n`、`\\c` 等原始数据；编码完整的引用程序，避免命令替换吞掉原文尾部的换行。审批仍绑定原文与最终传输字节，保留 cwd、export 和退出码；已协商的括号粘贴仍使用原样多行输入。

`macos_display_command_preserves_quotes_and_substitution` 覆盖会话内加载，以及正常 `zsh -i` 经生产 ZDOTDIR 中转脚本加载的两种方式。后者使用临时配置和 macOS 风格提示符，不读取或修改用户个人启动文件。两种方式都先执行真实内部探针，再按原样派发截图命令，断言 Zsh 上报全文一致、单次退出码为 0，没有 `unmatched` 或 `parse error`。通过 `AI_TERM_DISPLAY_REPLAY_FILE` 导出后，浏览器将连续探针和命令输出分片送入生产过滤器、xterm 与捕获器，验证探针隐藏、命令匹配、核心数和两组标题完整且没有结果未知。

本轮通过原生 Shell 9 项（含真实交互式文件读取）、命令意图 12 项、策略 15 项、Rust 单测 163 项（另有 22 项按原配置忽略）；随后新增的尾部续行用例与转义用例也通过。前端 649 项；浏览器 2 组真实多行及 18 组命令／错误场景通过。另在系统 sh、Bash、Zsh 上核对转义、Tab、heredoc、当前 Shell 状态和退出码。日志为本机 `/tmp/ai-term-display-regression-*.log` 与 `/tmp/ai-term-display-transport-unit.log`。

该复现确认了传输缺陷，但旧任务没有保留捕获到的命令全文，不能声称重现了截图中完全相同的截断字节。用户尚未在当前版本复测；本次修改包含 Rust 后端，需要重启开发进程或重新构建应用，再新开本地终端验证。

```sh
AI_TERM_DISPLAY_REPLAY_FILE=/tmp/ai-term-display-quoted-replay.json cargo test --manifest-path src-tauri/Cargo.toml --test shell_capture_integration macos_display_command -- --nocapture
# 已有真实多行回放文件，且 Vite 与 Chrome CDP 已启动。
AI_TERM_DISPLAY_REPLAY_FILE=/tmp/ai-term-display-quoted-replay.json npm --prefix frontend run test:bracketed-capture-browser
```

### 4.6 Bash 中文折行补位造成命令不匹配（2026-11-06）

远端 Ubuntu 截图中的 apt / 内核 / 安全更新组合命令原文保存于 `src-tauri/tests/fixtures/ubuntu-security-status.sh`。这次没有 Shell 语法错误：本机真实 Bash 5.2.37 PTY 回放在 40 列下复现了明确差异，派发的 `更新时间` 被前端捕获为 `更新 时间`。原始字节流为 `更新 SPACE ESC[K 时间`（实际没有这些说明文字）：Readline 为不能放进末列的双宽字符补空格并清除行尾，前端把显示补位当成了源码。失败回放日志为 `/tmp/ai-term-ubuntu-browser-before.log`。

修复位于前端 `shellIntegration.ts`。只在输入态观察光标位于右边界之外、最后一格为空格时的 `EL(0)`；用 xterm marker 保存位置。重建输入时还需确认下一行是自动折行且首字符宽度为 2，才忽略该末列显示补位。普通空格保留，不修改终端画面，也不放宽命令比较规则。新提示符、命令开始、重置、释放及窗口尺寸变化时清理补位元数据。

真实 Bash 用例覆盖 40、76、80、96、120、160 列，另在相同边界执行原本就带 `更新 时间` 的变体。前端回放需准确区分显示补位和真正的空格：原命令匹配，带空格变体也按原文匹配；把后者冒充成没有空格的命令时仍拒绝。所有输出标题、退出码均保留，已有不同命令拒绝、Zsh 语法错误及 macOS 原命令回放一并覆盖。原生用例验证 Bash 输入与标记，Linux 专用工具在非 Ubuntu 测试机上可缺省，因此它不等于重连用户服务器进行端到端验证。

验证日志为 `/tmp/ai-term-ubuntu-*.log`：前端 649 项、构建、架构 4 项、UI 契约和完整终端组件浏览器 19 项通过；真实流浏览器回放通过 2 组多行及 25 组命令／错误场景，并另验证真实空格不能被忽略。

```sh
AI_TERM_TEST_BASH='/path/to/modern/bash' AI_TERM_BASH_REPLAY_FILE=/tmp/ai-term-ubuntu-bash-replay.json cargo test --manifest-path src-tauri/Cargo.toml --test shell_capture_integration bash_security_command -- --nocapture
AI_TERM_BASH_REPLAY_FILE=/tmp/ai-term-ubuntu-bash-replay.json npm --prefix frontend run test:bracketed-capture-browser
```

## 5. 技术方案

### 5.1 阶段 1：前端解析与分层接入（纯前端）

新增 `frontend/src/lib/shellIntegration.ts`：

- `ShellIntegrationTracker` 类，构造时接收 xterm `Terminal` 实例，通过 `terminal.parser.registerOscHandler(133 | 633 | 7 | 1337, ...)` 注册（xterm 5.5 稳定 API，无需 proposed API）。
- 对外暴露：
  - `state`: `'idle' | 'prompt' | 'input' | 'executing'`
  - `sawMarkers`: 本会话是否收到过 133（分层开关）
  - `commandLine()`: input 态下的实时输入文本
  - `cwd`: 最近上报的工作目录（可选）
  - 回调：`onPromptStart` / `onInputStart` / `onCommandStart` / `onCommandFinished(result)`
- 纯逻辑部分（序列解析、状态转移、base64 解码）与 xterm 解耦，便于单测。

`TerminalPane.vue` 接入，以 `sawMarkers` 为开关分层：

- **集成模式**（`sawMarkers === true`）：
  - `canOfferCompletion()`：`state === 'input'` 且 `commandLine()` ≥ 2 字符，取代五条件猜测链；`buildCompletionSuggestions` 的前缀改用 `commandLine()`。
  - `commandExecutionReadiness()`：`input` 态且 `commandLine()` 为空 → `ready`；`executing` → `shell-busy`；其余 → 沿用现状。
  - 命令历史：`onCommandFinished` 时调用 `recordCommand`，携带退出码；停用该模式下的 `deferredCommandCapture` 轮询与回车时的影子捕获。
  - 影子跟踪代码保留运行（供 sensitive 检测与同步输入使用），但不再作为推荐/就绪的依据。
- **兜底模式**（未见标记）：现有逻辑原样保留，不改行为。

数据结构调整：

- `CommandHistoryEntry` 增加可选 `exitCode?: number`（`frontend/src/types`、`src-tauri/src/domain/storage/sqlite.rs` 加列，`ALTER TABLE ... ADD COLUMN` 向后兼容，旧记录为 NULL）。
- 推荐排序（`buildCompletionSuggestions`）：`exitCode` 非 0 的历史降权（排序键在 count 之后加成功率因子，具体权重实现时定）。

本阶段收益：starship、装有 iTerm2 shell integration 的本地与远端环境本来就在发 OSC 133，无需任何注入即可进入集成模式。

### 5.2 阶段 2：本地 shell 自动注入

新增 `src-tauri/resources/shell-integration/`：

- `integration.zsh`：`precmd` 发 `133;D;$?`（首个提示符前跳过 D）+ `133;A`，经 `PS1` 尾接 `133;B`（用 `%{...%}` 包裹零宽序列），`preexec` 发 `633;E;<base64($1)>` + `133;C`。
- `integration.bash`：`PROMPT_COMMAND` + `PS0` 实现同等语义。
- 幂等与避让：检测 `VSCODE_SHELL_INTEGRATION`、iTerm2 集成等已有标记源时静默退出，避免双重标记；仅在 `AI_TERM=1` 环境下激活。

`src-tauri/src/domain/terminal/local.rs` 注入（`local_shell_command` 改造）：

- zsh：设 `ZDOTDIR` 指向应用资源中的中转目录，其 `.zshrc` 先 source 用户原配置（`AI_TERM_ORIG_ZDOTDIR` 或 `$HOME/.zshrc`）再 source 集成脚本。
- bash：`--init-file` 指向包装脚本（source `~/.bashrc` + 集成脚本）。
- 其它 shell / Windows：不注入，走兜底。
- 设置项：`终端设置` 增加"Shell 智能集成"开关，默认开启；关闭后不修改启动参数。

### 5.3 阶段 3：SSH 远端策略（方向性定义）

- 默认被动检测：远端已有集成（starship 等）直接受益,无动作。
- 显式启用：连接配置中提供"启用远端智能识别"，经用户确认后将集成脚本安装至远端 rc 文件，或每次连接后发送一段 bootstrap（`eval "$(echo <base64> | base64 -d)"`，可配置）。
- 交互与安全细节（写入远端文件的确认、卸载）在该阶段单独出文档。

## 6. 验收标准

1. 本地 zsh（默认提示符与 starship 主题）中：Tab 补全、接受 autosuggestion、↑/↓ 翻历史、命令输出未结束时预输入下一条命令，之后继续输入均能正常弹出补全推荐。
2. Ctrl+C 中断后下一行推荐正常。
3. 集成模式下历史记录的命令文本与实际执行一致，退出码正确落库；失败命令在推荐中排序低于同频次的成功命令。
4. 连接一台无任何集成的远端：行为与改造前一致（兜底模式），无回归。
5. vim 等全屏程序进出后状态机与推荐恢复正常。
6. 关闭"Shell 智能集成"开关后,本地会话回到兜底模式。

## 7. 测试与验证

- 单测：`frontend/scripts/shell-integration.test.mjs`（沿用 `tsx --test` 模式），覆盖状态机转移、乱序容错、`633;E` base64 解析、B 标记后命令行截取。
- 手动矩阵：见验收标准 1–6，另加 SSH 到已装 starship 的远端（验证零注入受益）。
- 回归：`npm run test:scripts` 全绿；快捷命令 / 脚本面板的就绪判定在两种模式下抽查。

## 8. 后续阶段

- PowerShell 集成脚本与 Windows 注入。
- 阶段 3 远端注入的产品化交互。
- 基于 cwd 的目录相关推荐、基于耗时的长命令提醒。
- 集成模式稳定后,评估删减影子跟踪中仅服务于旧门控的代码路径。
