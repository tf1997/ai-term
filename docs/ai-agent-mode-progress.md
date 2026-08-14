# AI Agent 模式开发进度(交接文档)

更新:2026-08-13。配套设计文档:[ai-agent-mode-development.md](./ai-agent-mode-development.md)(下称"设计文档"),节号均指该文档。

## 1. 一句话状态

**协议层、存储层、执行捕获层、纯逻辑层全部完成且测试全绿;剩 Tauri 命令注册(B3,半小时级)、AiPanel 的 agent UI(F4/F5,最大剩余块)、消息 hydrate(F6 收尾)、设置区块(F8)和样式。** 当前工作区可编译:`cargo test` 162 通过、`vue-tsc --noEmit` 零错误、前端 `npm run test:scripts` 61/61 通过。现有 chat 功能行为未变。

## 2. 已完成(均已验证)

| 任务 | 交付物 | 验证 |
| --- | --- | --- |
| 设计文档 | docs/ai-agent-mode-development.md(含分级审批、Claude Code 式允许列表) | — |
| 类型契约 | frontend/src/types/agent.ts(新);types/workspace.ts 扩展(WorkspaceSession.aiMode、AiMessage.mode/agentSteps/agentStatus/payloadJson) | vue-tsc |
| B1+B2 协议层 | src-tauri/src/domain/ai/agent.rs(新):请求/轮次类型(serde camelCase,`AiAgentTurn` tag=kind)、工具定义与系统提示词(5.1/5.4)、payload 组装(5.3,含 tool 配对校验与 skipped 自动补发)、SSE tool_calls 按 index 累积 + 非流式兜底 + arguments 对象归一化、轮次超限 bail(24k)、网关不支持工具提示(5.7)。入口 `agent_turn_with_provider_stream`(agent.rs:83)。chat.rs 仅 16 项 pub(crate) 可见性调整 | 18 个新单测,cargo test 162 全绿 |
| B4+B5 存储层 | domain/workspace/mod.rs:`WorkspaceSession.ai_mode`(默认 chat)、`AiConversationMessage.payload_json`、`AgentCommandAllowlistEntry`(:79);storage/schema.sql + sqlite.rs:迁移与允许列表 CRUD(list:794 / save:824 INSERT OR IGNORE / delete:841 / touch:851);tests/agent_storage.rs 5 用例 | cargo test 全绿(含旧库迁移) |
| F1 输出捕获 | lib/shellIntegration.ts:`armCommandCapture`(133;C 布防 marker、133;D 收集 [C,D) 区间、折行拼接、头 500+尾截断、marker 失效尾部兜底、`peekOutput`、裸回车不消费、重复布防替换) | scripts/shell-integration.test.mjs 19/19 |
| F2 执行原语 | TerminalPane.vue:`runCommandAndCapture`(sawMarkers/readiness 前置检查、dispatch 失败原因、命令不匹配检测=空文本不判、cancel 只弃等待)+ `agentCaptureSupported`,均已 defineExpose | vue-tsc;逻辑随 F1 测试覆盖 |
| F3 循环状态机 | lib/agentLoop.ts:`runAgentTask`(全依赖注入)+ `compressAgentTurns`;停止三方竞速、超时 wait/stop、连续 2 次 invalid_arguments 出错、敏感/风险强制人工且 suggestedPattern 置空、自动执行跳过审批 | scripts/agent-loop.test.mjs 16/16 |
| F7 判定器 | lib/agentAutoApprove.ts:`classifyForAutoExec` / `suggestPatternForCommand` / `validateAllowlistPattern` / `BUILTIN_READONLY_COMMANDS`(43 条);自包含引号感知分段器(未动 scriptExecution.ts) | scripts/agent-auto-approve.test.mjs 18 测试 171 断言 |
| IPC 包装 | lib/tauri.ts:`aiAgentTurnStream` + 允许列表 4 个包装(**后端命令未注册,B3 前运行时不可用,编译无碍**) | vue-tsc |
| F6 部分(外层接线) | AppShell.vue:`AppUserSettings.agentAutoExecReadonly`(默认 false)、TerminalPaneInstance 类型扩展、`setWorkspaceSessionMode`、`agentAllowlist` 状态 + `loadAgentAllowlist`(onMounted)+ `allowAgentPattern` + `removeAgentAllowlistPattern`(暂未使用,留给 F8)、`agentCommandRunner`(按任务锁定的 terminalId 取 pane)、`agentAvailabilityCheck`;WorkspacePanel.vue:agent 相关 props/emits 全量穿透(AiPanel 侧尚未声明,Vue 视为透传 attrs,无害);SettingsSidebar 的 AppUserSettings 副本已同步补字段 | vue-tsc 零错误 |
| 测试挂载 | package.json test:scripts 已包含 5 个套件 | 61/61 |

