import { scanCommand } from '../../../shared/security/shellCommandScan'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
import { TASK_SCRIPT_FILE_PROGRAM } from './taskScriptFiles'
import type { TaskScriptFileChange } from './taskScriptFiles'
import type { CommandScriptSource } from '../../../shared/security/commandPolicy'
export type { TaskScriptFileChange } from './taskScriptFiles'

export interface TaskScriptEnvironment { profileId: string; routeKey: string; user: string; environmentScope: string; shell: string }
export interface TaskScriptStep {
  id: string; tool: string; command: string; status: string; executionPhase: string; exitCode: number | null; sensitive: boolean
  directory: string | null; environment: TaskScriptEnvironment | null
  fileChanges?: TaskScriptFileChange[]
  fileChangeCount?: number
  commandSource?: CommandScriptSource
}
export interface TaskScriptCheck { id: string; purpose: string; kind: string; expected: string; stepId: string | null; required: boolean; status: string }
export interface TaskScriptSource { runId: string; messageId: string; workspaceSessionId: string; steps: TaskScriptStep[]; checks: TaskScriptCheck[] }
export interface ScriptParameter { name: string; label: string; type: 'directory' | 'service' | 'text' | 'secret'; defaultValue: string | null; required: boolean }
export const taskScriptOmissionLabels = {
  'not-selected': '未选择此步骤，请核对所选流程是否依赖它',
  'different-environment': '属于其他目标范围，需要分别整理',
  'not-completed': '没有明确成功的执行结果',
  'unknown-exit': '没有明确成功的退出结果',
  'unsupported-tool': '此工具需要单独整理，不能拼接为当前 Shell 脚本',
  'missing-environment': '缺少当时目录、账号或环境证据',
  'missing-file-evidence': '缺少完整且同目标的成功文件变更记录，或包含需单独处理的元数据恢复',
  'unsupported-file': '文件变更内容或路径无法完整复用',
  'unsupported-shell': '原 Shell 不在支持的脚本转换范围内',
  'sensitive-source': '敏感命令不复制；请使用明确的外部输入另行编写',
  'invalid-source': '命令原文不完整或包含保留标识',
  'unsupported-command': '复杂 Shell 结构需手动整理后审查',
  'session-state': '依赖运行时展开或会话状态，需先改为明确参数'
} as const
export interface TaskScriptOmission { stepId: string; tool: string; status: string; reason: keyof typeof taskScriptOmissionLabels }
export interface TaskScriptOmittedCheck { id: string; stepId: string | null; required: boolean; status: string }
export function taskScriptOmissionDescription(item: Pick<TaskScriptOmission, 'tool' | 'reason'>) {
  return item.reason === 'unsupported-tool' && item.tool === 'run_ssh_task' ? '独立 SSH 任务需要在其执行环境中单独整理' : taskScriptOmissionLabels[item.reason]
}
const taskMetadataMaxBytes = 512 * 1024
export interface TaskScriptMetadata {
  version: 1
  revision: number
  source: { runId: string; messageId: string; workspaceSessionId: string; stepIds: string[] }
  environment: TaskScriptEnvironment
  parameters: ScriptParameter[]
  checks: TaskScriptCheck[]
  prerequisites: string[]
  omittedSteps?: TaskScriptOmission[]
  omittedChecks?: TaskScriptOmittedCheck[]
}
export interface TaskScriptDraft { content: string; metadata: TaskScriptMetadata; sourceCommands: string[] }
export interface TaskScriptCandidate { step: TaskScriptStep; eligible: boolean; reason: string; reasonCode?: TaskScriptOmission['reason'] }

