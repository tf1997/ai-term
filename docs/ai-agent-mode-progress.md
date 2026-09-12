# AI Agent 模式开发进度(交接文档)

更新:2026-08-31。配套设计文档:[ai-agent-mode-development.md](./ai-agent-mode-development.md)(下称"设计文档"),节号均指该文档。

> **接手先看两件事**:§1.6 记录了已修复的敏感路径安全缺口;§8 是阶段 3 的后续方案,其第 0 步已完成。

## 1. 一句话状态

**阶段 1 + 阶段 1.5 + 阶段 2 的代码与自动化验证均已落地,敏感路径安全门也已补齐。剩余工作主要是需真机 / 真实模型网关的人工验收(§5),以及阶段 3 工具扩展(§8)。**

哨兵兜底落地后,**Agent 模式不再局限于本地 zsh/bash**:任意 POSIX shell 的远端 SSH 会话,探针通过即自动可用。

自动化基线(**本轮末四项全部重跑**):

| 检查 | 结果 |
| --- | --- |
| `cd src-tauri && cargo test` | 162 passed / 0 failed(18 个测试目标;本轮零 Rust 改动) |
| `cd frontend && npx vue-tsc --noEmit` | exit 0 |
| `cd frontend && npm run test:scripts` | **92 / 92**(上一轮 82,本轮补 10 例超时行为用例) |
| `cd frontend && npm run test:ui` | passed(本轮新增 2 组契约断言) |

工作区状态:分支 `feature/agent-mode` 上共 8 个提交,**均未 push**:

| 提交 | 内容 |
| --- | --- |
| `ae4ccba feat: add agent mode` | 阶段 1 主体(协议层、存储迁移、循环编排、判定器、捕获原语) |
| `0cee83c feat(agent): add agent turn command, step cards and allowlist settings` | 阶段 1 收尾:命令层、模式选择器与步骤卡片、设置中心 Agent 区块、样式;含「总是允许」多段命令修复与 `AgentStepCard.vue` 组件化 |
| `bfe6091 feat(agent): raise turn budget and auto-run readonly commands by default` | 阶段 1.5 ①–④(提示词、预算与压缩、步数上限、只读默认自动执行) |
| `95ace56 docs(agent): record autonomous exploration changes and acceptance list` | 文档与设计文档同步 |
| `aff5bb7 feat(agent): capture remote command output via printf sentinel fallback` | 阶段 2 哨兵兜底(见 §1.4);零 Rust 改动 |
| `01e7640 docs(agent): record sentinel fallback design, acceptance matrix and open items` | 文档同步 |
| `feat(agent): add step countdown, timeout heuristics and task budget settings` | 阶段 2 超时体验与任务预算设置 + 配套自动化(见 §1.3);零 Rust 改动 |
| `docs(agent): close the automation backlog for the timeout UX round` | 本文档同步 |

每个代码提交都单独跑过完整检查:`0cee83c` 为 cargo 162 / 前端 63 / tsc 0 / ui-check 通过,`bfe6091` 为 64 基线,`aff5bb7` 为 82 基线,本轮为 92 基线。

## 1.3 超时体验与任务预算设置(设计文档 10.3.2)

阶段 2 的剩余体验项。**纯前端,零 Rust 改动**,也未触碰哨兵/OSC 133 两条捕获路径本身(只是开始消费它们早就提供的 `peekOutput()`),因此对已工作的本地 zsh 路径无回归面。

| # | 改动 | 位置 |
| --- | --- | --- |
| ① | `AgentStep.deadlineAt`(下次询问时刻)、`AgentRunState.commandTimeoutMs`、新类型 `AgentTimeoutInfo` | `types/agent.ts` |
| ② | 执行期按 `outputSampleIntervalMs`(默认 2s)轮询 `peekOutput()` 长度记录静默时长;派发瞬间先采基线,超时时再采一次 | `lib/agentLoop.ts` `executeStep` |
| ③ | 导出纯函数 `looksLikeInteractivePrompt` / `describeTimeoutHint`,三分支文案(仍在输出 / 疑似等待输入 / 可能卡住)+ 停止语义说明 | `lib/agentLoop.ts` |
| ④ | `requestTimeoutDecision(step, waitedMs)` → `(step, info)`;超时选停止时把 `partialOutput` 写进 `step.output` | `lib/agentLoop.ts`、`AiPanel.vue` |
| ⑤ | `deadlineAt` 派发即置、「继续等待」推后并 `notify()`、步骤结算时清除(因此不进 `payloadJson`) | `lib/agentLoop.ts` |
| ⑥ | 卡片倒计时(`剩余 Xs` / `即将询问`)、超时块改渲染 `hint` 与部分输出;时钟由 AiPanel 的单个 1s ticker 经 `nowMs` 注入 | `AgentStepCard.vue`、`AiPanel.vue` |
| ⑦ | `agentStepLimit`(1–25/默认 25)、`agentCommandTimeoutSec`(15–600/默认 120)进 `AppUserSettings`,三处夹取;设置中心新增「任务预算」块;`AppShell → WorkspacePanel → AiPanel` 透传并传入 `runAgentTask` options(此前是 `{}`) | `AppShell.vue`、`SettingsSidebar.vue`、`WorkspacePanel.vue`、`AiPanel.vue` |
| ⑧ | 样式 `.agent-step-countdown` / `.agent-timeout-partial` / `.agent-budget-block`(`.theme-light` 只覆盖 countdown 的颜色,另两条是纯几何,按文件既有约定不重复) | `styles.css` |

