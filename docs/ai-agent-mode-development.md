# AI Agent 模式开发文档

## 1. 背景

AI Term 当前的 AI 助手是单轮问答式的:模型基于终端快照、命令历史和会话上下文生成回答,可执行命令以代码块形式呈现,由用户逐条点击执行(`extractPrimaryShellCommand` / `executeGeneratedCommand`,`frontend/src/components/AiPanel.vue`)。模型无法感知命令的执行结果,多步排障任务需要用户在"执行 → 复制输出 → 追问"之间手工搬运。

Agent 模式的目标是打通这个闭环:模型通过 tool call 提出命令,应用在用户审批后于当前终端执行,把输出与退出码自动喂回模型,模型据此决定下一步,循环直到任务完成。用户在普通对话与 Agent 之间显式选择模式。

已具备的基础(本设计直接复用,不重复建设):

- **命令边界与退出码**:shell integration 语义标记状态机(`ShellIntegrationTracker`,`frontend/src/lib/shellIntegration.ts`)提供 `onCommandStart` / `onCommandFinished`(含退出码)、cwd 与输入锚点 marker。见 `docs/shell-integration-development.md`。
- **程序化执行入口**:`TerminalPane.executeCommand` 带就绪检查(`commandExecutionReadiness`),AppShell 已有多目标重试分发(`executeCommandOnTerminalIds`)。
- **风险引擎**:`analyzeScriptRisks`(`frontend/src/lib/scriptRisk.ts`)与 AI 风险解释流程;敏感命令检测 `isSensitiveCommand`(`frontend/src/lib/commandPrivacy.ts`)。
- **模型调用基础设施**:OpenAI 兼容流式请求、SSE 解析、取消令牌(`AiCancelToken`)、错误归一化、HTML 响应拒绝(`src-tauri/src/domain/ai/chat.rs`);Tauri 事件通道与任务注册(`chat_with_ai_provider_stream`,`src-tauri/src/app/commands.rs`)。
- **会话持久化与压缩**:`ai_conversation_messages` 存储、`compress_conversation_context` 压缩、`ensure_column` 迁移套路(`src-tauri/src/domain/storage/sqlite.rs`)。

## 2. 目标

### 2.1 行为目标

- AI 面板 composer 提供模式选择(普通对话 / Agent),模式为会话级属性并持久化;同一会话内两种模式的消息共享历史。
- Agent 模式下,一次用户输入即一个任务:模型循环提出 `run_command`,每步以步骤卡片呈现命令、理由、风险标记,经用户执行/跳过后把输出与退出码回传模型,直到模型不再请求工具(任务完成)、达到步数上限或被用户停止。
- 通过只读判定的命令可自动执行(见 6.4):来源为内置只读命令集(设置开关,默认关)与用户在审批卡片上逐条「总是允许」累积的允许列表;风险与敏感命令始终人工审批。
- 命令始终在用户当前终端可见地执行(不开隐藏 shell),与产品"执行可审查、用户可控"原则一致。
- 停止按钮随时可中断:中断模型请求(复用取消令牌)且不再派发后续命令;已发出的命令不强行终止,由用户接管。
- 普通对话模式行为与现状完全一致。

### 2.2 兼容目标

- 现有 `chat_with_ai_provider_stream` 请求路径、消息渲染、命令点击执行零改动;Agent 为并行新增路径。
- 旧版本数据可打开:agent 消息的最终总结写入现有 `text` 字段,结构化步骤放新增列,旧版本降级为纯文本显示。
- 不支持 function calling 的网关:报错信息明确指向"该模型/网关不支持工具调用",指引切回普通对话;不做静默降级。
- 未收到 shell integration 标记的终端(阶段 1):Agent 模式不可用并说明原因;阶段 2 提供哨兵兜底。

## 3. 非目标(本期)

- 多终端并行执行的 agent 任务(仅作用于当前活动终端)。
- 后台/隐藏 shell 执行(违背产品透明原则)。
- 除 `run_command` 之外的工具(SFTP 读写、脚本生成联动等,阶段 3)。
- SSH 远端 shell integration 自动注入(沿用 shell integration 文档的阶段 3 策略)。
- 交互式全屏程序(vim / top)的自动驾驶:检测到疑似交互等待即交还用户。
- 文本协议降级(让模型输出约定 JSON 代替原生 tool call)。

## 4. 总体架构

### 4.1 双模式划分原则

普通对话与 Agent 在**请求构造、循环控制、消息渲染**三层分叉,在 **HTTP/SSE 基础设施、上下文构建、风险引擎、持久化**四层共享:

```
                    ┌─ 普通对话:sendMessage → chat_with_ai_provider_stream(不动)
composer(模式选择)─┤
                    └─ Agent:runAgentTask(agentLoop.ts)
                          │ 每轮
                          ▼
                      ai_agent_turn_stream(新 Tauri 命令)
                          │ 复用 send_openai_compatible_stream_request / 取消令牌 / 错误解析
                          ▼
                      文本 delta 走现有事件通道;tool_calls 随命令返回值带回
```

### 4.2 Agent 任务数据流