const parameterPrefix = '__AI_TERM_PARAM_'
const parameterToken = (name: string) => `${parameterPrefix}${name}__`
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
const safeLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
const contextCommands = new Set(['source', '.', 'export', 'unset', 'alias', 'unalias', 'set', 'setopt', 'shopt', 'eval', 'exec', 'exit', 'return', 'read', 'trap', '_ai_term_file_change'])
const zshContextCommands = new Set(['autoload', 'zmodload', 'emulate', 'bindkey', 'compdef', 'zstyle', 'functions', 'unfunction', 'disable', 'enable', 'typeset', 'local', 'pushd', 'popd', 'umask', 'ulimit', 'limit', 'unlimit', 'wait', 'fg', 'bg', 'disown', 'jobs'])
function changesZshSession(words: Array<{ value: string }>) {
  let index = 0
  while (['builtin', 'command', 'noglob', 'nocorrect'].includes(words[index]?.value)) {
    const modifier = words[index++].value
    if (modifier === 'command' && ['-v', '-V'].includes(words[index]?.value)) return false
    while (['--', '-p'].includes(words[index]?.value)) index++
  }
  return contextCommands.has(words[index]?.value) || zshContextCommands.has(words[index]?.value)
}

export function taskScriptEnvironmentKey(environment: TaskScriptEnvironment) {
  return JSON.stringify([environment.profileId, environment.routeKey, environment.user, environment.environmentScope])
}

/** A draft only reuses source whose input and successful outcome are retained.
 * Unsupported state transitions remain visible as prerequisites for a human. */