顺手订正了 `AppShell.vue` / `SettingsSidebar.vue` 里"`agentAutoExecReadonly` 默认关"的陈旧注释(改的正是这两行所在的接口)。

### 1.3.1 配套自动化(补齐上一轮的遗留)

`agent-loop.test.mjs` 82 → **92**,新增 10 例覆盖本轮全部新行为:

| 用例 | 锁住的行为 |
| --- | --- |
| `deadlineAt` 派发即置位、完成后清除 | 置位值落在 `[派发时刻 + timeout]` 区间;终态清除,保证不随 `payloadJson` 落库 |
| `deadlineAt`「继续等待」推后 | 两次超时询问拿到的 `deadlineAt` 严格递增且相差 ≥ 一个超时周期 —— 倒计时复位的可观测证据 |
| `outputGrowing` 为真 | 采样周期远大于超时,判据只由派发基线与超时采样决定;文案走「仍在持续输出」且不附停止语义 |
| 静默旧输出 + `likelyInteractive` | **基线采样的回归**:派发前就存在的输出不得在超时那一刻被误判成刚刚增长 |
| 静默且非提示符 | 走「可能仍在运行或已卡住」分支并附停止语义 |
| 超时停止保留部分输出 | `step.output` 等于尾部 500 字符,且 `handle.cancel()` 恰好一次(放弃等待不终止命令) |
| `peekOutput` 抛错 | 按"无新输出"处理,任务收尾为 `stopped` 而非 `error` |
| `looksLikeInteractivePrompt` 正例 10 条 | 密码/口令(中英)、`[y/N]`、`(yes/no)`、以 `:` `?` `>` 收尾 |
| `looksLikeInteractivePrompt` 反例 7 条 | 以换行结尾、空串、普通输出 |
| `describeTimeoutHint` 三分支 | 各自成文;停止语义只附在后两个分支 |

`production-ui-check.mjs` 新增 2 组断言(共 28 个 conjunct):卡片必须从 `deadlineAt` + 注入的 `nowMs` 渲染倒计时且**自身不持定时器**、超时块渲染 `hint` 与部分输出、`payloadJson` 只在终态写入;循环的超时依据必须来自 `peekOutput` 采样;`AiPanel` 不得以空 options 调 `runAgentTask`,两个预算字段三处夹取齐备。

**变异验证**:两个套件逐条做过变异验证,确认非空转 —— ui-check 的 28 个 conjunct 与 loop 测试的 8 处行为变异全部被捕获。唯一未被捕获的是 `looksLikeInteractivePrompt` 里 `/\n\s*$/` 前置守卫的移除,经推导确认这是**等价变异**而非覆盖缺口:守卫为真时,`split('\n').pop()` 取到的必然是纯空白,随后的 `if (!lastLine) return false` 会给出同样结果。该守卫保留下来是为了表达"提示符停在行内不换行"这一前提。


## 1.4 哨兵兜底,远端 SSH 可用(设计文档 10.3.1)

此前 `runCommandAndCapture` 开头即 `if (!tracker?.sawMarkers) return agentDispatchFailure(...)`,而 OSC 133 标记只在本地 shell 启动时由 `apply_shell_integration` 通过 `ZDOTDIR` / `--init-file` 注入 —— SSH 启动的是 `ssh` 而非 shell,远端拿不到注入。**作为 SSH 终端产品,Agent 模式此前在主场景里用不了。**

本轮之前的一轮实施了哨兵包装兜底(机制与设计取舍见设计文档 10.3.1),**零 Rust 改动,纯前端**:

| # | 改动 | 位置 |
| --- | --- | --- |
| ① | 哨兵捕获模块:`wrapCommandWithSentinel` / `createSentinelScanner`(`waiting-begin → collecting → done` 状态机、跨 chunk carry、ANSI 剥离、CRLF 归一、裸 `\r` 进度条按行重置、有界收集与头部丢弃降级) | 新增 `lib/agentSentinelCapture.ts` |
| ② | 结构安全守卫 `isSuffixSafeForSentinel`,复用既有引号感知扫描器;`CommandScan` 补 `trailingOperator` 标志 | `lib/agentAutoApprove.ts` |
| ③ | 扫描器 sink 挂在**既有** `onTerminalData` 回调(全部 PTY/SSH 输出进入 JS 的唯一咽喉点)—— 复用订阅,因此不存在"订阅晚于派发"的丢数据窗口 | `TerminalPane.vue` `attachTerminalEvents` |
| ④ | `runCommandAndCapture` 拆为 `captureWithMarkers`(原 OSC 133 语义,含 `commandMismatch`)与 `captureWithSentinel`(不设 mismatch);首次走哨兵时惰性触发探针 | `TerminalPane.vue` |
| ⑤ | 能力探针 `ensureAgentCapture()`:`(exit 7)` 往返验证,8s 超时,按 sessionId 缓存,探测中会话切换即失效 | `TerminalPane.vue` |
| ⑥ | `executeCommand` 增加 `historyCommand` 替身参数 —— 派发包装命令、历史记干净命令 | `TerminalPane.vue` |
| ⑦ | 可用性文案改写:不再断言"远端不可用";切到 Agent 模式时异步探测并回填提示,`startAgentTask` 再兜一次 | `AppShell.vue` / `AiPanel.vue` / `WorkspacePanel.vue` |