```
用户输入任务(agent 模式)
  → agentLoop:调 ai_agent_turn_stream(goal + 已有轮次 + 终端上下文)
  → 模型返回 text(流式)+ tool_calls
      ├─ tool_calls 为空 → 任务完成,text 即总结
      └─ 含 run_command
           → 风险/敏感检查 + 自动执行判定(6.4)
                ├─ 自动放行 → 直接执行(卡片标注「自动执行」)
                └─ 需人工 → 步骤卡片(待审批),用户[执行]
           → TerminalPane.runCommandAndCapture
                 → executeCommand 写入 PTY(终端可见)
                 → OSC 133;C 处布防捕获,133;D 收 → {output, exitCode}
           → 用户[跳过] → 构造 skipped 工具结果
           → 工具结果追加进轮次,回到循环顶部
  终止条件:tool_calls 为空 | 步数达上限 | 用户停止 | 模型请求失败
```

### 4.3 Agent 循环状态机(前端)

```
idle ──提交任务──▶ calling-model ──text only──▶ done
                      │  ▲
              tool_call│  │工具结果回传
                      ▼  │
              awaiting-approval ──执行──▶ executing ──D/超时──▶ (回 calling-model)
                      │
                      └──跳过──▶ (回 calling-model)

任意状态 ──用户停止/错误/步数上限──▶ stopped
executing ──超时──▶ awaiting-user(继续等待 | 停止任务)
```

自动执行判定通过的步骤跳过 `awaiting-approval`,直接进入 `executing`(判定规则见 6.4)。

## 5. 后端设计

新增 `src-tauri/src/domain/ai/agent.rs`,在 `domain/ai/mod.rs` 注册。`chat.rs` 仅做两处非破坏调整:把 `send_openai_compatible_stream_request`、`ai_http_client`、`parse_model_error`、`reject_html_response`、`build_context_bundle`、`truncate_for_prompt` 等改为 `pub(crate)` 供 agent 模块复用;其余不动。

### 5.1 工具定义

阶段 1 只有一个工具,随 payload 发送:

```json
{
  "type": "function",
  "function": {
    "name": "run_command",
    "description": "在用户当前终端执行一条 shell 命令并返回输出与退出码。命令会展示给用户审批后才执行。一次只提出一条命令;优先只读检查;危险操作必须先用只读命令确认目标。",
    "parameters": {
      "type": "object",
      "properties": {
        "command": { "type": "string", "description": "完整的单条 shell 命令" },
        "reason":  { "type": "string", "description": "为什么执行这条命令(一句话,展示给用户)" }
      },
      "required": ["command"]
    }
  }
}
```

`tool_choice` 用 `"auto"`。不使用 parallel tool calls:payload 带 `"parallel_tool_calls": false`(不支持该参数的网关会忽略;若模型仍一次返回多个 tool call,循环按顺序逐个审批执行)。

### 5.2 请求与轮次类型

```rust
#[serde(rename_all = "camelCase")]
pub struct AiAgentTurnRequest {
    pub config: AiProviderConfig,
    pub api_key: String,
    /// 用户任务描述(整个任务期间不变)
    pub goal: String,
    /// 本任务内已发生的轮次,按序
    pub turns: Vec<AiAgentTurn>,
    pub terminal_snapshot: String,
    pub command_history: Vec<String>,
    /// 会话内普通对话历史与压缩摘要,作为背景(复用 chat 的结构)
    pub conversation_messages: Vec<AiConversationTurn>,
    pub conversation_summary: Option<String>,
}

#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiAgentTurn {
    /// 模型上一轮输出:文本 + 工具调用
    Assistant { text: String, tool_calls: Vec<AiToolCall> },
    /// 某个工具调用的结果(执行输出 / 跳过 / 超时说明)
    ToolResult { tool_call_id: String, content: String },
}

#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    /// 原样透传的 JSON 字符串,前端负责解析 command/reason
    pub arguments: String,
}

#[serde(rename_all = "camelCase")]
pub struct AiAgentTurnResponse {
    pub text: String,
    /// 空数组 = 模型认为任务完成
    pub tool_calls: Vec<AiToolCall>,
    pub context_compressed: bool,
    pub context_chars: usize,
}
```

轮次由前端维护并整体随每轮请求上传(与现有 chat 的无状态设计一致,后端不保存任务状态)。

### 5.3 payload 构造

messages 组装顺序:

1. `system`:agent 系统提示词(见 5.4)+ 会话摘要注入(复用 chat 的做法)。
2. 会话背景:`conversation_messages`(经现有 `conversation_messages_for_payload` 同等裁剪)。
3. `user`:任务描述 + 终端上下文(复用 `build_context_bundle` 产出的当前终端内容 / 关键摘要 / 历史命令,格式同 `build_user_context_prompt`)。
4. 任务轮次展开:
   - `Assistant` → `{"role":"assistant","content":text,"tool_calls":[{"id","type":"function","function":{"name","arguments"}}]}`(text 为空时 content 置 `null`)。
   - `ToolResult` → `{"role":"tool","tool_call_id":id,"content":content}`。

约束:OpenAI 协议要求每个 `tool` 消息紧跟在包含对应 `tool_call_id` 的 assistant 消息之后,前端保证轮次顺序,后端构造时校验(缺失结果的 tool call 补一条 `{"status":"skipped"}`,防止个别网关 400)。

