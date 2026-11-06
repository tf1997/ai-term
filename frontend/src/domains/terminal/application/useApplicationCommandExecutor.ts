import type { ShallowRef } from 'vue'
import type { TerminalPaneHandle, TerminalTab } from '../domain/terminal'
import type { AgentCommandPolicy, ApplicationCommandExecutor, CommandIntent } from '../../../shared/security/commandPolicy'
import type { CommandReviewer, CommandReviewItem } from './useCommandPolicyReview'
import * as policy from '../infrastructure/commandPolicy'

export function createApplicationCommandExecutor(options: {
  panes: ShallowRef<Record<string, TerminalPaneHandle | null>>
  tabs: () => readonly Pick<TerminalTab, 'id' | 'title' | 'connectionId' | 'connectionGeneration'>[]
  targets: () => string[]
  isAgentControlled: (id: string) => boolean
  review: CommandReviewer
}, source: Pick<typeof policy, 'approveCommandIntent' | 'cancelCommandIntent'> = policy) {
  function bind(id: string, generation?: number) {
    const tab = options.tabs().find(tab => tab.id === id)
    const pane = options.panes.value[id]
    if (!tab || !pane || (generation !== undefined && tab.connectionGeneration !== generation)) throw new Error('目标终端已关闭或重新连接')
    const boundGeneration = tab.connectionGeneration
    return { pane, tab, check() {
      const current = options.tabs().find(tab => tab.id === id)
      if (!current || current.connectionGeneration !== boundGeneration || options.panes.value[id] !== pane) throw new Error('分析后执行目标已经变化，请重新发起操作')
    } }
  }
  const agentPolicy: AgentCommandPolicy = {
    async target(id, generation) {
      const bound = bind(id, generation)
      const target = await bound.pane.prepareExecutionTarget(true)
      bound.check()
      return target
    },
    async prepare(id, generation, commandSource) {
      const bound = bind(id, generation)
      const intent = await bound.pane.prepareCommandIntent(commandSource, 'command', true)
      try { bound.check(); return intent }
      catch (error) { void source.cancelCommandIntent(intent.reference).catch(() => {}); throw error }
    },
    approve: intent => source.approveCommandIntent(intent.reference, intent.source),
    cancel: intent => source.cancelCommandIntent(intent.reference)
  }
  const execute: ApplicationCommandExecutor = async (commandSource, operation, sourceConnectionId) => {
    if (!commandSource.trim()) return false
    const bindings = options.targets().map(id => {
      if (options.isAgentControlled(id)) throw new Error('目标终端正在由 Agent 接管')
      return bind(id)
    })
    if (!bindings.length) throw new Error('没有选中的执行目标')
    const items: CommandReviewItem[] = []
    try {
      for (const bound of bindings) {
        bound.check()
        const intent = await bound.pane.prepareCommandIntent(commandSource, operation)
        items.push({ intent, label: bound.tab.title })
        bound.check()
      }
      const mismatch = Boolean(sourceConnectionId && bindings.some(({ tab }) => tab.connectionId !== sourceConnectionId))
      if (mismatch || items.some(({ intent }) => intent.analysis.decision !== 'allow')) {
        if (!await options.review(items, mismatch ? '来源连接与执行目标不同，请核对上述目标。' : undefined)) return false
        if (items.some(({ intent }) => intent.analysis.decision === 'deny')) throw new Error('命令被策略阻止，无法批准')
        for (const { intent } of items) await source.approveCommandIntent(intent.reference, commandSource)
      }
      bindings.forEach(bound => bound.check())
      for (let index = 0; index < bindings.length; index += 1) {
        const bound = bindings[index]
        bound.check()
        if (options.isAgentControlled(bound.tab.id)) throw new Error('目标终端已经由 Agent 接管')
        await dispatch(bound.pane, items[index].intent)
      }
      return true
    } finally {
      await Promise.allSettled(items.map(({ intent }) => source.cancelCommandIntent(intent.reference)))
    }
  }
  return { execute, agentPolicy }
}

function dispatch(pane: TerminalPaneHandle, intent: CommandIntent) {
  return new Promise<void>((resolve, reject) => {
    if (!pane.dispatchPreparedCommand(intent, reject, resolve)) reject(new Error('目标终端未就绪，命令未发送'))
  })
}