**两条捕获路径产出同一个 `AgentCommandHandle`**,因此 `agentLoop.ts`、`AiPanel.vue`、`AgentStepCard.vue` 的循环与 UI 逻辑一行未改。

新增 `scripts/agent-sentinel-capture.test.mjs`(18 例):回显不误匹配、`history`/`ps` 撞见自身、跨 chunk 切分(begin 与 end 各一)、逐字符投喂、ANSI/OSC + CRLF、输出不以换行结尾、退出码 0/1/7/127/130、裸 `\r` 进度条、截断与 `peekOutput`、`dispose`、探针命令、守卫接受/拒绝用例。`production-ui-check` 新增两组断言锁死核心契约(nonce 走 `%s`、退出码限数字、sink 接在咽喉点、守卫在位、历史记干净命令、可用性走异步探针);**10 条断言逐条做过变异验证,确认非空转**。

## 1.5 阶段 1.5 完成:自主探索能力(设计文档 10.2)

针对"Agent 只执行一条命令就收尾、不像 Claude Code 那样自主探索"的实测问题,按已确认的自主档位 **「只读自动 + 写操作审批」** 实施了 ①–④;⑤`update_plan` 工具按原计划留待效果验证后再评估。

| # | 改动 | 位置 | 生效值 |
| --- | --- | --- | --- |
| ① | 系统提示词重写:从"规则"改为"工作方式",新增自主推进、不停在第一个看似合理的结果、能查到的别问用户、证据不足时继续查;保留全部安全条款并说明只读自动执行/危险命令等审批。工具描述同步 | `domain/ai/agent.rs` `build_agent_system_prompt` / `run_command_tool_definition` | 9 条 |
| ② | 上下文预算放大 + 压缩策略改良:压缩后保留**退出码 + 输出尾部 300 字符**(原为整体丢弃),防膨胀保护保留 | `agent.rs` `MAX_AGENT_TURN_CHARS`;`lib/agentLoop.ts` `DEFAULT_MAX_TURN_CHARS` / `PROTECTED_RECENT_TURNS` / `COMPRESSED_OUTPUT_TAIL_CHARS` | 后端 80k、前端 24k 软预算、保护 6 轮、尾部 300 |
| ③ | 步数上限提升,收尾文案提示可续跑 | `agentLoop.ts` `DEFAULT_STEP_LIMIT` | 10 → 25 |
| ④ | 只读命令默认自动执行 | `AppShell.vue` `defaultUserSettings` | `agentAutoExecReadonly: true` |

**前后端预算是一对约束**:前端 24k 软预算 < 后端 80k 硬上限,保证长任务由前端先压缩,而不是后端直接 bail 报"任务轮次过长"。`production-ui-check` 已加断言锁死这个不等式,连同保护轮次 ≥6、步数 ≥25、默认自动执行、提示词关键词一并校验。

新增/更新测试:轮次压缩改测"保留退出码与尾部标记 TAIL-MARKER、最近 6 轮原样",新增"短输出不会因压缩而膨胀"(验证防膨胀保护);63 → 64。

## 1.6 历史 P0 缺陷:敏感文件读取自动执行(已修复)

历史上 `cat ~/.ssh/id_rsa` 会被自动执行、不经审批,输出送模型并落库。现已通过 `pathPrivacy.ts` 修复:命令参数命中敏感路径时强制人工审批,敏感步骤输出持久化为占位文本。

成因是三个模块各自都没覆盖"读什么文件"这件事:

| 模块 | 实际覆盖范围 | 对 `cat ~/.ssh/id_rsa` 的判定 |
| --- | --- | --- |
| `isSensitiveCommand`(`commandPrivacy.ts`) | 只匹配**命令文本里出现的机密**:`--password=`、`Authorization:`、`TOKEN=`、凭据 URL、私钥 PEM **正文** | `sensitive: false` |
| `analyzeScriptRisks`(`scriptRisk.ts`) | 只覆盖**破坏性**操作(delete / edit / reboot / upgrade) | `risks: []` |
| `classifyForAutoExec`(`agentAutoApprove.ts`) | `cat` 在 `BUILTIN_READONLY_COMMANDS` 且无禁用参数 | `eligible: true` |