## 3. 未完成(按开工顺序)

### 3.1 B3+B5 命令层(下一步,先做这个)

材料已备齐,照抄即可:

1. **state.rs**:在 `list_ai_conversation_messages`(:217)后加 4 个包装,模式照 `save_ai_conversation_message`(:209):`let store = self.store("agent allowlist")?; run_store_task(store, move |store| store.list_agent_command_allowlist()).await` 等;`use crate::domain::workspace::{...}`(:12)加 `AgentCommandAllowlistEntry`。
2. **commands.rs**:imports 加 `crate::domain::ai::agent::{agent_turn_with_provider_stream, AiAgentTurnRequest, AiAgentTurnResponse}` 与 workspace 的 `AgentCommandAllowlistEntry`;新命令 `ai_agent_turn_stream(request_id, request, app, state)` **完全照抄** `chat_with_ai_provider_stream`(:481–547)模板:`state.register_task` → 文本 delta 经 `ai_chat_stream_event_name` 发 Chunk → 成功发 Done(`context_compressed`/`context_chars` 取自响应,`history_count: None`)→ 失败发 Error → `finish_task`;4 个允许列表命令照 `save_ai_conversation_message`(:621)模板。
3. **lib.rs**:invoke_handler(:48,按字母序)加 `ai_agent_turn_stream`、`delete_agent_command_allowlist_entry`、`list_agent_command_allowlist`、`save_agent_command_allowlist_entry`、`touch_agent_command_allowlist_entry`。
4. `cd src-tauri && cargo test` 验证。

### 3.2 F4+F5:AiPanel(最大剩余块,设计决策已全部定死)

- **模式选择器**:`.assistant-compose` 内 textarea **左下角绝对定位**分段控件「对话 | Agent」(与右下发送按钮对称,textarea 已有 padding-bottom 预留空间);`panelMode` 从 `activeSession.value?.aiMode` 计算;切换 `emit('setSessionMode', props.workspaceSessionId, mode)`(WorkspacePanel→AppShell 链路**已通**);运行中禁切;placeholder 按模式变化;agent 不可用提示用 `props.agentAvailabilityCheck?.()`(切换与发送前调用)。
- **AiPanel 需声明**(WorkspacePanel 已在传/已在听):props `agentAvailabilityCheck?: () => string`、`agentCommandRunner?: (terminalId, command, options?) => AgentCommandHandle`、`agentAllowlistPatterns?: string[]`、`agentBuiltinReadonlyEnabled?: boolean`;emits `setSessionMode: [sessionId: string, mode: AiPanelMode]`、`allowAgentPattern: [pattern: string, sourceCommand: string]`。
- **startAgentTask**(发送按钮按 `panelMode` 路由;停止按钮运行中调 loop 的 `stop()`):
  1. append user 消息 + assistant 消息(`mode:'agent'`, `agentStatus:'running'`, `streaming:true`);任务开始时把 `props.terminalId` 存局部变量(任务-终端绑定)。
  2. 组装 deps 调 `runAgentTask`(agentLoop.ts):
     - `callModel`:组 `AiAgentTurnRequest`(goal=用户输入、turns、config/apiKey、terminalSnapshot、`aiCommandHistory()`、`conversationContextParts()` 的 summary/unsummarized);每轮新 requestId;文本 delta 用现有 `onAiChatStream` 监听(同一事件通道);`signal.cancelled` 置位时调 `cancelTask(requestId)`。
     - `startCommand`:`props.agentCommandRunner!(锁定的 terminalId, command, { maxOutputChars: 4000 })`。
     - `classifyStep`:`{ risks: analyzeScriptRisks(cmd), sensitive: isSensitiveCommand(cmd), autoExec: classifyForAutoExec(cmd, { userPatterns: props.agentAllowlistPatterns ?? [], includeBuiltin: props.agentBuiltinReadonlyEnabled ?? false }) }`;自动命中后 fire-and-forget 调 `touchAgentCommandAllowlistEntry(matched)`。
     - `requestApproval` / `requestTimeoutDecision`:存 `pendingApproval` ref `{ proposal, resolve }`,步骤卡片按钮调 resolve。
     - `onAllowPattern`:`emit('allowAgentPattern', pattern, sourceCommand)`。
     - `onStateChange`:映射进 assistant 消息并 `emit('updateMessage', {...})`:`agentSteps: run.steps`、`agentStatus`、`text: run.finalText`、`streaming: 非终态`、终态时 `payloadJson: JSON.stringify({ mode:'agent', agentSteps, agentStatus })`(streaming:false 会触发 AppShell 现有持久化)。