### 5.4 agent 系统提示词(草案)

```
你是 AI Term 的终端操作 Agent,通过 run_command 工具在用户当前终端执行命令来完成用户任务。
规则:
1. 一次只调用一次 run_command,提出一条命令;根据返回的输出和退出码决定下一步。
2. 优先只读检查命令;任何有破坏性的操作(删除、覆盖、重启、服务变更)之前,必须先用只读命令确认目标存在且正确,并在 reason 里说明依据。
3. 命令必须完整可直接执行,不使用交互式编辑器(vim/nano)和分页器(如 less;用 cat/head/tail 替代),长输出主动加过滤或行数限制。
4. 用户可能跳过你的命令,工具结果会标注 skipped;此时换一种方式或询问用户,不要原样重发。
5. 任务完成或无法继续时,不再调用工具,直接输出结论:做了什么、结果如何、遗留什么。
6. 始终以最新工具结果和终端内容为准,不要臆造未验证的状态。
```

自定义 `system_prompt`(`AiProviderConfig`)拼接在前,与 chat 的 `build_system_prompt` 行为一致。

### 5.5 流式 tool_calls 解析

扩展点在 agent 模块内,不修改 chat 的 `parse_sse_event_deltas`:

- 文本增量:沿用 `choices/0/delta/content` 等指针,通过 `on_delta` 回调外发(前端体验与 chat 一致)。
- 工具调用增量:`choices/0/delta/tool_calls` 是数组,元素形如 `{index, id?, type?, function:{name?, arguments?}}`。按 `index` 维护累积表:`id`/`name` 取首个非空值,`arguments` 字符串逐片拼接。兼容两类网关行为:分片下发(标准)与单个 delta 携带完整调用。
- 结束判定:流结束后累积表非空即视为有 tool call(不依赖 `finish_reason`,部分网关不回传);`arguments` 在后端仅做非空校验,JSON 解析留给前端以便把格式错误呈现在步骤卡片上重试。
- 非流式兜底:与 chat 相同,SSE 无增量时把完整响应按 `choices/0/message/tool_calls` 提取。
- 取消:沿用 `AiCancelToken` 检查点。

单元测试覆盖:分片拼接、乱序 index、单 delta 完整调用、text 与 tool_calls 混合、`[DONE]` 前无 finish_reason。

### 5.6 Tauri 命令与事件

新增 `#[tauri::command] ai_agent_turn_stream(request_id, request, app, state) -> Result<AiAgentTurnResponse, String>`,实现完全套用 `chat_with_ai_provider_stream` 的模板(`src-tauri/src/app/commands.rs:481`):`state.register_task` 注册取消令牌、文本 delta 经 `ai_chat_stream_event_name(request_id)` 通道 `emit_all`、结束发 `Done`/`Error`。

事件类型不扩展:`AiChatStreamEventKind` 保持 `Chunk | Done | Error`,tool_calls 通过命令返回值 `AiAgentTurnResponse` 带回(每轮请求天然有一次 await,无需增量推送工具调用)。

`lib.rs` 的 `invoke_handler` 注册新命令;`frontend/src/lib/tauri.ts` 增加 `aiAgentTurnStream(requestId, request)` 包装,事件监听复用现有 `onAiChatStream`。

### 5.7 网关兼容

- 请求带 `tools` 后返回 4xx 且错误文案含 tools/function 关键字时,`parse_model_error` 结果前置一句提示:"当前模型或网关可能不支持工具调用(Agent 模式),请更换模型或切回普通对话。"
- 模型不调用工具而在正文里输出命令:视为任务完成,正文原样显示(其中代码块仍可点击执行,与 chat 一致),不做二次解析。

## 6. 前端设计

### 6.1 模式选择器

- 位置:`AiPanel.vue` 的 `.assistant-compose` 内,textarea 下方新增一行紧凑工具条:左侧分段控件「对话 | Agent」,右侧沿用现有发送/停止按钮(从 textarea 右侧移入该行)。
- 状态:`WorkspaceSession` 新增 `aiMode?: 'chat' | 'agent'`(默认 `'chat'`),随 `save_workspace_session` 持久化;切换即保存。AiPanel 通过现有 session props/emits 读写。
- 规则:任务运行期间(`agentRun.status` 非终态)分段控件与 composer 禁用;composer placeholder 随模式变化(对话:现状文案;Agent:「描述要完成的任务,AI 将提出命令并在你确认后执行」)。
- 无可用标记的终端(见 6.2 前置条件)切到 Agent 时,composer 上方显示不可用说明,发送禁用。

### 6.2 执行与捕获原语 `runCommandAndCapture`

TerminalPane 新增并 `defineExpose`:

```ts
interface AgentCommandResult {
  status: 'completed' | 'timeout' | 'dispatch-failed'
  output: string        // 截断后的命令输出(不含命令回显行与下一个提示符)
  exitCode?: number
  durationMs: number
  truncated: boolean
}

runCommandAndCapture(command: string, options: { timeoutMs: number; maxOutputChars: number }): Promise<AgentCommandResult>
```

实现要点:

- **前置条件**:`shellIntegrationAttachment?.tracker.sawMarkers === true` 且 `commandExecutionReadiness() === 'ready'`,否则返回 `dispatch-failed` 并附原因(AppShell 层面在任务开始前也做一次整体检查)。
- **派发**:走现有 `executeCommand(command)`(保持就绪检查、命令历史记录、`source: 'command'` 语义)。
- **输出捕获**:为 tracker 增加一次性布防 API `armCommandCapture()`:在下一个 `OSC 133;C` 处 `registerMarker()` 记录输出起始行,`OSC 133;D` 时读取 `[C 行, 当前光标行)` 区间的缓冲文本(复用 `ShellIntegrationHost.rowText`,含折行拼接),连同退出码经扩展后的 `onCommandFinished` 结果返回。仅 agent 派发的命令布防,零成本于日常使用。
- **截断**:超过 `maxOutputChars`(默认 4000 字符)保留头 500 + 尾 3500,中间插入省略说明(与 `compress_terminal_snapshot` 同思路,保住报错通常在尾部的特性)。
- **marker 失效兜底**:输出超过 scrollback 导致起始 marker 被回收时,退化为取当前缓冲尾部 `maxOutputChars` 并标注"输出过长,仅保留末尾"。
- **超时**:默认 120s。超时不杀命令(这是用户的活动终端),Promise 以 `timeout` 结果返回,输出为已捕获的尾部内容;循环层转入 `awaiting-user`。
- **串扰防护**:布防到 D 期间用户手动输入回车会让捕获对应到错误的命令。布防时记录派发的命令文本,`onCommandFinished.command` 不匹配时结果标注 `commandMismatch`,循环层按执行失败处理并提示用户接管。

### 6.3 Agent 循环编排器 `lib/agentLoop.ts`

纯逻辑模块,依赖全部注入,便于单测:

```ts
interface AgentLoopDeps {
  callModel(turns: AiAgentTurn[], signal: { cancelled: boolean }): Promise<AiAgentTurnResponse>
  runCommand(command: string, opts: RunOptions): Promise<AgentCommandResult>
  classifyForAutoExec(command: string): { eligible: boolean; matched?: string; suggestedPattern: string }
  requestApproval(step: AgentStepProposal): Promise<'execute' | 'execute-and-allow' | 'skip' | 'stop'>
  onStateChange(run: AgentRunState): void
}

interface AgentStep {
  id: string                     // tool_call_id
  command: string
  reason: string
  risks: ScriptRiskMatch[]
  sensitive: boolean
  autoApproved?: boolean         // 自动执行标注
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'timeout' | 'failed'
  output?: string
  exitCode?: number
  durationMs?: number
}

interface AgentRunState {
  status: 'calling-model' | 'awaiting-approval' | 'executing' | 'awaiting-user' | 'done' | 'stopped' | 'error'
  steps: AgentStep[]
  finalText: string
  stepLimit: number              // 默认 10
}
```

工具结果回传给模型的 content 统一为 JSON 文本:

- 执行完成:`{"exitCode":0,"durationMs":1240,"truncated":false,"output":"..."}`
- 跳过:`{"status":"skipped_by_user"}`
- 超时:`{"status":"timeout","waitedMs":120000,"partialOutput":"..."}`(仅当用户选择"停止任务"后不再回传;选择"继续等待"则重新计时)

arguments JSON 解析失败:该 tool call 以 `{"status":"invalid_arguments","error":"..."}` 回传,模型自行修正;连续 2 次解析失败则终止任务并报错。

步数上限:达到后终止,末条系统性说明写入 finalText("已达到 N 步上限,任务未确认完成"),用户可发新消息续做(新任务携带同会话背景)。

### 6.4 审批策略与自动执行

每个 `run_command` 依次过四道判定,顺序固定——硬门槛在前,允许列表永远越不过风险门:

```
1. isSensitiveCommand 命中 ────▶ 人工审批(不提供「总是允许」按钮)
2. analyzeScriptRisks 高风险 ──▶ 人工审批 + 二次确认
3. analyzeScriptRisks 中风险 ──▶ 人工审批
4. 自动执行判定通过 ───────────▶ 自动执行,卡片标注「自动执行 · 只读/已允许」
5. 其余 ───────────────────────▶ 人工审批
```

**自动执行判定**由新模块 `lib/agentAutoApprove.ts` 实现(纯函数,可单测):

```ts
classifyForAutoExec(
  command: string,
  sources: { userPatterns: string[]; includeBuiltin: boolean }
): AgentAutoExecClassification
```

命令按引号感知的词法规则拆分为管道段与 `;` / `&&` / `||` / 后台 `&` 链式段(`agentAutoApprove.ts` 内自包含实现——`scriptExecution.ts` 的扫描面向注释剥离,不产出 token 边界与重定向信息,复用反而耦合),**每一段独立通过**才可自动执行。单段判定:

- **匹配来源**:内置只读命令集(`includeBuiltin` 为真时)∪ 用户允许列表。
- **匹配粒度**:默认首 token;子命令型工具(`git`、`docker`、`kubectl`、`systemctl`、`ip`、`journalctl` 等)取两 token——「总是允许」允许的是 `git status`,而不是整个 `git`。条目按 token 前缀匹配:条目全部 token 与命令段前缀一致即命中。
- **包装剥离**:前缀环境变量赋值(`FOO=bar cmd`)剥离后取 token;`timeout <n> cmd` 与 `command cmd` 视为透明包装,判定内层命令。
- **一票否决**(任一命中即需人工,允许列表无效):
  - `sudo` 前缀;
  - 输出重定向 `>` / `>>`(`>/dev/null`、`2>&1`、`2>/dev/null` 除外);
  - 命令替换 `$(...)` / 反引号,及进程替换 `<(...)` / `>(...)`;
  - 可改变实际执行代码的环境变量前缀(`PATH=`、`LD_PRELOAD=`、`DYLD_*` 等);
  - 交互式历史展开(`ls !!`);
  - 条目声明的禁用参数与后继 token 白名单(见下);
  - 无法可靠解析的结构(未闭合引号、heredoc)。

**内置只读命令集**(设置开关「自动执行只读检查命令」,默认关):以 `lib/agentAutoApprove.ts` 的 `BUILTIN_READONLY_COMMANDS` 为准(43 条,设置中心完整枚举展示)。单 token:`ls cat head stat file wc du df free uptime w who whoami id uname hostname date printenv env which type ps pgrep ss lsof grep rg`;两 token:`systemctl status|is-active|list-units|list-timers`、`docker ps|images|inspect|logs`、`kubectl get|describe|top|logs`、`git status|log|diff|show|branch`、`ip addr|route|link`;及带禁用参数的 `tail`、`find`、`journalctl`。

每个条目可声明禁用参数与后继 token 白名单,实现比早期草案更严:

- 常驻/跟随:`tail -f/-F`、`docker logs -f`、`kubectl logs -f`、`journalctl -f/--follow`
- 破坏性子命令:`find -delete/-exec/-execdir/-ok/-okdir/-fls/-fprint/-fprint0/-fprintf`、`git branch -d/-D/-m/-M/-c/-C/--delete/--move/--copy/--set-upstream-to`(并拒绝裸参数,`git branch <名>` 是建分支)、`journalctl --vacuum*/--rotate/--flush`、`ss -K/--kill`、`date -s/--set`
- 可执行任意命令的入口:`env` 与 `hostname` 限纯选项(`env rm -rf /` 会执行 rm;裸参数的 hostname 是设主机名)、`rg --pre`(逐文件执行外部命令)
- 写文件:`git log/diff/show --output`
- `ip addr|route|link` 用后继 token 白名单限 `show|list|ls|get`,挡住 `ip addr add`

分页/常驻类命令(`less`、`more`、`top`、`watch`)与有网络副作用的 `curl`/`wget` 即使只读也不进内置集(会挂住循环,交给超时兜底不如直接不放行)。

**用户允许列表(「总是允许」,Claude Code 式权限记录)**:待审批卡片在命令**无风险命中且非敏感**时,额外提供「总是允许 `<suggestedPattern>`」按钮;点击即把该 pattern 写入允许列表并执行当前步骤。点击本身就是显式授权,不设额外开关;每次执行仍重新走完整判定顺序,因此列表条目不可能放行日后新增风险规则命中的命令。

- **条目语义**:token 前缀模式——条目的全部 token 与命令的前缀 token 完全一致即命中(`git status` 命中 `git status --porcelain`,不命中 `git stash`),等价于 Claude Code 的 `Bash(git status:*)`。按钮建议值取首 token 或子命令工具的两 token;手动添加时允许更长前缀(如 `systemctl status nginx`)。
- **记录**:每条记录来源命令(点击「总是允许」时的完整命令)、添加时间、命中次数与最近命中时间,持久化到 SQLite(见 7)。
- **查看与管理**(设置中心 Agent 区块,对标 Claude Code 的 `/permissions`):
  - 允许列表:逐条展示 pattern、来源、统计;可删除单条、清空全部;
  - 手动添加:输入框 + 同源校验(拒绝 `sudo` 前缀、含重定向/命令替换等一票否决结构的 pattern);
  - 内置只读集:完整枚举展示(只读,不可编辑),随开关整体启停——用户能确切看到"开了这个开关到底会自动执行什么"。
- **执行留痕**:自动执行的步骤本身已有两处记录——会话里的步骤卡片(含 payload 持久化)与命令历史(含退出码),无需额外审计通道。

**可见性与刹车**:自动执行的步骤卡片完整保留(命令/输出/退出码)并带标注;composer 区域显示自动执行状态 chip;停止按钮语义不变;步数上限继续兜底连锁自动执行。

**人工审批细节**:卡片按钮为 [执行] [总是允许 `<pattern>`](符合条件时)[跳过] [停止任务];高风险(`severity === 'high'` 命中)时执行按钮带二次确认态,复用现有 AI 风险解释入口。命令不可编辑(保持模型请求与执行一致;用户想改就跳过并在下一条消息里说明)。停止:置取消令牌(复用 `cancelTask`)、拒绝待审批步骤、循环收尾为 `stopped`。

### 6.5 消息模型与渲染

一次 agent 任务 = 一条 assistant 消息,步骤内嵌:

```ts
interface AiMessage {
  // …现有字段不变
  mode?: 'chat' | 'agent'
  agentSteps?: AgentStep[]
  agentStatus?: 'running' | 'done' | 'stopped' | 'error'
}
```

- 渲染:assistant 消息体内按序渲染步骤卡片(状态图标、命令、风险 chips、可折叠输出尾部、退出码与耗时),最后是 finalText 的 Markdown(复用 `AiMarkdownMessage`)。
- 运行中的实时更新沿用现有 `updateMessage` 事件流(节流策略参考 chat 的 80ms 合并)。
- `text` 字段始终写入最终总结(运行中为空),保证旧版本与压缩逻辑可用。
- 会话压缩:`compress_conversation_context` 的输入把 agent 消息展开为"文本 + 每步一行(命令/退出码/一句话结果)"的纯文本,不需要后端感知步骤结构。

### 6.6 AppShell 接线

- AppShell 向 AiPanel 传入 `agentCommandRunner: (command, opts) => Promise<AgentCommandResult>` prop,内部定位活动终端 `terminalRefs.value[activeTerminalId.value]` 并调用其 `runCommandAndCapture`;终端不可用时返回 `dispatch-failed`。
- 任务与终端绑定:任务开始时锁定当时的 `terminalId`,期间用户切换活动终端不改变执行目标;该终端断开则任务以 error 终止。
- 消息持久化沿用 AppShell 现有的 `save_ai_conversation_message` 调用点,增加 payload 字段(见 7)。

## 7. 持久化与迁移

沿用 `ensure_column` 增量迁移(`src-tauri/src/domain/storage/sqlite.rs`):

| 表 | 新列 | 定义 | 用途 |
| --- | --- | --- | --- |
| `workspace_sessions` | `ai_mode` | `TEXT NOT NULL DEFAULT 'chat'` | 会话模式 |
| `ai_conversation_messages` | `payload_json` | `TEXT NOT NULL DEFAULT ''` | agent 消息的 `{mode, agentSteps, agentStatus}` 序列化 |

新增表 `agent_command_allowlist(pattern TEXT PRIMARY KEY NOT NULL, source_command TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0)` 及配套 `list / save / delete / touch(命中计数)` Tauri 命令,建表风格参照 `update_scripts` 的 `CREATE TABLE IF NOT EXISTS`;「内置只读集」开关等轻量偏好沿用现有前端设置持久化方式(与主题偏好一致)。

- `AiConversationMessage` 模型、`save/list` 映射、`tauri.ts` 类型同步增改;`payload_json` 为空按纯 chat 消息处理。
- 敏感命令(`isSensitiveCommand` 命中)的步骤在持久化时把 `output` 置为 `“[敏感命令输出未存储]”`,命令文本保留(与命令历史现行为一致);发送给模型的内容不受影响,但在 reason 卡片上提示用户。
- 步骤输出本身已截断(≤4000 字符),单条消息 payload 上限约 10 步 × 4KB,可接受;`prune_ai_conversation_messages` 现有条数上限继续生效。

## 8. 上下文预算

每轮 agent 请求的组成与上限:

| 部分 | 上限 | 机制 |
| --- | --- | --- |
| 终端快照 + 命令历史 | 12k 字符 | 复用 `MAX_CONTEXT_CHARS` / `build_context_bundle` |
| 会话背景消息 + 摘要 | 8k + 2k 字符 | 复用 chat 现有裁剪与压缩 |
| 任务轮次(新增) | 24k 字符 | 新常量 `MAX_AGENT_TURN_CHARS`:超限时从最早轮次开始,把 `ToolResult.content` 压缩为 `{"exitCode":N,"note":"输出已省略"}`,`Assistant.text` 截断;最近 3 轮完整保留 |

轮次压缩在前端 agentLoop 内做(前端拥有轮次全量,后端保持无状态),后端对超限请求兜底 `bail!` 明确报错而非静默截断。

## 9. 安全与可控性

- **默认普通对话**;Agent 需按会话显式切换。
- **分级审批**(6.4):敏感/风险命令始终人工(高风险二次确认);自动执行仅限通过只读判定的命令,来源是默认关闭的内置集与用户逐条显式添加的允许列表;判定顺序保证允许列表永远越不过风险门。`sudo`、写重定向、命令替换、不可解析结构一律人工。
- **步数上限**默认 10(设置项,1–25),防模型死循环。
- **执行透明**:命令写入用户可见终端,输出留在终端里,与手敲无异;AI 面板只是镜像摘要。
- **停止语义**:停止只中断"模型继续决策与派发",不 kill 正在跑的命令——终端是用户的,由用户决定 Ctrl+C。文案明确这一点。
- **禁用面**:交互式命令由系统提示词约束 + 超时兜底;`risk_policy`(`AiProviderConfig`)文本继续拼入系统提示词。

## 10. 分阶段实施计划

### 10.1 阶段 1:MVP(本期)

后端(可与前端并行):