三项叠加 → 走 6.4 判定顺序的第 4 档"自动执行"。`agentAutoExecReadonly` 自阶段 1.5 起默认 `true`,因此**开箱即中**。

与文档的冲突:

- 设计文档 §9「敏感/风险命令始终人工」
- 设计文档 §7「敏感命令的步骤在持久化时把 `output` 置为『[敏感命令输出未存储]』」—— `isSensitiveCommand` 不命中,于是私钥内容**会原样进 `payloadJson`**
- 本文档 §5.3 验收第 3 条 —— 已具备实现,仍需真实终端手工回归

影响面不限于 `.ssh`:`.env`、`.aws/credentials`、`.kube/config`、`.netrc` 同理。注意这是**阶段 1.5 放开自动执行时就存在的缺口**,与超时体验那一轮无关;阶段 3 的 `read_file` 会放大它(那是个"读任意文件"的工具),所以定为该阶段的前置。

当前实现已补齐 `pathPrivacy.ts`、命令参数隐私扫描、敏感输出持久化脱敏和对应单测;这项不再是未办事项,仍需在真实终端完成手工回归。


| 项 | 问题与修复 |
| --- | --- |
| **「总是允许」失效(功能 bug)** | 判定器要求**每一段**都被覆盖,按钮却只建议**第一段**。`memory_pressure \| tail -n 8; printf …` 点了「总是允许 memory_pressure」后 `printf` 段仍未覆盖 → 下次照旧弹审批。改:`classifyForAutoExec` 返回 `suggestedPatterns[]`(列出仍需补充的全部 pattern,已覆盖的段不列),循环侧 `execute-and-allow` 逐个落库;一票否决的命令返回空数组 → **按钮不再显示**(此前会显示一个点了也无效的按钮) |
| 命令输出被裁 | 输出块原用 `pre-wrap`+`word-break`,`df -h` 类表格折行即毁列对齐,再被 `.message{overflow:hidden}` 裁掉。改为 `white-space: pre` + 自带滚动容器 |
| markdown 文字越界 | `.markdown-content ul/ol` 是 grid,**grid 子项默认 `min-width: auto`**,含行内代码的长列表项撑破容器被裁。补 `min-width: 0` |
| 审批按钮溢出 | 窄面板放不下四个按钮。改为可换行;「总是允许」独立收缩 + 省略号(完整清单在 title);高风险改为**风险确认弹窗**,支持逐行风险标记和 AI 风险分析 |
| 步骤卡片信息 | `exit 0` 与状态标签相连 → 收进右对齐的 `.agent-step-meta`,并补上一直采集却未展示的 `durationMs`;新增「（无输出）」占位 |
| **模块化** | 新建 `components/AgentStepCard.vue`,卡片展示与审批交互整体迁出,AiPanel 只保留编排;5 个展示辅助函数随之内聚 |
| 回归护栏 | `production-ui-check.mjs` 新增 3 组断言:输出块禁用 `pre-wrap`、按钮必须可换行可省略、「总是允许」必须覆盖所有段。逐条验证非空转 |
| 新增测试 | `agent-auto-approve` 多段命令建议(直接复现用户上报命令)、`agent-loop` 多 pattern 落库、`path-privacy` 敏感路径;61 → 63(路径单测另计) |

### 3.1 最近一轮 UI 体验强化（已完成）

| 模块 | 交付 |
| --- | --- |
| 风险审批 | Agent 的风险/敏感命令统一进入与普通对话一致的风险确认弹窗,可查看风险行、调用 AI 分析、确认执行/跳过/停止 |
| 命令与输出 | Agent 命令/输出区增加分区标题、横向滚动和放大查看弹窗;放大弹窗只读,拖拽选中文字不会误关闭 |
| 结果卡片 | 普通 AI 结果卡片与 Agent 步骤卡统一容器节奏,复制按钮归入输出栏 |
| 设置侧栏 | 设置分类改为紧凑 Tab;Agent 设置内容独立滚动,窄侧栏自动使用图标 Tab,浅色主题补齐可见性 |

## 3. 阶段 1 实现明细(命令层 / UI / 设置 / 样式)

