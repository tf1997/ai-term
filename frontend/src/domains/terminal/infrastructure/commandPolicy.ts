import { invoke } from '@tauri-apps/api/tauri'
import type { CommandIntent, CommandIntentReference, ExecutionContext, ExecutionTarget, TerminalProbe } from '../../../shared/security/commandPolicy'

export function commandExecutionTarget(sessionId: string) {
  return invoke<ExecutionTarget>('command_execution_target', { sessionId })
}

export function updateCommandContext(expected: ExecutionTarget, context: ExecutionContext) {
  return invoke<ExecutionTarget>('update_command_context', { expected, context })
}

export function analyzeCommandIntent(expected: ExecutionTarget, source: string, operation: CommandIntent['operation'], capture: CommandIntent['capture']['kind'] = 'none') {
  return invoke<CommandIntent>('analyze_command_intent', { expected, source, operation, capture })
}

export function prepareTerminalProbe(expected: ExecutionTarget, probe: TerminalProbe) {
  return invoke<CommandIntent>('prepare_terminal_probe', { expected, probe })
}

export function approveCommandIntent(reference: CommandIntentReference, reviewedSource: string) {
  return invoke<void>('approve_command_intent', { reference, reviewedSource })
}

export function dispatchCommandIntent(reference: CommandIntentReference) {
  return invoke<void>('dispatch_command_intent', { reference })
}

export function cancelCommandIntent(reference: CommandIntentReference) {
  return invoke<boolean>('cancel_command_intent', { reference })
}