| # | 任务 | 涉及 |
| --- | --- | --- |
| B1 | `agent.rs`:类型、payload 构造、工具定义、系统提示词、轮次校验 | `domain/ai/agent.rs`、`chat.rs` 可见性调整 |
| B2 | SSE tool_calls 累积解析 + 非流式兜底 + 单测(5.5 列举的用例) | `agent.rs` |
| B3 | `ai_agent_turn_stream` 命令 + 注册 + 网关不支持工具的错误提示 | `commands.rs`、`lib.rs` |
| B4 | 迁移:`ai_mode`、`payload_json` 及模型/映射 + 单测 | `sqlite.rs`、`models.rs`、`tests/` |
| B5 | `agent_command_allowlist` 表 + list/save/delete 命令 + 单测 | `sqlite.rs`、`commands.rs` |

前端:

| # | 任务 | 涉及 |
| --- | --- | --- |
| F1 | tracker `armCommandCapture` + 输出区间读取 + 假 host 单测 | `lib/shellIntegration.ts` |
| F2 | `runCommandAndCapture`(超时/截断/marker 失效/命令不匹配)+ expose | `TerminalPane.vue` |
| F3 | `lib/agentLoop.ts` 状态机 + 全依赖注入单测(审批/跳过/停止/超时/步数上限/参数损坏) | 新文件 |
| F4 | 模式选择器 + 会话持久化 + placeholder/禁用规则 | `AiPanel.vue`、`AppShell.vue`、`types/workspace.ts` |
| F5 | 步骤卡片渲染 + 审批按钮 + 高风险二次确认 + 停止 | `AiPanel.vue`(或拆 `AgentStepCard.vue`) |
| F6 | AppShell 接线:`agentCommandRunner`、任务-终端绑定、消息 payload 持久化 | `AppShell.vue`、`lib/tauri.ts` |
| F7 | `agentAutoApprove.ts` 判定器(词法拆分/两 token/一票否决)+ 单测 | 新文件,复用 `scriptExecution.ts` 词法 |
| F8 | 「总是允许」按钮、自动执行路径与标注、设置中心 Agent 区块(内置集开关与内容枚举 + 允许列表查看/删除/清空/手动添加/使用统计) | `AiPanel.vue`、`SettingsSidebar.vue` |

依赖关系:F3 只依赖类型定义,可先行;F5 依赖 F3 的状态结构;F2 依赖 F1;B3 依赖 B1/B2;F7 独立可先行;F8 依赖 F3/F5/F7/B5。

验收标准:

1. 本地 zsh/bash 终端,Agent 模式下发出"看看磁盘哪个目录最占空间"类任务,模型至少完成两步(如 `df -h` → `du -sh`),每步经人工确认,输出与退出码正确回传,最终输出总结。
2. 跳过某步后模型换策略继续;停止后不再派发命令且状态为 stopped。
3. 高风险命令(如 `rm -rf`)卡片出现风险 chips 且需二次确认。
4. 无 shell integration 标记的会话,Agent 选项给出不可用说明。
5. 重启应用后:会话模式保留,agent 消息的步骤时间线完整还原。
6. 普通对话模式回归:与改造前行为一致(现有测试全绿)。
7. 不支持 tools 的网关得到明确报错与切换建议。
8. 自动执行:开启内置只读集后 `df -h` 类命令自动执行且卡片带标注;点击「总是允许 `docker logs`」后,后续 `docker logs` 步骤自动执行且重启应用仍生效;设置中心能看到该条目的来源命令与命中统计,删除后恢复人工审批;`cat a > b`、`sudo cat x`、含 `$( )` 的命令均不自动执行;`rm -rf` 仍需二次确认。

### 10.2 阶段 1.5:自主探索能力(①–④ 已实施,⑤ 待评估)

阶段 1 跑通后的实测结论:Agent 往往只执行一条命令就给结论,不具备 Claude Code 那样的连续自主探索。诊断出五处成因,均非循环机制缺陷,而是提示词与预算参数把它按成了"一问一答"。用户已确认自主档位为 **「只读自动 + 写操作审批」**:只读检查命令连续自动执行,写入/风险/敏感命令仍逐条人工审批——探索顺畅,同时守住产品的"执行可审查"底线。

| # | 成因 | 现状 | 方案 |
| --- | --- | --- | --- |
| 1 | 提示词无"持续推进"指令 | `build_agent_system_prompt` 规则 1「一次只调用一次」+ 规则 5「任务完成…直接输出结论」,全篇无验证/取证要求 | 重写为"工作方式":自主推进、不停在第一个看似合理的结果、能用命令查到的不要问用户��证据不足时继续查;保留全部安全条款,并说明只读命令会自动执行、危险命令会停下等审批 |
| 2 | **上下文预算过小(最硬的伤)** | 轮次预算 24k 字符,单命令输出上限 4k → **6 条命令即撑满**,`compressAgentTurns` 开始把早期 toolResult 整体替换为「输出已省略」,只保护最近 3 轮;后端超限直接 bail | 后端 `MAX_AGENT_TURN_CHARS` 24k → 80k;前端 `DEFAULT_MAX_TURN_CHARS` 24k → 72k(低于后端,保证前端先压缩而非后端报错);`PROTECTED_RECENT_TURNS` 3 → 6;压缩策略改为保留退出码 + 输出尾部片段,而非整体丢弃 |
| 3 | 步数上限过低 | `DEFAULT_STEP_LIMIT = 10`,到顶即 `stopped` 且无续跑入口 | 提升到 25;到达上限的收尾文案明确提示可继续下一轮任务 |
| 4 | 默认每条命令都要人工审批 | `agentAutoExecReadonly` 默认 `false`,连 `ls`/`ps` 都要点一次「执行」——这是"只会执行一个命令"的直接体感来源 | 默认改为 `true`(内置只读集生效)。既有用户的本地设置无该字段,合并时自动取新默认值 |
| 5 | 无计划跟踪 | 单一 `run_command` 工具,长任务容易丢方向 | 新增 `update_plan` 工具(steps + current),运行态存入 `AgentRunState`,在步骤卡片上方渲染紧凑清单。**优先级最低**,1–4 落地并验证后再评估 |