- **步骤卡片**:`message.agentSteps` 存在即渲染(状态图标、命令等宽、风险 chips、可折叠输出尾部、退出码/耗时、自动执行标注);仅当前运行消息显示审批按钮 [执行] [总是允许 `<pattern>`(仅 suggestedPattern 存在)] [跳过] [停止任务];高风险执行按钮二次确认态;超时时 [继续等待|停止任务]。
- 可选增强:`AgentStep.precedingText`(每轮首 step 附 response.text,需同步改 agentLoop.ts 与 types/agent.ts),让文本与卡片交错呈现。

### 3.3 F6 收尾:消息 hydrate

AppShell 的 `listAiConversationMessages` 加载处:`payloadJson` 非空时 try/catch 解析回 `mode/agentSteps/agentStatus`(失败按纯文本消息)。

### 3.4 F8:设置中心 Agent 区块

SettingsSidebar:`settingsGroups` 加 `agent` 区块;内容三部分——「自动执行只读命令」开关(`agentAutoExecReadonly`)、内置集完整枚举(import `BUILTIN_READONLY_COMMANDS` 展示,只读)、允许列表表格(pattern/来源命令/时间/命中统计 + 删除/清空 + 手动添加经 `validateAllowlistPattern` 校验)。AppShell 需把 `agentAllowlist` 完整条目传给 SettingsSidebar 并接删除 emit(`removeAgentAllowlistPattern` 处理器已就绪);手动添加复用 `allowAgentPattern`(sourceCommand 传"手动添加")。

### 3.5 样式(styles.css)

`.assistant-compose` 在 :2715 附近;新增 `.ai-mode-switch`(左下绝对定位,参照 :2772 `.icon-button` 的右下定位写法)与 `.agent-step-card` 系列;亮色主题覆盖照文件内既有主题覆盖模式。

### 3.6 文档同步 + 全量验证

- 设计文档 6.4 的内置集清单需按 F7 实际实现更新(实现更严):`env`/`hostname` 限纯选项、`date` 禁 `-s/--set`、`ss` 禁 `-K`、`rg` 禁 `--pre`、`git branch` 拒绝裸参数并补 `--set-upstream-to`、`git log/diff/show` 禁 `--output`、危险环境变量前缀否决(`PATH=`/`LD_PRELOAD=`/`DYLD_*`)、进程替换 `<( )` 否决、`tail -F`、`find -fprint0`、`journalctl --rotate/--flush`。
- 验证:`cd src-tauri && cargo test`;`cd frontend && npm run test:scripts && npx vue-tsc --noEmit`;手动验收对照设计文档 10.1 的 8 条。

## 4. 注意事项(下次开工先读)

1. **tauri.ts 的 5 个新包装指向未注册命令**——B3 完成前不要在 UI 上接通调用路径(编译不受影响)。
2. AiPanel 的 `sendMessage` 尚未按模式路由,agent 模式当前无入口——不影响既有 chat。
3. Rust 侧用了 serde 的 `rename_all_fields`(serde ≥1.0.186,当前 lockfile 1.0.228)——勿降级 serde。
4. `AgentCommandHandle.cancel` 语义:**只放弃等待,不 kill 命令**;超时逻辑在 agentLoop 循环侧(Promise.race),TerminalPane 不做超时。
5. 命令不匹配检测中,捕获命令为空串视为"未知",**不判**串扰(无 633;E 的远端 shell 兜底)。
6. WorkspacePanel 已在向 AiPanel 传 agent props/事件,AiPanel 声明前它们是无害透传——F4 声明时**名字必须与 WorkspacePanel 模板一致**(`agent-availability-check` 等,事件 `set-session-mode`/`allow-agent-pattern`)。
7. `AiMessage` 的 `mode/agentSteps/agentStatus` 是运行时字段,后端 serde 反序列化会忽略未知字段,只有 `payloadJson` 落库——hydrate 靠 3.3。

## 5. 测试基线(本次结束时)

- `cargo test`:162 passed / 0 failed(含 agent.rs 18 个、agent_storage.rs 5 个)
- `npm run test:scripts`:61/61(script-execution、command-privacy、shell-integration 19、agent-loop 16、agent-auto-approve 18)
- `npx vue-tsc --noEmit`:零错误
- 工作区未提交;分支 main;无 git 提交(按用户指示待命)