| 任务 | 交付 | 状态 |
| --- | --- | --- |
| B3+B5 命令层 | state.rs 四个允许列表包装(照 `save_ai_conversation_message` 模式);commands.rs 新增 `ai_agent_turn_stream`(照 `chat_with_ai_provider_stream` 模板,复用 ai-chat 流事件通道,`history_count: None`)与四个允许列表命令;lib.rs 显式 `use` 列表 + `invoke_handler` 均按字母序注册五项 | ✅ `cargo test` 全绿(84 单测 + 全部集成套件,18 个测试目标 0 failed) |
| F4 模式选择器 | AiPanel:props/emits 声明(与 WorkspacePanel 既有传参逐字对齐)、`panelMode`/`agentRunActive`/`composerBusy` computed、`selectPanelMode`(运行中禁切、切换即查可用性)、composer 左下分段控件、按模式变化的 placeholder、`composerPrimaryAction` 统一路由发送/停止、Ctrl+Enter 按模式分派、`sendMessage` 加 agent 模式早退保护 | ✅ 代码完成 |
| F5 任务驱动 + 步骤卡片 | AiPanel `startAgentTask`:任务-终端绑定(`boundTerminalId`)、组装 `AgentLoopDeps` 全部七个回调、每轮独立 requestId 并用 120ms 轮询把 `signal.cancelled` 传导为 `cancelTask`、`classifyStep` 三合一判定并在真正自动执行时 `touchAgentCommandAllowlistEntry`、`syncAgentRunToMessage` 终态写 `payloadJson`、完成时生成会话标题;模板:步骤卡片(状态/自动执行标注/风险 chip/敏感/exit code/理由/命令/输出/审批与超时按钮)、风险确认弹窗、流式文本、任务状态展示 | ✅ 代码完成 |
| F6 hydrate | AppShell `hydrateAiMessagePayload`:加载会话消息时解析 `payloadJson` 还原 `mode/agentSteps/agentStatus`,非 agent 或解析失败按纯文本降级 | ✅ 代码完成 |
| F8 设置区块 | SettingsSidebar:新增 `agent` 分区(shield 图标)、`agentAutoExecReadonly` 开关、内置集完整枚举(只读 chips + 危险参数说明)、允许列表表格(pattern/来源/命中统计/删除)、清空、手动添加(经 `validateAllowlistPattern`);AppShell:`agentAllowlist` 传参与 `deleteAgentPattern`/`addAgentPattern`/`clearAgentPatterns` 接线,`clearAgentAllowlist` 实现 | ✅ 代码完成 |
| 样式 | styles.css 追加约 480 行:`.ai-mode-switch`(对称于发送按钮的左下绝对定位)、`.agent-mode-notice`、`.agent-steps`/`.agent-run-status`/`.agent-step-card` 全套(按 status 变左边框色)、`.agent-action` 按钮组、设置区块样式,并配齐 `.theme-light` 覆盖(遵循文件既有 `.app-shell.theme-light X, .theme-light X` 双选择器约定) | ✅ 代码完成 |
| 文档同步 | 设计文档 6.4:`classifyForAutoExec` 签名更新为实际实现;分段器改为自包含(附不复用 `scriptExecution.ts` 的理由);一票否决补进程替换、危险环境变量前缀、历史展开;内置集清单整节重写为以 `BUILTIN_READONLY_COMMANDS` 为准并列出条目级禁用参数 | ✅ 完成 |

## 4. 完整实现清单(累计)

后端:`domain/ai/agent.rs`(协议层,18 单测)、`chat.rs`(仅 pub(crate) 可见性)、`domain/workspace/mod.rs` + `storage/schema.sql` + `storage/sqlite.rs`(两列迁移 + 允许列表表与 CRUD)、`app/state.rs` + `app/commands.rs` + `lib.rs`(命令层)、`tests/agent_storage.rs`。

前端:`types/agent.ts`(新;含 `AgentTimeoutInfo`、`AgentStep.deadlineAt`)、`types/workspace.ts`(扩展)、`lib/agentLoop.ts`(新,**28 测试**;含输出静默采样与 `looksLikeInteractivePrompt` / `describeTimeoutHint`)、`lib/agentAutoApprove.ts`(新,含 `isSuffixSafeForSentinel` 与隐私 token 扫描)、`lib/pathPrivacy.ts`(敏感路径门)、`lib/agentSentinelCapture.ts`(新,18 测试)、`lib/shellIntegration.ts`(`armCommandCapture`,19 测试)、`lib/tauri.ts`(5 个 IPC 包装)、`components/TerminalPane.vue`(`runCommandAndCapture` / `agentCaptureSupported` / `ensureAgentCapture`,两条捕获路径)、`AiPanel.vue`(含风险弹窗、AI 风险解释和 1s 倒计时 ticker)、`AppShell.vue`(含 Agent 预算设置与夹取)、`WorkspacePanel.vue`、`SettingsSidebar.vue`(含任务预算与允许列表管理)、`AgentStepCard.vue`(含放大查看与自绘滚动条)、`styles.css`、`package.json`(测试套件)。

## 5. 统一验收清单(需真实模型网关)

自动化检查已全绿(见 §1)。以下为需要真实网关的人工验收,分三组。

### 5.1 自主探索能力(设计文档 10.2)

这一组检验阶段 1.5 是否达到目的——判据是"像不像 Claude Code 那样自己往下查"。

