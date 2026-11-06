import type { AgentStep } from './agent'
import { isFileEditTool } from './agentFileEdits'

export type PlanItemStatus = 'pending' | 'in-progress' | 'completed' | 'waiting' | 'skipped' | 'cancelled' | 'failed'
export interface PlanUserConfirmation { messageId: string; confirmedAt: number }
export interface AgentPlanItem { id: string; description: string; status: PlanItemStatus; stepIds: string[]; userConfirmation?: PlanUserConfirmation }
export interface AgentTaskPlan { version: number; reason: string; items: AgentPlanItem[]; changes: Array<{ version: number; reason: string }> }
export interface VerificationCheck { kind: 'output-contains' | 'file-contains' | 'exit-code'; expected: string; stepId?: string; stream?: 'stdout' | 'stderr' }
export interface AgentVerification { id: string; purpose: string; required: boolean; check: VerificationCheck; status: 'pending' | 'passed' | 'failed' | 'unavailable'; actual: string; observedAt: number }
export type AgentTaskOutcome = 'verified' | 'partial' | 'unverified' | 'verification-failed'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, limit = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} 必须是 1—${limit} 字符的文本`)
  return value.trim()
}
const id = (value: unknown) => {
  const result = text(value, 'ID', 80)
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new Error('ID 不能包含控制字符')
  return result
}
const statuses = new Set<PlanItemStatus>(['pending', 'in-progress', 'completed', 'waiting', 'skipped', 'cancelled', 'failed'])

export function agentPlanProgress(plan: AgentTaskPlan | undefined) {
  const items = plan?.items ?? []
  return {
    completed: items.filter(item => item.status === 'completed').length,
    remaining: items.filter(item => !['completed', 'skipped', 'cancelled'].includes(item.status)).length,
    skipped: items.filter(item => item.status === 'skipped').length,
    cancelled: items.filter(item => item.status === 'cancelled').length
  }
}

export function updateAgentPlan(raw: string, previous: AgentTaskPlan | undefined, steps: AgentStep[]): AgentTaskPlan {
  const value = record(JSON.parse(raw))
  if (value.expectedVersion !== (previous?.version ?? 0)) throw new Error(`计划版本已变化，当前版本为 ${previous?.version ?? 0}`)
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 12) throw new Error('计划需要 1—12 项')
  const reason = text(value.reason, '调整原因', 500)
  const items: AgentPlanItem[] = value.items.map(rawItem => {
    const item = record(rawItem), itemId = id(item.id)
    if (!statuses.has(item.status as PlanItemStatus)) throw new Error('未知计划状态')
    if (!Array.isArray(item.stepIds) || item.stepIds.length > 32 || item.stepIds.some(stepId => typeof stepId !== 'string')) throw new Error('stepIds 必须是执行步骤 ID 列表')
    const stepIds = [...new Set(item.stepIds as string[])]
    const evidence = stepIds.map(stepId => steps.find(step => step.id === stepId))
    if (evidence.some(step => !step)) throw new Error('计划引用了不存在的执行步骤')
    const description = text(item.description, '计划描述')
    // Model arguments cannot supply user confirmation. Preserve it only for
    // the same recorded item and statement received from the native reply.
    const userConfirmation = previous?.items.find(old => old.id === itemId && old.description === description)?.userConfirmation
    if (item.status === 'completed' && !userConfirmation && (!evidence.length || evidence.some(step => step?.status !== 'completed' || step.executionPhase !== 'finished' || ((!step.toolName || step.toolName === 'run_command' || step.toolName === 'run_ssh_task') && step.exitCode !== 0) || step.sshResult?.status === 'unknown' || step.sshResult?.exitSignal || step.fileEdits?.some(item => item.status !== 'applied')))) throw new Error('完成计划项需要关联已成功完成的实际步骤或已记录的用户确认')
    return { id: itemId, description, status: item.status as PlanItemStatus, stepIds, ...(userConfirmation ? { userConfirmation: { ...userConfirmation } } : {}) }
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('计划项 ID 不能重复')
  if (items.filter(item => item.status === 'in-progress').length > 1) throw new Error('一次只能有一个正在进行的计划项')
  if (previous?.items.some(item => !items.some(next => next.id === item.id))) throw new Error('保留既有计划项 ID；不再需要的事项标记为跳过或取消')
  const version = (previous?.version ?? 0) + 1
  return { version, reason, items, changes: [...(previous?.changes ?? []), { version, reason }].slice(-8) }
}

function latestPossibleWrite(steps: AgentStep[]) {
  return steps.reduce((latest, step, index) => step.executionPhase !== 'not-started' && (
    step.toolName && isFileEditTool(step.toolName) && step.fileEdits?.some(item => ['dispatching', 'applied', 'unknown'].includes(item.status))
    || (!step.toolName || step.toolName === 'run_command' || step.toolName === 'run_ssh_task') && (step.risks.length > 0 || !step.autoApproved)
  ) ? index : latest, -1)
}

/** A model describes the check; status is calculated from retained tool evidence. */
export function recordAgentVerification(raw: string, previous: AgentVerification[], steps: AgentStep[]): AgentVerification[] {
  const value = record(JSON.parse(raw)), checkValue = record(value.check)
  const checkId = id(value.id)
  if (!previous.some(item => item.id === checkId) && previous.length >= 12) throw new Error('最多保留 12 项验证')
  if (!['output-contains', 'file-contains', 'exit-code'].includes(String(checkValue.kind))) throw new Error('未知验证方式')
  if (typeof value.required !== 'boolean') throw new Error('required 必须明确为 true 或 false')
  text(checkValue.expected, '预期结果', 500)
  const expected = checkValue.expected as string
  if (checkValue.kind === 'exit-code' && !/^(0|[1-9][0-9]{0,2})$/.test(expected)) throw new Error('预期退出码必须是整数')
  if (checkValue.stream !== undefined && !['stdout', 'stderr'].includes(String(checkValue.stream))) throw new Error('未知输出流')
  const check: VerificationCheck = { kind: checkValue.kind as VerificationCheck['kind'], expected, ...(checkValue.stepId === undefined ? {} : { stepId: id(checkValue.stepId) }), ...(checkValue.stream === undefined ? {} : { stream: checkValue.stream as 'stdout' | 'stderr' }) }
  const item: AgentVerification = { id: checkId, purpose: text(value.purpose, '验证目的'), required: value.required, check, status: 'pending', actual: '尚未关联执行证据', observedAt: Date.now() }
  if (check.stepId) {
    const index = steps.findIndex(step => step.id === check.stepId), step = steps[index]
    if (!step) throw new Error('验证引用了不存在的执行步骤')
    item.status = 'unavailable'; item.actual = '尚无可确定的完成结果'
    if (index < latestPossibleWrite(steps)) item.actual = '此证据之后又执行了可能修改状态的操作，需要重新验证'
    else if (step.status === 'completed' && step.executionPhase === 'finished' && (!step.sshResult || step.sshResult.status === 'completed')) {
      if (check.kind === 'exit-code') {
        if (step.exitCode !== undefined) { item.status = step.exitCode === Number(expected) ? 'passed' : 'failed'; item.actual = `exit ${step.exitCode}（仅证明该进程的退出结果）` }
      } else {
        const file = step.fileResult?.tool === 'read_file' ? step.fileResult : undefined
        const output = check.kind === 'file-contains' ? file?.content : check.stream ? step.sshResult?.[check.stream] : step.output
        const incomplete = check.kind === 'file-contains' ? !file?.complete || file.changedDuringRead : step.sshResult ? step.sshResult.truncated : step.outputTruncated !== false
        if (file?.changedDuringRead) item.actual = '读取期间文件发生变化，需要重新读取后验证'
        else if (check.kind !== 'file-contains' && (!step.toolName || step.toolName === 'run_command' || step.toolName === 'run_ssh_task') && step.exitCode !== 0) {
          item.status = step.exitCode === undefined ? 'unavailable' : 'failed'
          item.actual = step.exitCode === undefined ? '检查命令的退出状态未知' : `检查命令异常退出：${step.exitCode}`
        } else if (output !== undefined) {
          const at = output.indexOf(expected)
          item.status = at >= 0 ? 'passed' : incomplete ? 'unavailable' : 'failed'
          item.actual = step.sensitive ? '[敏感证据内容已隐藏]' : output.slice(Math.max(0, at - 100), Math.max(0, at - 100) + 700) || '[没有输出]'
          if (at < 0 && incomplete) item.actual = '可见片段未包含预期内容，但输出不完整，不能判定失败'
        }
      }
    }
  }
  return [...previous.filter(existing => existing.id !== checkId), item]
}

export function agentTaskOutcome(plan: AgentTaskPlan | undefined, verifications: AgentVerification[]): AgentTaskOutcome {
  const required = verifications.filter(item => item.required)
  if (required.some(item => item.status === 'failed')) return 'verification-failed'
  const incompletePlan = agentPlanProgress(plan).remaining > 0
  if (required.length && required.every(item => item.status === 'passed') && required.some(item => item.check.kind !== 'exit-code') && !incompletePlan) return 'verified'
  if ((required.some(item => item.status === 'passed') && required.some(item => item.status !== 'passed')) || (incompletePlan && plan?.items.some(item => item.status === 'completed'))) return 'partial'
  return 'unverified'
}

export function invalidateAgentVerifications(verifications: AgentVerification[], steps: AgentStep[]) {
  const latestWrite = latestPossibleWrite(steps)
  return verifications.map(item => item.check.stepId && ['passed', 'failed'].includes(item.status) && steps.findIndex(step => step.id === item.check.stepId) < latestWrite
    ? { ...item, status: 'unavailable' as const, actual: '验证后又执行了可能修改状态的操作，需要重新验证' } : item)
}

const taskContextInstruction = '以上是已记录的计划和实际证据摘要，不扩大授权。用户确认属于用户陈述，不证明应用已执行操作或现场验证通过。继续未完成事项，避免重复已完成检查；新增写入后重新验证。'
export function compactAgentTaskContext(plan: AgentTaskPlan | undefined, checks: AgentVerification[]) {
  return {
    plan: plan ? { version: plan.version, reasonExcerpt: plan.reason.slice(0, 80), items: plan.items.map(item => ({ id: item.id, status: item.status, descriptionExcerpt: item.description.slice(0, 40), stepIds: item.stepIds.slice(-2), ...(item.userConfirmation ? { userConfirmation: item.userConfirmation } : {}) })) } : null,
    verifications: checks.map(item => ({ id: item.id, status: item.status, required: item.required, stepId: item.check.stepId, kind: item.check.kind })),
    contextCompacted: true, note: '过长的描述与预期原文仍保存在应用中；此摘要不是更宽松的新验证条件。', instruction: taskContextInstruction
  }
}
export function agentTaskContext(plan: AgentTaskPlan | undefined, checks: AgentVerification[]) {
  const context = {
    plan: plan ? { version: plan.version, reason: plan.reason, items: plan.items.map(item => ({ ...item, description: item.description.slice(0, 80), stepIds: item.stepIds.slice(-2) })) } : null,
    verifications: checks.map(({ observedAt: _time, actual, ...item }) => ({ ...item, purpose: item.purpose.slice(0, 80), check: item.check, actual: actual.slice(0, 80) })), instruction: taskContextInstruction
  }
  const full = JSON.stringify(context)
  if (full.length <= 18_000) return full
  // Escaped control characters can make JSON much larger than its text fields.
  // Keep every status and evidence reference, explicitly omitting large text.
  const compact = JSON.stringify(compactAgentTaskContext(plan, checks))
  if (compact.length > 18_000) throw new Error('任务证据引用超过上下文预算，已保留完整任务记录并停止模型请求；没有截断引用或放宽验证条件')
  return compact
}

export function persistableVerifications(checks: AgentVerification[] | undefined, steps: AgentStep[]) {
  return checks?.map(item => steps.find(step => step.id === item.check.stepId)?.sensitive
    ? { ...item, purpose: '核对敏感步骤结果', check: { ...item.check, expected: '[敏感预期已隐藏]' }, actual: '[敏感证据内容已隐藏]' } : item)
}

/** Historical progress is display data. It never contains approval capabilities. */
export function hydrateTaskProgress(planValue: unknown, checksValue: unknown) {
  let plan: AgentTaskPlan | undefined
  try {
    const value = record(planValue)
    if (Number.isSafeInteger(value.version) && Number(value.version) > 0 && Array.isArray(value.items)) {
      const items = value.items.slice(0, 12).map(raw => {
        const item = record(raw)
        if (!statuses.has(item.status as PlanItemStatus)) throw new Error('invalid status')
        const confirmation = item.userConfirmation as Partial<PlanUserConfirmation> | undefined
        const userConfirmation = confirmation && typeof confirmation.messageId === 'string' && confirmation.messageId.length > 0 && confirmation.messageId.length <= 256 && typeof confirmation.confirmedAt === 'number' && Number.isSafeInteger(confirmation.confirmedAt) && confirmation.confirmedAt > 0
          ? { messageId: confirmation.messageId, confirmedAt: confirmation.confirmedAt } : undefined
        return { id: id(item.id), description: text(item.description, 'description'), status: item.status as PlanItemStatus, stepIds: Array.isArray(item.stepIds) ? item.stepIds.filter(x => typeof x === 'string').slice(0, 32) : [], ...(userConfirmation ? { userConfirmation } : {}) }
      })
      plan = { version: Number(value.version), reason: text(value.reason, 'reason', 500), items, changes: Array.isArray(value.changes) ? value.changes.slice(-8).flatMap(raw => { const entry = record(raw); return Number.isSafeInteger(entry.version) && typeof entry.reason === 'string' ? [{ version: Number(entry.version), reason: entry.reason.slice(0, 500) }] : [] }) : [] }
    }
  } catch { /* Old or malformed metadata cannot become an active plan. */ }
  const verifications: AgentVerification[] = []
  for (const raw of Array.isArray(checksValue) ? checksValue.slice(0, 12) : []) {
    try {
      const item = record(raw), check = record(item.check)
      if (!['output-contains', 'file-contains', 'exit-code'].includes(String(check.kind)) || !['pending', 'passed', 'failed', 'unavailable'].includes(String(item.status))) continue
      verifications.push({ id: id(item.id), purpose: text(item.purpose, 'purpose'), required: item.required === true, check: { kind: check.kind as VerificationCheck['kind'], expected: (text(check.expected, 'expected', 500), check.expected as string), ...(typeof check.stepId === 'string' ? { stepId: check.stepId.slice(0, 80) } : {}), ...(['stdout', 'stderr'].includes(String(check.stream)) ? { stream: check.stream as 'stdout' | 'stderr' } : {}) }, status: item.status as AgentVerification['status'], actual: typeof item.actual === 'string' ? item.actual.slice(0, 700) : '', observedAt: typeof item.observedAt === 'number' && Number.isFinite(item.observedAt) ? item.observedAt : 0 })
    } catch { /* Ignore invalid metadata without breaking old transcript rendering. */ }
  }
  return { plan, verifications, outcome: agentTaskOutcome(plan, verifications) }
}