实施顺序:1 → 2 → 3 → 4(行为杠杆由大到小,每步可独立验证),5 视效果决定是否需要。

风险与回归关注点:

- 预算放大后单次请求 token 显著上升,需在实测中确认成本与网关上限(部分网关对单请求有硬上限,超限报错文案已有 5.7 兜底)。
- 自动执行默认开启后,首次使用的用户会看到命令自动跑起来;设置中心 Agent 区块已完整枚举内置只读集,开关可一键关闭。
- 提示词改动需回归:危险命令仍先做只读确认、skipped 后不原样重发。

### 10.3 阶段 2:无标记兜底与体验强化

- 无标记终端哨兵兜底:agent 命令包装为 `<cmd>; printf '\n__AI_TERM_RC_<nonce>__:%d\n' $?`,在输出流中按 nonce 行匹配退出码,输出取派发点到哨兵行之间的累积文本;命令回显行剔除。仅 POSIX shell;PowerShell/cmd 另行设计。**这是 Agent 模式能否用于远端 SSH 的前提**——当前仅本地 zsh/bash 自动注入 OSC 133。
- 超时体验:卡片倒计时、"继续等待"重置、疑似交互等待的启发提示(输出静默且无 D)。
- 每任务步数上限、超时进入设置;允许列表支持按连接维度细分(可选)。

### 10.4 阶段 3:工具扩展

- `read_file` / `list_directory`(走 SFTP 通道,只读,受同一审批策略)。
- `write_file` 带 diff 预览审批。
- 任务完成后一键"沉淀为脚本"(对接现有 update_scripts / 脚本风险检查)。
- SSH 远端 integration 注入(对齐 shell integration 文档阶段 3)。

## 11. 测试策略

- **Rust 单测**(`agent.rs` 内 `#[cfg(test)]`,风格同 `chat.rs`):payload 含 tools 与轮次展开顺序;tool 消息配对校验;SSE 分片累积各用例;非流式提取;错误提示注入;轮次超限 bail。
- **迁移测试**(`tests/`,参考 `sqlite_ai_configs.rs`):新列默认值、旧库升级、payload 往返。
- **前端单测**:agentLoop 全路径(假依赖);tracker 捕获(假 `ShellIntegrationHost`,含折行、marker 失效);输出截断函数;`agentAutoApprove` 判定器(管道/链式逐段、两 token 粒度、sudo/重定向/命令替换否决、条目禁用参数、`timeout` 包装剥离、未闭合引号)。
- **手动矩阵**:

| 场景 | 覆盖 |
| --- | --- |
| 本地 zsh / bash | 主路径、多步任务、退出码非 0 分支 |
| SSH(远端有 OSC 133) | 主路径同上 |
| SSH(远端无标记) | Agent 不可用提示(阶段 1)/ 哨兵(阶段 2) |
| 长输出命令(`cat` 大文件) | 截断、marker 失效兜底 |
| 交互式命令(`sleep 300`、`vim`) | 超时 → awaiting-user → 停止/继续 |
| 运行中断开连接 / 关闭终端 | 任务 error 终止,无悬挂 Promise |
| 取消时机竞态 | 模型请求中停止、审批中停止、执行中停止 |
| 自动执行开启的混合任务 | 只读步自动执行、写操作步落人工、「总是允许」重启后仍生效 |
| 不支持 tools 的网关 | 错误文案 |

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 网关不支持 function calling | 明确报错 + 切回对话建议(5.7);不做静默降级 |
| 命令完成检测在无标记会话不可用 | 阶段 1 显式不可用;阶段 2 哨兵兜底 |
| 交互式/长命令挂住循环 | 系统提示词禁用 + 超时转 awaiting-user;不自动 kill |
| 输出洪泛(`tail -f`) | 捕获截断 + 超时;停止按钮始终可用 |
| 模型循环不收敛 | 步数上限 + skipped 语义让模型感知用户否决 |
| 用户手动输入与 agent 命令串扰 | 命令文本匹配校验(6.2),不匹配即交还用户 |
| 步骤输出含敏感信息落库 | 敏感命令输出不落库(7);上下文仍受既有隐私策略约束 |
| 允许列表被过度泛化(如放行整个 `git`) | 两 token 粒度 + 一票否决规则与风险门前置于列表匹配 + 设置中心可审查删除 |
| 轮次上下文膨胀 | 三层预算与轮次压缩(8) |
