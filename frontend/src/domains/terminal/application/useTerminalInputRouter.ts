import { nextTick, onBeforeUnmount } from 'vue'
import type { ShallowRef } from 'vue'
import type { TerminalPaneHandle as TerminalPaneInstance } from '../domain/terminal'
import type { TerminalInputEvent, TerminalInputSyncState, TerminalInputWriteFailureEvent } from '../domain/events'
import type { useTerminalTabs } from './useTerminalTabs'
import type { useToasts } from '../../../shared/ui/useToasts'

interface TerminalInputRouterOptions {
  tabs: Pick<ReturnType<typeof useTerminalTabs>, 'terminalTabs' | 'activeTerminalId' | 'targetTerminalIds' | 'multiTerminalInputEnabled' | 'isTerminalSyncPaused' | 'pauseTerminalTargets' | 'resumeTerminalSyncTarget'>
  terminalRefs: ShallowRef<Record<string, TerminalPaneInstance | null>>
  showToast: ReturnType<typeof useToasts>['showToast']
  isTerminalAgentControlled?: (terminalId: string) => boolean
}

export function useTerminalInputRouter({ tabs, terminalRefs, showToast, isTerminalAgentControlled = () => false }: TerminalInputRouterOptions) {
  const { terminalTabs, activeTerminalId, targetTerminalIds, multiTerminalInputEnabled, isTerminalSyncPaused, pauseTerminalTargets, resumeTerminalSyncTarget } = tabs
  const pendingDelays = new Map<number, (active: boolean) => void>()
  let disposed = false

  function waitForRetry(milliseconds: number): Promise<boolean> {
    if (disposed || milliseconds === 0) return Promise.resolve(!disposed)
    return new Promise(resolve => {
      const timer = window.setTimeout(() => {
        pendingDelays.delete(timer)
        resolve(!disposed)
      }, milliseconds)
      pendingDelays.set(timer, resolve)
    })
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const [timer, resolve] of pendingDelays) {
      window.clearTimeout(timer)
      resolve(false)
    }
    pendingDelays.clear()
  })

  const COMMAND_EXECUTION_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000]

  function commandPreview(command: string) {
    return command.length > 120 ? `${command.slice(0, 120)}...` : command
  }

  function isActiveTerminalOnlyInput(data: string) {
    return data.includes('AI_TERM_IDENT_') || data.includes('AI_TERM_DOWNLOAD_') || data.includes('AI_TERM_UPLOAD_')
  }

  function writeInputToActiveTerminal(data: string) {
    if (terminalRefs.value[activeTerminalId.value]?.writeTerminalInput(data)) return
    showToast('error', '终端输入未发送', '当前终端不可用或没有活动 shell。')
  }

  async function executeCommandOnTerminalIds(command: string, targets: string[]) {
    const value = command.trim()
    if (!value) return
    const availableTargets = targets.filter((terminalId) => !isTerminalAgentControlled(terminalId))
    if (availableTargets.length === 0 && targets.length > 0) {
      showToast('warning', '终端输入已锁定', '当前终端正在由 Agent 接管；可切换到其他终端执行命令。')
      return
    }
    const pendingTargets = new Set(availableTargets)
    const lastReadiness = new Map<string, ReturnType<TerminalPaneInstance['commandExecutionReadiness']>>()
    let sentCount = 0

    for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
      if (!await waitForRetry(delay)) return
      await nextTick()
      if (disposed) return
      for (const terminalId of [...pendingTargets]) {
        const pane = terminalRefs.value[terminalId]
        const readiness = pane?.commandExecutionReadiness() ?? 'unavailable'
        lastReadiness.set(terminalId, readiness)
        if (readiness === 'ready' && pane?.executeCommand(value)) {
          sentCount += 1
          pendingTargets.delete(terminalId)
        } else if (readiness === 'line-busy') {
          pendingTargets.delete(terminalId)
        }
      }
      if (pendingTargets.size === 0) break
    }

    if (sentCount > 0) {
      showToast('success', sentCount > 1 ? `命令已发送到 ${sentCount} 个终端` : '命令已发送', commandPreview(value))
      return
    }

    const readiness = [...lastReadiness.values()]
    if (readiness.includes('line-busy')) {
      showToast('warning', '命令未发送', '当前命令行已有输入或补全内容，请先提交或清空。')
    } else if (readiness.includes('shell-busy')) {
      showToast('warning', '命令未发送', 'Shell 尚未返回可执行提示符，请稍后重试。')
    } else {
      showToast('error', '命令未发送', '当前终端尚未就绪或连接已断开。')
    }
  }

  function executeCommandOnTargetTerminals(command: string) {
    void executeCommandOnTerminalIds(command, [...targetTerminalIds.value])
  }

  // 与派发路径共用一套重试节奏:刚回车、shell 还没把新提示符吐回来时不该直接判失败。
  // 和派发一样先问就绪再动手,免得 fillCommand 内部的行内提示在每次重试时闪一遍。
  async function fillHistoryCommandOnActiveTerminal(command: string) {
    const value = command.trim()
    if (!value) return
    const terminalId = activeTerminalId.value
    if (isTerminalAgentControlled(terminalId)) {
      showToast('warning', '终端输入已锁定', '当前终端正在由 Agent 接管；任务结束后恢复手动输入。')
      return
    }
    let lastReadiness: ReturnType<TerminalPaneInstance['commandExecutionReadiness']> = 'unavailable'

    for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
      if (!await waitForRetry(delay)) return
      await nextTick()
      if (disposed) return
      if (!terminalTabs.value.some((tab) => tab.id === terminalId)) {
        showToast('warning', '命令未填入', '原终端已关闭。')
        return
      }
      const pane = terminalRefs.value[terminalId]
      lastReadiness = pane?.commandExecutionReadiness() ?? 'unavailable'
      if (lastReadiness === 'ready' && pane?.fillCommand(value)) {
        showToast('success', '已填入终端', commandPreview(value))
        return
      }
      // 行内已有内容是用户自己敲的,等下去也不会变
      if (lastReadiness === 'line-busy') break
    }

    if (lastReadiness === 'line-busy') {
      showToast('warning', '命令未填入', '当前命令行已有输入或补全内容，请先提交或清空。')
    } else if (lastReadiness === 'shell-busy') {
      showToast('warning', '命令未填入', 'Shell 尚未返回可输入提示符，请稍后重试。')
    } else {
      showToast('error', '命令未填入', '当前终端尚未就绪或连接已断开。')
    }
  }

  function pinQuickCommandOnActiveTerminal(command: string) {
    const pane = terminalRefs.value[activeTerminalId.value]
    const result = pane?.pinQuickCommand(command) ?? 'invalid'
    if (result === 'added') {
      showToast('success', '已固定命令', commandPreview(command))
    } else if (result === 'exists') {
      showToast('info', '命令已固定', commandPreview(command))
    } else if (result === 'limit') {
      showToast('warning', '无法固定命令', '当前连接最多保留 12 条固定命令，请先移除一条。')
    } else {
      showToast('warning', '无法固定命令', '该命令为空、过长、包含敏感信息或风险过高。')
    }
  }

  async function writeInputToTargetTerminals(data: string) {
    if (!data) return
    if (isActiveTerminalOnlyInput(data)) {
      if (isTerminalAgentControlled(activeTerminalId.value)) {
        showToast('warning', '终端输入已锁定', '当前终端正在由 Agent 接管；任务结束后恢复手动输入。')
        return
      }
      writeInputToActiveTerminal(data)
      return
    }
    const targets = targetTerminalIds.value.filter((terminalId) => !isTerminalAgentControlled(terminalId))
    if (targets.length === 0 && targetTerminalIds.value.length > 0) {
      showToast('warning', '终端输入已锁定', '当前终端正在由 Agent 接管；可切换到其他终端执行命令。')
      return
    }
    const pendingTargets = new Set(targets)
    const lineBusyTargets = new Set<string>()
    const lastReadiness = new Map<string, ReturnType<TerminalPaneInstance['commandExecutionReadiness']>>()
    let sentCount = 0

    for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
      if (!await waitForRetry(delay)) return
      await nextTick()
      if (disposed) return
      for (const terminalId of [...pendingTargets]) {
        const pane = terminalRefs.value[terminalId]
        const readiness = pane?.commandExecutionReadiness() ?? 'unavailable'
        lastReadiness.set(terminalId, readiness)
        if (readiness === 'ready' && pane?.writeTerminalInput(data)) {
          sentCount += 1
          pendingTargets.delete(terminalId)
        } else if (readiness === 'line-busy') {
          lineBusyTargets.add(terminalId)
          pendingTargets.delete(terminalId)
        }
      }
      if (pendingTargets.size === 0) break
    }

    const waitingCount = [...pendingTargets].filter((terminalId) => lastReadiness.get(terminalId) === 'shell-busy').length
    const skippedCount = pendingTargets.size + lineBusyTargets.size
    if (sentCount === 0) {
      showToast(
        lineBusyTargets.size > 0 || waitingCount > 0 ? 'warning' : 'error',
        '脚本未发送',
        lineBusyTargets.size > 0
          ? '目标终端命令行已有输入，请先提交或清空后重试。'
          : waitingCount > 0
            ? '等待提示符超时；目标终端可能仍在执行命令或处于交互程序中。'
            : '目标终端不可用或没有活动 shell。'
      )
    } else if (skippedCount > 0) {
      showToast('warning', '脚本已部分发送', `已发送到 ${sentCount} 个终端；${skippedCount} 个未就绪终端已跳过。`)
    }
  }

  function terminalInputSyncStatesMatch(source: TerminalInputSyncState, target: TerminalInputSyncState) {
    return source.available &&
      target.available &&
      source.context === 'shell' &&
      target.context === 'shell' &&
      source.reliable &&
      target.reliable &&
      source.command === target.command &&
      source.cursor === target.cursor &&
      source.pendingControlSequence === target.pendingControlSequence
  }

  function terminalInputStateIsEmptyPrompt(state: TerminalInputSyncState) {
    return state.available &&
      state.context === 'shell' &&
      state.reliable &&
      state.command.length === 0 &&
      state.cursor === 0 &&
      state.pendingControlSequence.length === 0
  }

  function pauseTerminalSyncTargets(ids: string[], message: string, notify = true) {
    const added = pauseTerminalTargets(ids)
    if (added.length === 0) return
    if (!notify) return
    showToast(
      'warning',
      added.length > 1 ? '部分终端同步已暂停' : '终端同步已暂停',
      message
    )
  }

  function syncTerminalInputToTargets(event: TerminalInputEvent) {
    if (event.terminalId !== activeTerminalId.value) return
    if (!multiTerminalInputEnabled.value) return
    if (!targetTerminalIds.value.includes(event.terminalId)) return
    const targetIds = targetTerminalIds.value.filter((terminalId) => terminalId !== event.terminalId)

    if (event.data === '\x03') {
      const rejected: string[] = []
      const interruptTargetIds = targetIds.filter((terminalId) => !isTerminalSyncPaused(terminalId))
      interruptTargetIds.forEach((terminalId) => {
        if (!terminalRefs.value[terminalId]?.writeSyncedTerminalInput(event.data, event.terminalId)) {
          rejected.push(terminalId)
        }
      })
      pauseTerminalSyncTargets(rejected, '部分终端无法接收中断输入；已停止继续向这些终端同步。')
      return
    }

    // 补全后的内容由各 Shell 决定，只核对按键前状态；暂停目标仍须双方回到空提示符。
    if (!event.safeToSync && event.data !== '\t') {
      pauseTerminalSyncTargets(
        targetIds,
        '当前按键依赖各终端自己的历史、补全或交互状态，未广播到其他终端。回到空提示符后会自动恢复。'
      )
      return
    }

    const sourceAtEmptyPrompt = terminalInputStateIsEmptyPrompt(event.beforeState)
    const alignedTargets: Array<{ terminalId: string; pane: TerminalPaneInstance }> = []
    const mismatched: string[] = []
    targetIds.forEach((terminalId) => {
      const pane = terminalRefs.value[terminalId]
      const targetState = pane?.terminalInputSyncState()
      if (!pane || !targetState || !terminalInputSyncStatesMatch(event.beforeState, targetState)) {
        if (!isTerminalSyncPaused(terminalId)) mismatched.push(terminalId)
        return
      }
      if (isTerminalSyncPaused(terminalId)) {
        if (!sourceAtEmptyPrompt || !terminalInputStateIsEmptyPrompt(targetState)) return
        resumeTerminalSyncTarget(terminalId)
      }
      alignedTargets.push({ terminalId, pane })
    })

    pauseTerminalSyncTargets(
      mismatched,
      '各终端的命令行、光标或提示符状态不一致；已暂停失配终端，回到空提示符后会自动恢复。'
    )

    const rejected: string[] = []
    alignedTargets.forEach(({ terminalId, pane }) => {
      if (!pane.writeSyncedTerminalInput(event.data, event.terminalId)) rejected.push(terminalId)
    })
    pauseTerminalSyncTargets(rejected, '部分终端未能接收输入；已停止继续向这些终端同步。')
  }

  function handleTerminalInputWriteFailure(event: TerminalInputWriteFailureEvent) {
    const terminalTitle = terminalTabs.value.find((tab) => tab.id === event.terminalId)?.title ?? '目标终端'
    let syncDetail = ''
    if (targetTerminalIds.value.includes(event.terminalId)) {
      if (event.terminalId === activeTerminalId.value) {
        const otherTargetIds = targetTerminalIds.value.filter((id) => id !== event.terminalId)
        pauseTerminalSyncTargets(
          otherTargetIds,
          '当前终端输入失败，多终端键盘同步已暂停。',
          false
        )
        if (otherTargetIds.length > 0) syncDetail = ' 其他选中终端的键盘同步已暂停。'
      } else {
        pauseTerminalSyncTargets([event.terminalId], terminalTitle + ' 输入失败，已暂停向该终端同步。', false)
        syncDetail = ' 已暂停向该终端同步。'
      }
    }
    showToast(
      'error',
      '终端输入写入失败',
      terminalTitle + ' 的输入队列已停止，请重新连接后再试。' + syncDetail + (event.message ? ' ' + event.message : '')
    )
  }

  return { executeCommandOnTerminalIds, executeCommandOnTargetTerminals, fillHistoryCommandOnActiveTerminal, pinQuickCommandOnActiveTerminal, writeInputToTargetTerminals, syncTerminalInputToTargets, handleTerminalInputWriteFailure }
}
