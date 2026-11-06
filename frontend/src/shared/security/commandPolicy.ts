/** Rust command_policy IPC contract. Offsets are UTF-8 bytes; columns are UTF-16. */
export type PolicyShell = 'bash' | 'posix' | 'zsh' | 'powershell' | 'cmd' | 'unknown'
export interface ExecutionContext {
  shell: PolicyShell
  workingDirectory: string | null
  user: string | null
  environmentScope: string | null
}
export interface ExecutionTarget {
  sessionId: string
  sessionInstance: string
  profileId: string
  routeVersion: number
  contextVersion: number
  context: ExecutionContext
}
export interface PolicySourceRange {
  startByte: number
  endByte: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}
export interface CommandPolicyAnalysis {
  analysisStatus: 'complete' | 'unknown'
  decision: 'allow' | 'ask' | 'deny'
  risks: Array<{
    ruleId: string
    kind: 'delete' | 'edit' | 'reboot' | 'upgrade' | 'service' | 'network' | 'permission' | 'disk' | 'execution'
    severity: 'medium' | 'high'
    message: string
    range: PolicySourceRange
    targets: string[]
  }>
  unknownReasons: Array<{ code: string; message: string; range: PolicySourceRange }>
  highestSeverity: 'medium' | 'high' | null
  policyVersion: string
}
export interface CommandIntentReference {
  id: string
  operation: 'command' | 'bash-script'
  target: ExecutionTarget
  policyVersion: string
}
export interface CommandIntent {
  reference: CommandIntentReference
  source: string
  sourceSensitive?: boolean
  operation: 'command' | 'bash-script'
  analysis: CommandPolicyAnalysis
  expiresInMs: number
  capture: { kind: 'none' | 'markers' | 'bracketed' | 'sentinel'; nonce: string; internal: boolean }
  terminalInput: string
}

/** Backend-owned draft material; carries no execution authority. */
export interface CommandScriptSource {
  version: 1
  shell: 'bash' | 'posix'
  source: string
  secrets: Array<{ variable: string; label: string }>
}

export type TerminalProbe = { kind: 'capture' } | { kind: 'bracketed-capture' } | { kind: 'context' } | { kind: 'shell-integration' } | { kind: 'file-snapshot'; paths: string[]; nonce: string }
export interface AgentCommandPolicy {
  target?(terminalId: string, generation: number): Promise<ExecutionTarget>
  prepare(terminalId: string, generation: number, source: string): Promise<CommandIntent>
  approve(intent: CommandIntent): Promise<void>
  cancel(intent: CommandIntent): Promise<unknown>
}
export type ApplicationCommandExecutor = (source: string, operation: CommandIntent['operation'], sourceConnectionId?: string) => Promise<boolean>