| # | 操作 | 期望 | 不达标说明 |
| --- | --- | --- | --- |
| A1 | 提一个需要多步排查的目标,如「查一下是什么在占内存」 | Agent **连续自动执行多条只读命令**(ps / vm_stat / ls 等)不打断你,最后给出有证据支撑的结论 | 若仍只跑 1 条就收尾 → ① 提示词未生效或模型不遵循,记录实际模型名 |
| A2 | 观察 A1 的步骤卡片 | 只读命令带「自动执行」标注;整个过程你一次都不用点「执行」 | 若每条都弹审批 → ④ 默认值未生效(检查设置中心开关是否被历史配置覆盖) |
| A3 | 让任务持续到 10 步以上 | 不再在第 10 步停止;到 25 步才收尾并提示"可在下一条消息里让 Agent 接着排查" | ③ 未生效 |
| A4 | 长任务(10+ 条命令、输出较大)跑到后期,问 Agent「你前面第一条命令看到了什么」 | 仍能答出早期发现(压缩保留了退出码与输出尾部) | ② 压缩过度或预算未生效 |
| A5 | 同上长任务 | **不出现**"任务轮次过长"错误 | 前后端预算不等式被破坏(前端应先压缩) |
| A6 | 观察 token 用量/网关账单 | 前端以 24k 软预算压缩旧证据,后端保留 80k 硬上限;若网关报单请求超限,优先下调 `DEFAULT_MAX_TURN_CHARS`,必要时再下调 `MAX_AGENT_TURN_CHARS`(保持前端 < 后端) | 已知风险,见设计文档 10.2 风险栏 |

### 5.2 哨兵兜底(**需真机**)

自动化只能验逻辑,这一组必须在真实终端与真实远端上手工过一遍:

| # | 场景 | 期望 | 不符时看哪 |
| --- | --- | --- | --- |
| B1 | **本地 zsh(有标记)** | 走原 OSC 133 路径,行为与改动前**完全一致**(核心回归 —— 哨兵不得介入已工作的路径) | `agentCaptureMode()` 是否误判;确认未派发 `printf` 包装 |
| B2 | SSH 到 Linux bash/sh | 探针通过,Agent 可用,多步任务闭环,退出码正确 | 看终端里探针那行的实际回显与返回 |
| B3 | SSH 到装了 starship 的远端 | 仍走标记路径,不启用哨兵 | `sawMarkers` 判定 |
| B4 | SSH 到 fish shell | 探针失败,给出明确不可用文案,**不误派发** | 探针超时/退出码非 7 的分支 |
| B5 | 远端长输出(`cat` 大文件) | 截断生效,标记仍被识别,不吞结束标记 | `COLLECT_LIMIT_FACTOR` 与头部丢弃降级 |
| B6 | 捕获期间用户手敲命令 | 不污染捕获结果(结束标记只由我们那行产生) | — |
| B7 | 命令历史 | 记录的是**干净命令**,不是包装后的长命令 | `historyCommand` 替身参数 |
| B8 | 远端跑 `docker pull` 一类带进度条的命令 | 输出不被每一帧刷屏塞满(裸 `\r` 按行重置) | `appendCollected` |

### 5.3 安全姿态未被放宽(回归,必验)

放开自主性后**必须确认这些仍然拦得住**:

1. `rm -rf` 等高风险命令仍停下等审批,并打开风险确认弹窗
2. `sudo` 开头、`cat a > b`(写重定向)、含 `$( )` 的命令**不自动执行**,且不显示「总是允许」按钮
3. 敏感命令(如 `cat ~/.ssh/id_rsa`)始终人工审批,不提供「总是允许」;敏感路径输出不写入持久化 payload
4. 破坏性操作前 Agent 仍先用只读命令确认目标(提示词第 5 条)
5. 命令被跳过后 Agent 换思路,不原样重发(提示词第 7 条)

### 5.4 阶段 1 基础功能(设计文档 10.1)

1. 模式切换与会话级持久化(切到 Agent、重开应用仍是 Agent)
2. 审批执行闭环:模型提命令 → 卡片 → 执行 → 输出与退出码回传 → 下一步
3. 跳过与停止(模型请求中 / 等审批 / 执行中三个时机各试一次)
4. 命令超时后「继续等待 / 停止任务」
5. 「总是允许」:对**多段命令**(如 `memory_pressure | tail -n 8; printf 'x'`)点一次后,同类命令下次应自动执行——上一轮修复的正是此处
6. 设置中心可见允许列表来源与命中统计,删除后恢复人工审批
7. 不支持 tools 的网关给出明确报错与切换建议
8. 命令输出为表格(`df -h`)时列对齐不被破坏,超宽可横向滚动

**回归重点**:普通对话模式行为应与改动前完全一致(发送、停止、命令点击执行、会话标题、上下文压缩)。

### 5.5 超时体验与任务预算(设计文档 10.3.2)

循环侧逻辑已被 §1.3.1 的 10 例单测覆盖;下表是**只能手工验**的界面表现部分:

| # | 操作 | 期望 |
| --- | --- | --- |
| C1 | Agent 模式跑 `sleep 200`(需人工审批放行) | 步骤卡片右侧出现倒计时并每秒递减;归零前显示「即将询问」 |
| C2 | 等到超时块出现 | 文案给出依据:「已运行 Xs,最近 Ys 无新输出,命令可能仍在运行或已卡住」+ 停止语义说明 |
| C3 | 点「继续等待」 | 倒计时**复位到满**(这是"重置计时"的可见化),任务继续等待 |
| C4 | 跑一条持续输出的命令(如远端 `ping`)等到超时 | 文案应是「命令仍在持续输出」,而不是「无新输出」 |
| C5 | 跑一条会问确认的命令(尾部停在 `[y/N]` / `Password:`) | 文案应命中「末尾像是在等待你的输入」,并提示可切到终端手动响应 |
| C6 | 超时后点「停止」 | 步骤卡片保留已捕获的部分输出(此前只剩一条命令) |
| C7 | 设置中心把超时改成 20s、步数改成 3 | 新任务按新值生效(20s 就询问、3 步收尾);填 0 或超范围会被夹取回合法区间 |
| C8 | 任务结束后重开应用 | 步骤时间线正常还原,且**不含** `deadlineAt` 残留(该字段不入库) |

## 6. 注意事项

1. 改动已按语义分多个提交落地(见 §1),**尚未 push**。`.claude/settings.json` 与 `.DS_Store` 刻意未入库:前者含本机绝对路径与会话累积的临时授权,属 `.claude/settings.local.json` 范畴。
2. `AgentCommandHandle.cancel` 只放弃等待、不 kill 命令;超时逻辑在 agentLoop 侧。
3. 命令不匹配检测中,捕获命令为空串视为"未知",不判串扰(无 633;E 的远端 shell 兜底)。**哨兵路径不做此检测**:结束标记只可能由我们派发的那一行产生,用户手敲的命令伪造不了。
4. agent 消息的 `mode/agentSteps/agentStatus` 是运行时字段,仅 `payloadJson` 落库,靠 §3 的 hydrate 还原。
5. Agent 模式的捕获走两条路径:有 OSC 133 语义标记(`sawMarkers`,本地 zsh/bash 自动注入)时走原路径;否则由 `ensureAgentCapture()` 探针决定是否启用哨兵兜底(见 §1.4)。两者都不可用时 `agentAvailabilityCheck` / `agentAvailabilityConfirm` 给出提示且不允许发起任务。
6. Rust 侧依赖 serde 的 `rename_all_fields`(≥1.0.186),勿降级。
7. **前后端轮次预算是一对约束**:前端 `DEFAULT_MAX_TURN_CHARS`(24k 软预算)必须小于后端 `MAX_AGENT_TURN_CHARS`(80k 硬上限),否则长任务会由后端 bail 报错而非前端压缩。改动任一侧都要同步另一侧,`production-ui-check` 有断言把关。
8. `agentAutoExecReadonly` 默认已改为 `true`。若本地 `localStorage` 里存过旧设置(值为 `false`),合并时会沿用旧值——验收 A2 不通过时先查设置中心开关。同理,本轮新增的 `agentStepLimit` / `agentCommandTimeoutSec` 对老配置缺失,`loadUserSettings` 会补默认值并夹取。
9. 阶段 1.5 的 ⑤`update_plan` 工具**未实施**,按计划等 ①–④ 效果验证后再评估是否需要。
10. **哨兵包装会让终端里回显的命令变长**(`printf …; <原命令>; printf …`),与步骤卡片上展示的干净命令不一致。这是哨兵方案的固有代价,用户看到的仍是真实执行的内容。仅在无 OSC 133 标记时发生。
11. `AgentStep.deadlineAt` 是**运行态字段**:步骤结算时清除,不进 `payloadJson`,因此历史消息还原后不会出现残留倒计时。
12. 超时静默判断依赖 `AgentCommandHandle.peekOutput()`,采样只比对字符串长度;`peekOutput` 抛错时按"无新输出"处理,不中断循环。
13. `looksLikeInteractivePrompt` 里的 `/\n\s*$/` 前置守卫在行为上被后续的"末行为空即返回 false"覆盖(等价代码),保留是为了表达"提示符停在行内不换行"这一前提 —— 变异测试会把它报成未捕获,属预期。

## 7. 未办事项

按优先级排列。**自动化已无欠账**,剩余全部是人工验收与后续阶段。

允许命令的管理入口已落在 **设置 → Agent 模式 → 总是允许列表**:支持查看来源与命中统计、手动添加、删除单条和清空全部。该列表是全局执行策略,不按单个会话重复配置。