export function taskScriptCandidates(source: TaskScriptSource): TaskScriptCandidate[] {
  return source.steps.map(step => {
    let reason: TaskScriptOmission['reason'] | undefined
    const candidate = (): TaskScriptCandidate => ({ step, eligible: !reason, reason: reason ? taskScriptOmissionDescription({ tool: step.tool, reason }) : '', ...(reason ? { reasonCode: reason } : {}) })
    const scan = scanCommand(step.command)
    if (step.status !== 'completed' || step.executionPhase !== 'finished') reason = 'not-completed'
    else if (['read_file', 'apply_patch', 'write_file', 'delete_file', 'restore_file'].includes(step.tool)) {
      if (!step.environment?.user || !step.environment.environmentScope || !step.environment.routeKey || !step.directory?.startsWith('/')) reason = 'missing-environment'
      else if (!step.fileChanges?.length || step.fileChanges.length !== step.fileChangeCount) reason = 'missing-file-evidence'
      else if (step.fileChanges.some(file => !validFileChange(file))) reason = 'unsupported-file'
      else if (!['bash', 'sh', 'posix', 'zsh'].includes(step.environment.shell)) reason = 'unsupported-shell'
      return candidate()
    }
    else if (step.tool !== 'run_command') reason = 'unsupported-tool'
    else if (step.exitCode !== 0) reason = 'unknown-exit'
    else if (!step.directory?.startsWith('/') || !step.environment?.user || !step.environment.environmentScope || !step.environment.routeKey) reason = 'missing-environment'
    else if (validCommandSource(step)) return candidate()
    else if (step.sensitive || isSensitiveCommand(step.command) || isSensitiveCommand(scan.segments.map(words => words.join(' ')).join('\n'))) reason = 'sensitive-source'
    else if (!step.command.trim() || step.command.length > 65536 || step.command.includes(parameterPrefix)) reason = 'invalid-source'
    else if (!['bash', 'sh', 'posix', 'zsh'].includes(step.environment.shell)) reason = 'unsupported-shell'
    else if (scan.issues.length || scan.ambiguousSyntaxVeto || scan.substitutionVeto || scan.heredoc || scan.unclosedQuote || scan.trailingOperator || /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(step.command)) reason = 'unsupported-command'
    else if (scan.details.some(segment => segment.words.some(word => /[$`*?\[\]{}~]/.test(word.raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) || !segment.words.length || contextCommands.has(segment.words[0].value) || step.environment?.shell === 'zsh' && changesZshSession(segment.words))) reason = 'session-state'
    return candidate()
  })
}

function validCommandSource(step: TaskScriptStep) {
  const source = step.commandSource
  return Boolean(source && source.version === 1 && ['bash', 'posix'].includes(source.shell) && source.shell === step.environment?.shell &&
    typeof source.source === 'string' && source.source.trim() && new TextEncoder().encode(source.source).length <= 65536 &&
    !source.source.includes(parameterPrefix) && !source.source.includes('_ai_term_') &&
    Array.isArray(source.secrets) && source.secrets.length <= 32 && (!step.sensitive || source.secrets.length) &&
    source.secrets.every((secret, index) => secret.variable === `AI_TERM_EXPORT_SECRET_${index + 1}` && typeof secret.label === 'string' && secret.label.length <= 128 && source.source.includes(`\${${secret.variable}:?请提供外部凭据}`)))
}

function needsCommandSource(step: TaskScriptStep) {
  // Retain directory/service parameter extraction for the existing simple case.
  return validCommandSource(step) && (Boolean(step.commandSource!.secrets.length) || !taskScriptCandidates({ runId: '', messageId: '', workspaceSessionId: '', checks: [], steps: [{ ...step, commandSource: undefined }] })[0].eligible)
}

function validFileChange(file: TaskScriptFileChange) {
  const text = (value: string | null) => typeof value === 'string' && !value.includes('\0') && !value.includes(parameterPrefix) && new TextEncoder().encode(value).length <= 65536
  return Boolean(file.id) && file.path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(file.path) &&
    ['create', 'replace', 'delete', 'verify'].includes(file.action) && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 4095 &&
    (file.externalContent || (file.action === 'create' || text(file.before)) && (['delete', 'verify'].includes(file.action) || text(file.after)))
}

export function createTaskScriptDraft(source: TaskScriptSource, selectedIds: string[]): TaskScriptDraft {
  if (!selectedIds.length || selectedIds.length > 64 || new Set(selectedIds).size !== selectedIds.length) throw Error('请选择 1—64 个不同的成功步骤')
  const candidates = taskScriptCandidates(source)
  const selected = candidates.filter(item => selectedIds.includes(item.step.id))
  if (selected.length !== selectedIds.length || selected.some(item => !item.eligible)) throw Error('选择包含不可转换的步骤，请重新核对')
  const environment = selected[0].step.environment!
  if (selected.some(item => taskScriptEnvironmentKey(item.step.environment!) !== taskScriptEnvironmentKey(environment))) throw Error('跨主机、账号或容器的步骤不能合并，请先选择一个目标范围')
  const omittedSteps: TaskScriptOmission[] = candidates.filter(item => !selectedIds.includes(item.step.id)).map(({ step, reasonCode }) => ({
    stepId: step.id, tool: step.tool, status: step.status,
    reason: reasonCode ?? (step.environment && taskScriptEnvironmentKey(step.environment) !== taskScriptEnvironmentKey(environment) ? 'different-environment' : 'not-selected')
  }))
  const omittedChecks: TaskScriptOmittedCheck[] = source.checks.filter(check => !check.stepId || !selectedIds.includes(check.stepId))
    .map(({ id, stepId, required, status }) => ({ id, stepId, required, status }))
  if (source.checks.length > 12) throw Error('任务验证超过 12 项，不能省略验证来源')
  if (source.steps.length > 1000 || new Set(source.steps.map(step => step.id)).size !== source.steps.length) throw Error('任务来源超过 1000 步或步骤标识重复，不能生成不完整来源记录')
  const parameters: ScriptParameter[] = []
  function parameter(type: 'directory' | 'service', value: string) {
    const prior = parameters.find(item => item.type === type && item.defaultValue === value)
    if (prior) return parameterToken(prior.name)
    if (parameters.length >= 32) throw Error('参数过多，请缩小所选步骤范围')
    const name = `${type === 'directory' ? 'WORKDIR' : 'SERVICE'}_${parameters.filter(item => item.type === type).length + 1}`
    parameters.push({ name, label: type === 'directory' ? '工作目录' : '服务名', type, defaultValue: value, required: true })
    return parameterToken(name)
  }
  function fileParameter(name: string, label: string, type: 'text' | 'secret', defaultValue: string | null) {
    if (parameters.length >= 32) throw Error('参数过多，请缩小所选步骤范围')
    parameters.push({ name, label, type, defaultValue, required: true })
    return parameterToken(name)
  }
  const hasFiles = selected.some(item => item.step.fileChanges?.length)
  const prerequisites = [
    '需要 Bash 和原步骤使用的程序、权限与文件；所选步骤按顺序共享脚本变量和函数，原终端中未被选入的状态需要另行准备。',
    '重复执行可能再次修改文件、重启服务或重复部署；运行前检查当前状态和备份。',
    ...(omittedSteps.length ? [`此草稿只含选中的成功步骤；另有 ${omittedSteps.length} 项未选择或需单独整理，不会执行。逐项来源和原因保留在脚本来源面板，请先核对依赖。`] : []),
    ...(omittedChecks.length ? [`另有 ${omittedChecks.length} 项验证未纳入（必要项 ${omittedChecks.filter(check => check.required).length} 项）；请在脚本来源面板核对原证据，运行后补齐所需检查。`] : []),
    ...(selected.some(item => needsCommandSource(item.step)) ? ['复杂 Bash 源码在同一个脚本进程中逐步执行；步骤内部的路径、变量展开和依赖需核对，参数填写后重新审查完整脚本。'] : []),
    ...(selected.some(item => item.step.tool === 'run_command' && item.step.environment?.shell === 'zsh') ? ['静态 Zsh 命令在各自的 Zsh 子进程中运行，目标环境需要安装 Zsh；参数按位置传入。原终端别名、Shell 选项及未保存的函数需要另外整理。'] : []),
    ...(selected.some(item => item.step.commandSource?.secrets.length) ? ['命令凭据通过 AI_TERM_SECRET_COMMAND_* 目标环境变量提供；认证头或地址输入需要包含完整前缀。历史凭据和批准不会带入草稿。'] : []),
    ...(hasFiles ? ['文件步骤需要 POSIX Python 3：写入前逐字比较基线，不匹配则停止；已匹配目标内容时跳过写入。', '文本替换采用原位写入以保留现有文件权限和扩展属性，不保证原子性；多文件按原顺序执行，失败后保留已发生的修改。', '创建文件使用原记录的权限和当前账号；脚本不重放原任务的属主、ACL 或扩展属性恢复。敏感内容通过目标环境变量指定的 UTF-8 文件提供，不写入草稿。'] : [])
  ]
  const selectedIdSet = new Set(selectedIds)
  const externalSteps = new Set(selected.filter(item => item.step.fileChanges?.some(file => file.externalContent) || item.step.commandSource?.secrets.length).map(item => item.step.id))
  const checks = source.checks.filter(check => check.stepId && selectedIdSet.has(check.stepId)).slice(0, 12)
    .map(check => externalSteps.has(check.stepId!) ? { ...check, purpose: '核对外部输入及执行结果', expected: '[预期使用外部输入，未复制]', status: 'unavailable' } : check)
  const lines = ['#!/usr/bin/env bash', '# 从任务成功步骤整理的草稿；参数填写后仍需重新审查实际脚本。', ...prerequisites.map(value => `# ${safeLine(value)}`)]
  if (hasFiles) lines.push('', '# 文件辅助程序：只接受指定路径和精确基线，失败不会自动重试。', `_ai_term_file_change() { python3 -c ${quote(TASK_SCRIPT_FILE_PROGRAM)} "$@"; }`)
  let fileIndex = 0
  for (const [stepIndex, { step }] of selected.entries()) {
    if (step.fileChanges?.length) {
      lines.push('', `# 来源步骤 ${safeLine(step.id)}`)
      for (const file of step.fileChanges) {
        const index = ++fileIndex
        const priorPath = parameters.find(parameter => parameter.type === 'text' && parameter.label === '文件路径' && parameter.defaultValue === file.path)
        const path = priorPath ? parameterToken(priorPath.name) : fileParameter(`FILE_${index}`, '文件路径', 'text', file.path)
        const before = file.action === 'create' ? "''" : file.externalContent ? fileParameter(`FILE_BEFORE_${index}`, '基线内容文件的绝对路径', 'secret', null) : quote(JSON.stringify(file.before))
        const after = ['delete', 'verify'].includes(file.action) ? "''" : file.externalContent ? fileParameter(`FILE_AFTER_${index}`, '目标内容文件的绝对路径', 'secret', null) : quote(JSON.stringify(file.after))
        lines.push(`# 文件${file.action === 'verify' ? '核验' : '变更'} ${safeLine(file.id)} · ${safeLine(file.path)} · ${file.action}${file.externalContent ? ' · 内容使用外部输入' : ''}`,
          `_ai_term_file_change ${file.action} ${path} ${file.externalContent ? 'file' : 'json'} ${before} ${after} ${file.mode} || exit $?`)
      }
      for (const check of checks.filter(check => check.stepId === step.id)) lines.push(`# 需重新核验：${safeLine(check.purpose)}；${safeLine(check.kind)} 预期 ${safeLine(check.expected)}（历史 ${safeLine(check.status)} 不是本次结果）`)
      continue
    }
    let command = step.command
    if (needsCommandSource(step)) {
      command = step.commandSource!.source
      for (const [index, secret] of step.commandSource!.secrets.entries()) {
        const name = `COMMAND_${stepIndex + 1}_${index + 1}`
        fileParameter(name, secret.label, 'secret', null)
        command = command.split(`\${${secret.variable}:?请提供外部凭据}`).join(`\${AI_TERM_SECRET_${name}:?请提供外部凭据}`)
      }
      // One statically quoted program preserves heredocs, functions and shell
      // state. Parameter values never become eval source text.
      command = `builtin eval ${quote(command)}`
    }
    const replacements: Array<{ start: number; length: number; value: string }> = []
    const zshArguments: string[] = []
    const commandParameter = (type: 'directory' | 'service', value: string) => {
      const token = parameter(type, value)
      if (step.environment?.shell !== 'zsh') return token
      zshArguments.push(token)
      return `"\${${zshArguments.length}}"`
    }
    for (const segment of scanCommand(command).details) {
      const words = segment.words
      // Only a static service argument in a recognized position is generalized.
      const directoryAt = words[0]?.value === 'cd' ? words[1]?.value === '--' ? 2 : 1 : -1
      if (directoryAt >= 0 && words[directoryAt]?.value.startsWith('/')) {
        const word = words[directoryAt]
        replacements.push({ start: word.start, length: word.raw.length, value: commandParameter('directory', word.value) })
      }
      const at = words[0]?.value === 'systemctl' && ['start', 'stop', 'restart', 'reload', 'status', 'is-active'].includes(words[1]?.value) ? 2
        : words[0]?.value === 'service' ? 1 : -1
      if (at >= 0 && words[at] && /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(words[at].value)) {
        replacements.push({ start: words[at].start, length: words[at].raw.length, value: commandParameter('service', words[at].value) })
      }
    }
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) command = command.slice(0, replacement.start) + replacement.value + command.slice(replacement.start + replacement.length)
    if (step.environment?.shell === 'zsh') command = ['zsh', '-f', '-c', quote(command), 'ai-term-task-step', ...zshArguments].join(' ')
    lines.push('', `# 来源步骤 ${safeLine(step.id)}`, `cd -- ${parameter('directory', step.directory!)} || exit 1`, command,
      '_ai_term_step_status=$?', 'if [ "$_ai_term_step_status" -ne 0 ]; then exit "$_ai_term_step_status"; fi')
    for (const check of checks.filter(check => check.stepId === step.id)) lines.push(`# 需重新核验：${safeLine(check.purpose)}；${safeLine(check.kind)} 预期 ${safeLine(check.expected)}（历史 ${safeLine(check.status)} 不是本次结果）`)
  }
  const content = `${lines.join('\n')}\n`
  if (new TextEncoder().encode(content).length > 65536) throw Error('生成脚本超过 64 KiB，请减少所选步骤')
  const metadata: TaskScriptMetadata = { version: 1, revision: 1,
    source: { runId: source.runId, messageId: source.messageId, workspaceSessionId: source.workspaceSessionId, stepIds: selected.map(item => item.step.id) },
    environment: { ...environment }, parameters, checks: JSON.parse(JSON.stringify(checks)), prerequisites, omittedSteps, omittedChecks
  }
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > taskMetadataMaxBytes) throw Error('脚本来源元数据超过 512 KiB，不能生成缺少待整理项的来源记录')
  return { content, sourceCommands: selected.map(item => item.step.fileChanges?.length ? item.step.fileChanges.map(file => `${file.action} ${file.path}`).join('\n') : needsCommandSource(item.step) ? item.step.commandSource!.source : item.step.command), metadata }
}

/** Replace whole unquoted argument tokens only. Never evaluate a template, use
 * shell interpolation, or splice a value into an existing quoted string. */
export function renderTaskScript(content: string, metadata: TaskScriptMetadata, values: Record<string, string> = {}) {
  if (metadata.version !== 1 || metadata.parameters.length > 32) throw Error('不支持的脚本参数格式')
  const names = new Set<string>()
  const scan = scanCommand(content)
  if (scan.budgetExceeded || scan.heredoc || scan.substitutionVeto || scan.unclosedQuote) throw Error('参数模板包含不能安全替换的 Shell 结构，请先拆分或改写')
  const words = scan.details.flatMap(segment => segment.words.map((word, index) => ({ ...word, index })))
  const replacements: Array<{ start: number; length: number; value: string }> = []
  for (const parameter of metadata.parameters) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(parameter.name) || names.has(parameter.name)) throw Error('参数名称无效或重复')
    names.add(parameter.name)
    if (parameter.type === 'secret' && values[parameter.name]) throw Error('凭据须通过目标环境变量提供，不能嵌入脚本正文')
    const token = parameterToken(parameter.name)
    const occurrences = words.filter(word => word.raw.includes(token))
    if (occurrences.some(word => word.raw !== token || word.index === 0)) throw Error('参数标识必须独立占据一个未引用的命令参数，不能作为命令名')
    if (!occurrences.length) continue
    if (parameter.type === 'secret') {
      for (const word of occurrences) replacements.push({ start: word.start, length: word.raw.length, value: `"\${AI_TERM_SECRET_${parameter.name}:?请在目标环境提供 AI_TERM_SECRET_${parameter.name}}"` })
      continue
    }
    const value = values[parameter.name] ?? parameter.defaultValue ?? ''
    if (parameter.required && !value || value.includes('\0') || value.length > 4096) throw Error(`请填写有效参数：${parameter.label}`)
    if (parameter.type === 'directory' && (!value.startsWith('/') || /[\r\n]/.test(value))) throw Error('目录参数需要绝对路径')
    if (parameter.type === 'service' && !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(value)) throw Error('服务参数只能包含名称字符，不能作为选项或命令')
    for (const word of occurrences) replacements.push({ start: word.start, length: word.raw.length, value: quote(value) })
  }
  let rendered = content.replace(/\r\n?/g, '\n')
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) rendered = rendered.slice(0, replacement.start) + replacement.value + rendered.slice(replacement.start + replacement.length)
  if (rendered.includes(parameterPrefix)) throw Error('还有未知或不能安全替换的参数标识，请检查脚本')
  if (new TextEncoder().encode(rendered).length > 65536) throw Error('填写参数后的脚本超过 64 KiB')
  return rendered
}

export function persistTaskScriptMetadata(value: TaskScriptMetadata | undefined): TaskScriptMetadata | undefined {
  if (!value) return undefined
  const result: TaskScriptMetadata = JSON.parse(JSON.stringify(value))
  result.parameters = result.parameters.map(parameter => parameter.type === 'secret' ? { ...parameter, defaultValue: null } : parameter)
  if (result.omittedSteps) result.omittedSteps = result.omittedSteps.map(({ stepId, tool, status, reason }) => ({ stepId, tool, status, reason }))
  if (result.omittedChecks) result.omittedChecks = result.omittedChecks.map(({ id, stepId, required, status }) => ({ id, stepId, required, status }))
  return result
}
