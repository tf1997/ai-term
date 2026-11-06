import { computed, shallowReactive, watch } from 'vue'
import type { AiPanelProps, AiSessionActivity, AiSessionPanelsProps, AiTerminalContext } from '../domain/aiPanel'

function terminalContext(props: AiTerminalContext): AiTerminalContext {
  const { terminalId, terminalConnectionGeneration, connectionId, executionTargetLabel, executionTargetTitle,
    executionTargetConnectionIds, terminalSnapshot, terminalSelection, commandHistory,
    agentAvailabilityCheck, agentAvailabilityConfirm, sshTasks } = props
  return { terminalId, terminalConnectionGeneration, connectionId, executionTargetLabel, executionTargetTitle,
    executionTargetConnectionIds, terminalSnapshot, terminalSelection, commandHistory,
    agentAvailabilityCheck, agentAvailabilityConfirm, sshTasks }
}

/** One mounted controller per visited conversation. Navigation never disposes a running task. */
export function useAiSessionPanels(props: Readonly<AiSessionPanelsProps>, onActivity: (activity: AiSessionActivity) => void) {
  const entries = shallowReactive(new Map<string, {
    context: AiTerminalContext
    bound: boolean
    takenTerminal: string
    messages: AiPanelProps['messages']
  }>())
  const activities = shallowReactive<Record<string, AiSessionActivity>>({})
  const owner = (terminalId: string) => [...entries].find(([, entry]) => entry.takenTerminal === terminalId)?.[0]
  watch(() => [props.workspaceSessionId, props.workspaceSessions.map(session => [session.id, session.aiMode]), props.terminalId, props.terminalConnectionGeneration], () => {
    const id = props.workspaceSessionId
    if (id && !entries.has(id)) entries.set(id, shallowReactive({ context: terminalContext(props), bound: false, takenTerminal: '', messages: props.messages }))
    for (const [sessionId, entry] of entries) {
      const session = props.workspaceSessions.find(item => item.id === sessionId)
      if (!session && !entry.takenTerminal && (!activities[sessionId] || activities[sessionId].status === 'idle')) {
        entries.delete(sessionId); delete activities[sessionId]; continue
      }
      if (sessionId !== id || entry.takenTerminal) continue
      if (session?.aiMode !== 'agent' || props.terminalContexts && !props.terminalContexts[entry.context.terminalId]) entry.bound = false
      if (!entry.bound) entry.context = terminalContext(props)
    }
  }, { immediate: true, flush: 'sync' })

  function takeover(sessionId: string, terminalId: string, active: boolean): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    if (active) {
      const currentOwner = owner(terminalId)
      if (currentOwner && currentOwner !== sessionId) return false
      if (entry.takenTerminal && entry.takenTerminal !== terminalId) return false
      if (props.agentTakeoverChange?.(terminalId, true) === false) return false
      entry.context = terminalContext(props.terminalContexts?.[terminalId] ?? (terminalId === props.terminalId ? props : entry.context))
      entry.bound = true
      entry.takenTerminal = terminalId
    } else if (entry.takenTerminal === terminalId) {
      entry.takenTerminal = ''
      props.agentTakeoverChange?.(terminalId, false)
    }
    return true
  }

  function activityChanged(activity: AiSessionActivity) {
    if (!entries.has(activity.sessionId)) return
    activities[activity.sessionId] = activity
    onActivity(activity)
  }

  const panels = computed(() => {
    const { messagesBySession, contextBySession, terminalContexts, ...shared } = props
    return [...entries].map(([sessionId, entry]) => {
      const active = props.active !== false && sessionId === props.workspaceSessionId
      const context = entry.bound || sessionId !== props.workspaceSessionId
        ? terminalContexts?.[entry.context.terminalId] ?? entry.context : terminalContext(props)
      const availability = () => {
        const currentOwner = owner(context.terminalId)
        if (currentOwner && currentOwner !== sessionId) return '此终端正在被其他会话的 Agent 使用，请切换空闲终端或新建会话'
        if (terminalContexts && !terminalContexts[context.terminalId]) return '会话绑定的终端已关闭'
        return context.agentAvailabilityCheck?.() ?? ''
      }
      return { id: sessionId, props: {
        ...shared, ...context, active, workspaceSessionId: sessionId, sessionActivities: activities,
        messages: messagesBySession?.[sessionId] ?? (sessionId === props.workspaceSessionId ? props.messages : entry.messages),
        contextStatus: contextBySession?.[sessionId] ?? (sessionId === props.workspaceSessionId ? props.contextStatus : undefined),
        agentAvailabilityCheck: availability,
        agentAvailabilityConfirm: async () => availability() || await context.agentAvailabilityConfirm?.() || '',
        agentTakeoverChange: (terminalId: string, taking: boolean) => takeover(sessionId, terminalId, taking)
      } satisfies AiPanelProps }
    })
  })
  return { panels, activities, activityChanged, takeover }
}
