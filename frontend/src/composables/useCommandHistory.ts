import { ref } from 'vue'
import type { CommandHistoryEntry, CommandRecordedEvent } from '../types/workspace'
import { listCommandHistory, saveCommandHistoryRecord } from '../lib/tauri'
import { isSensitiveCommand } from '../lib/commandPrivacy'
import { COMMAND_HISTORY_CACHE_LIMIT, COMMAND_HISTORY_SESSION_ID, nowText } from '../lib/workspaceSessions'

const defaultStorage = { listCommandHistory, saveCommandHistoryRecord }

export function useCommandHistory(storage = defaultStorage) {
  const { listCommandHistory, saveCommandHistoryRecord } = storage
  const commandHistoryByConnection = ref<Record<string, CommandHistoryEntry[]>>({})
  const loadedConnections = new Set<string>()
  const loadingConnections = new Map<string, Promise<void>>()
  let commandSequence = 0

  function commandHistoryForConnection(connectionId: string) {
    return commandHistoryByConnection.value[connectionId] ?? []
  }

  function loadCommandHistoryForConnection(connectionId: string): Promise<void> {
    const pending = loadingConnections.get(connectionId)
    if (pending) return pending
    if (loadedConnections.has(connectionId)) return Promise.resolve()
    const task = (async () => {
      try {
        const commands = await listCommandHistory(connectionId)
        const localCommands = commandHistoryForConnection(connectionId)
        const persistedIds = new Set(commands.map((entry) => entry.id))
        commandHistoryByConnection.value = {
          ...commandHistoryByConnection.value,
          [connectionId]: [...commands, ...localCommands.filter((entry) => !persistedIds.has(entry.id))].slice(-COMMAND_HISTORY_CACHE_LIMIT)
        }
        loadedConnections.add(connectionId)
      } catch (error) {
        console.error('failed to load connection command history', error)
      }
    })()
    loadingConnections.set(connectionId, task)
    void task.finally(() => {
      if (loadingConnections.get(connectionId) === task) loadingConnections.delete(connectionId)
    })
    return task
  }

  function recordCommandForConnection(connectionId: string, event: CommandRecordedEvent) {
    if (isSensitiveCommand(event.command)) return
    const entry: CommandHistoryEntry = {
      id: `${connectionId}-${event.terminalId}-${Date.now()}-${++commandSequence}`,
      connectionId,
      workspaceSessionId: COMMAND_HISTORY_SESSION_ID,
      terminalId: event.terminalId,
      command: event.command,
      createdAt: nowText(),
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode })
    }
    commandHistoryByConnection.value = {
      ...commandHistoryByConnection.value,
      [connectionId]: [...commandHistoryForConnection(connectionId), entry].slice(-COMMAND_HISTORY_CACHE_LIMIT)
    }
    void saveCommandHistoryRecord(entry).catch((error) => console.error('failed to save command history', error))
    return entry
  }

  return {
    commandHistoryForConnection, loadCommandHistoryForConnection, recordCommandForConnection
  }
}
