# 前端轻量 DDD 架构实施方案

## 1. 目标

本项目采用业务域模块化的前端架构，以轻量领域驱动设计（DDD）约束代码边界。目标不是引入后端式的复杂领域框架，而是让业务规则、应用流程、外部适配和界面展示各自拥有明确位置。

实施必须保持现有终端优先布局、中文界面、Tauri IPC 协议、存储键、Agent 审批策略和连接代次保护不变。

## 2. 目标目录

```text
frontend/src/
  app/
    App.vue
    bootstrap/
    layout/
    ui/
    styles/

  domains/
    connections/
      domain/
      application/
      infrastructure/
      presentation/
        components/
        styles/
    terminal/
    ai/
    scripts/
    transfer/
    settings/

  shared/
    platform/
    security/
    content/
    ui/
    styles/

  main.ts
  vite-env.d.ts
```

`main.ts` 是 Vite/Vue 的标准启动入口，保留在 `src` 根目录。`App.vue` 属于应用壳，归入 `app/App.vue`。根目录不再放业务组件、业务 composable、通用 lib 或集中式业务 CSS。

## 3. 分层规则

### Domain

放置领域对象、值对象和纯业务规则。不得依赖 Vue、DOM、Tauri 或具体 UI。

示例：终端输入规则、脚本风险分析、传输路径规则、会话标题规则。

### Application

放置业务用例、响应式状态、异步流程和生命周期清理。可以依赖 Vue 和 domain，但不负责渲染具体界面。

示例：连接配置保存、AI 请求取消、脚本生成流程、传输任务队列。

### Infrastructure

放置 Tauri IPC、事件监听、localStorage、凭据和其他外部系统适配。Infrastructure 实现 application/domain 所需的接口，不反向依赖 presentation。

### Presentation

放置 Vue 页面、组件、交互和领域样式。大型面板拆成职责明确的子组件，根面板只负责组合和事件转发。

## 4. 依赖方向

```text
app
  ↓
presentation
  ↓
application
  ↓
domain

infrastructure ── implements ──> application/domain contracts

shared 不依赖 app 或任何 domain
```

业务域之间禁止导入对方的私有文件。跨域访问只能使用明确的公共入口，例如 `index.ts`、`types.ts`、`views.ts` 或公开的 API contract。跨域流程优先由 `app` 编排。

## 5. CSS 组织

CSS 与拥有它的模块同目录维护：

```text
app/styles/
  index.css
  app-shell.css
  workspace.css
  responsive.css

domains/terminal/presentation/styles/
  terminal.css
  completion.css
  authentication.css

domains/ai/presentation/styles/
  panel.css
  messages.css
  agent.css

shared/styles/
  tokens.css
  reset.css
  primitives.css
  overlays.css
```

`app/styles/index.css` 只负责确定性地引入全局基础样式和应用布局样式。业务组件的样式由对应 presentation 入口引入；组件私有样式优先使用 Vue `<style scoped>`。

不使用 `01-`、`02-` 等序号文件名。级联关系通过 `index.css` 的显式导入顺序表达。迁移阶段保持原始选择器顺序，去重和视觉优化放在结构迁移之后。

## 6. 大文件拆分计划

### TerminalPane

拆分为终端工具栏、补全面板、SSH 密码认证、SSH 主机密钥确认和输出展示组件。终端实例、连接代次和事件资源必须由唯一的终端应用层持有。

### FileTransferPanel

拆分为目录浏览、目标选择、传输任务列表和远程文件编辑器。异步读取必须保留连接切换隔离和迟到结果保护。

### ScriptPanel

拆分为录制器、脚本库、脚本编辑器、生成对话和风险确认组件。执行目标、风险确认和中断逻辑留在 scripts application/domain。

### AiPanel

拆分为会话列表、消息列表、输入区、命令风险确认和 Agent 运行状态组件。请求、流式取消和 Agent 编排不放在展示组件中。

### AppShell

只保留全局布局、活动终端、跨域事件编排和全局弹层。具体连接、会话、命令历史和 Agent 业务流程继续归属对应 domain。

## 7. 实施阶段

1. 建立并执行架构边界测试，禁止旧技术目录和反向依赖回归。
2. 将应用入口和全局样式归入 `app`，根目录只保留启动入口。
3. 将现有 domain 的 `model/application/api/ui/storage` 语义化归档到 `domain/application/infrastructure/presentation`。
4. 先拆 Terminal，再拆 AI、Transfer、Scripts，优先保护异步取消、连接代次和终端实例生命周期。
5. 将每个 domain 的样式迁移到 presentation 下，删除集中式业务样式。
6. 每个阶段执行类型检查、领域测试、UI 契约测试、生产构建和浏览器回归。
7. 最后删除兼容入口和临时文件，更新架构文档与验收记录。

## 8. 验收标准

- `domain` 不依赖 Vue、Tauri、DOM 和 presentation。
- `shared` 不依赖 app 或任何 domain。
- domain 之间没有私有深层导入。
- 业务 CSS 不集中于单个全局文件，且不使用序号命名。
- 单个 Vue 文件只负责一个清晰的展示边界，不机械按行切割。
- 终端实例不会因组件拆分而重复创建、错误卸载或丢失输入。
- 构建产物、UI 契约和浏览器行为保持兼容。
- 原生 Tauri、SSH、SFTP 验收与浏览器预览结果分开记录。

## 9. 不采用的做法

- 不创建全局 `components`、`composables`、`services` 大杂物目录。
- 不为所有函数强行创建 Repository、Factory 或 Entity 基类。
- 不把所有 CSS 重新集中到一个 styles 目录。
- 不通过拼接源码、删除断言或放宽测试来掩盖迁移问题。
- 不为了降低行数而破坏终端、Agent 或传输的资源所有权。