| # | 事项 | 说明 |
| --- | --- | --- |
| 0 | ~~修复敏感文件读取被自动执行(§1.6)~~ | 已完成:路径敏感度门接入 Agent 判定,敏感输出不落库 |
| 1 | **哨兵兜底真机验收(§5.2 B1–B8)** | 自动化只覆盖逻辑,真实远端行为必须手工过一遍。**B1 本地 zsh 回归最关键**——哨兵不得干扰已工作的 OSC 133 路径 |
| 2 | **统一验收(§5.1 / 5.3 / 5.4 / 5.5)** | 需真实模型网关,自阶段 1 起就未做过 |
| 3 | 阶段 3 第一项 `read_file` / `list_directory` | 方案已批,见 §8;第 0 步是其前置 |
| 4 | push 分支 `feature/agent-mode` | 9 个提交均未 push |
| 5 | 阶段 1.5 ⑤ `update_plan` 工具 | 按计划等 ①–④ 效果验证后再评估是否需要 |
| 6 | 设计文档 10.3 剩余项 | 只剩「允许列表按连接维度细分」(标注为可选) |
| 7 | PowerShell / cmd 捕获方案 | 哨兵探针会正确报不可用,但这两类远端目前仍无 Agent 能力 |
| 8 | 设计文档 10.4 阶段 3 剩余 | `write_file` 带 diff 预览、"沉淀为脚本"、SSH 远端 integration 注入 |
| 9 | `.DS_Store` 未入 `.gitignore` | 一直以未跟踪状态留在仓库根,未扩大改动范围去处理 |

## 8. 下一步已批方案:阶段 3 第一项 `read_file` / `list_directory`

用户已选定先做设计文档 §10.4 的第一项(也是 `write_file` 的前置),方案已评审通过。路径敏感度门这一前置已完成;**阶段 3 工具代码仍未开始。**

### 第 0 步(前置):路径敏感度门 —— 修复 §1.6（已完成）

新增 `frontend/src/lib/pathPrivacy.ts` 导出纯函数 `isSensitivePath(path)`,匹配私钥与凭据文件:`~/.ssh/id_*`(排除 `.pub`)、`.pem` / `.key` / `.p12` / `.pfx`、`.env` 系列、`.aws/credentials`、`.kube/config`、`.docker/config.json`、`.netrc`、`.npmrc` / `.pypirc`、`shadow` / `sudoers`、浏览器与钥匙串库。

接入两处:`classifyStep`(AiPanel 装配处,从命令 token 里抽路径参数——**复用 `agentAutoApprove.ts` 既有的引号感知分段器 `scanCommand`,不要另写扫描器**),以及文件工具的 `path` 参数。命中即走既有敏感分支:人工审批、无「总是允许」、输出不落库。

**这一步已独立交付并通过路径单测**:验收 §5.3.3 已具备实现,仍需真实终端手工回归。阶段 3 后续可在此基础上继续。

### 范围边界:bastion 连接不暴露文件工具

SFTP 命令按 `connection_id` 解析 profile(`commands.rs` 的 `sftp_profile`),而跳板目标(`targetHost`/`targetUsername`)是 `FileTransferPanel` 的**面板内状态**(`FileTransferPanel.vue:243`),AiPanel 拿不到。bastion 场景下终端可能在跳板后的目标机上,不带 override 的 SFTP 会去读**跳板机本身**——读错机器且静默。因此只对直连(`connectionRole === 'direct'`)与本地开放;bastion 下让模型退回 `run_command` 的 `cat`/`ls`,那条路始终在真实终端里跑。

### 其余步骤要点

| 步骤 | 要点 |
| --- | --- |
| 后端工具定义 | `agent.rs:192` 的 `"tools": [...]` 追加两项;**SSE 累积器已 name-agnostic(原样透传 `call.name`),无需改解析**;系统提示词补"排查系统状态仍用 run_command" |
| 后端缺口 | `filesystem/local.rs` 有 `list_directory` 但**没有读文件函数**,需新增 + Tauri 命令;守卫复用 `sftp.rs` 的 `validate_remote_text_bytes`(2MB 上限 / NUL 判二进制 / UTF-8),**提到共享位置而非复制** |
| 远端 | 零新增:`sftp_read_text_file` / `sftp_list_directory` 已具备,自带超时与取消令牌 |
| 循环分发(核心) | `handleToolCall` 目前**完全不看 `toolCall.name`**,无条件按 run_command 解析。改为按 name 分发;`AgentStep.tool` 设为**可选且缺省视为 `run_command`**,否则老 `payloadJson` 的 hydrate 会坏;未知工具名走 `invalid_arguments` 同款回传 |
| 超时 | 文件步骤**仍要 `raceCommandResult` 三方竞速**(dep 由 AiPanel 注入,Promise 可能永不 resolve,须保证停止随时可用),但**不跑 `peekOutput` 采样与 `deadlineAt` 倒计时**——文件读取无增量输出 |
| 抽象度 | 3 个工具不值得"工具描述符表",`switch` + 两个小函数即可 |
| 卡片 | 按 `step.tool` 分支;**必须显式标注通道与目标主机**——文件工具绕过终端,与设计文档 §2.1「命令始终在用户可见终端执行」有张力,标注是对该承诺的补偿 |
| 自动执行 | 沿用同一个 `agentAutoExecReadonly` 开关(不无条件自动),敏感路径一票否决 |

### 已知风险

- **透明性折衷**:文件读取不经终端。若认为不可接受,替代方案是让工具在终端里跑 `cat`——但那样相对 `run_command` 就只剩"结构化返回"一点价值。
- `read_remote_text_file` 是**先整文件下载到临时文件再校验大小**,超大远端文件会先付下载代价才被拒(既有编辑器行为,本期不改)。
