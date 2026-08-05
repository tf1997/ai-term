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
- `executing` 态：收到 C 时截取命令文本（优先用最近一次 `633;E`，否则读 B→C 的渲染行）。
- 收到 D 时产出 `{ command, exitCode, startedAt, finishedAt }` 事件。
- 乱序 / 缺失容错：任何时刻收到 A 都强制回到 `prompt`；只收到 133 无 633 时全部功能可用，仅命令文本走渲染行截取。

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
