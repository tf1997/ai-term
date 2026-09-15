import { ref } from 'vue'

const STORAGE_KEY = 'ai-term:file-locations:v1'
type Side = 'local' | 'remote'
export interface PathPair {
  id: string
  name: string
  local: string
  remote: string
}
export interface ServerLocations {
  local: string
  remote: string
  localRecent: string[]
  remoteRecent: string[]
  localBookmarks: string[]
  remoteBookmarks: string[]
  pairs: PathPair[]
  preferredHost: string
  updatedAt: number
}
interface LocationPreferences {
  servers: Record<string, ServerLocations>
  density: 'compact' | 'comfortable'
  split: number
  showHidden: boolean
}
const emptyLocations = (): ServerLocations => ({
  local: '',
  remote: '',
  localRecent: [],
  remoteRecent: [],
  localBookmarks: [],
  remoteBookmarks: [],
  pairs: [],
  preferredHost: '',
  updatedAt: 0,
})
const validPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const paths = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(validPath))].slice(0, 20) : []

export function createFileLocations(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const preferences = ref<LocationPreferences>({
    servers: {},
    density: 'compact',
    split: 50,
    showHidden: true,
  })
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null')
    if (value?.version === 1 && value.servers && typeof value.servers === 'object') {
      for (const [key, record] of Object.entries(value.servers).slice(-100)) {
        if (key.length > 4096 || !record || typeof record !== 'object') continue
        const item = record as Partial<ServerLocations>
        preferences.value.servers[key] = {
          local: validPath(item.local) ? item.local : '',
          remote: validPath(item.remote) ? item.remote : '',
          localRecent: paths(item.localRecent),
          remoteRecent: paths(item.remoteRecent),
          localBookmarks: paths(item.localBookmarks),
          remoteBookmarks: paths(item.remoteBookmarks),
          pairs: Array.isArray(item.pairs)
            ? item.pairs
                .filter(
                  (pair) =>
                    pair &&
                    typeof pair.id === 'string' &&
                    typeof pair.name === 'string' &&
                    pair.name.trim() &&
                    validPath(pair.local) &&
                    validPath(pair.remote),
                )
                .slice(0, 20)
                .map((pair) => ({ ...pair, name: pair.name.slice(0, 80) }))
            : [],
          preferredHost: typeof item.preferredHost === 'string' ? item.preferredHost.slice(0, 255) : '',
          updatedAt: Number(item.updatedAt) || 0,
        }
      }
      preferences.value.density = value.density === 'comfortable' ? 'comfortable' : 'compact'
      preferences.value.split = Math.min(65, Math.max(35, Number(value.split) || 50))
      preferences.value.showHidden = value.showHidden !== false
    }
  } catch {
    /* Corrupt or unavailable storage never prevents browsing. */
  }

  function persist() {
    const records = Object.entries(preferences.value.servers)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 100)
    preferences.value.servers = Object.fromEntries(records)
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...preferences.value }))
    } catch {
      /* Keep this session usable when storage is full or disabled. */
    }
  }
  function get(key: string): ServerLocations {
    return preferences.value.servers[key] ?? emptyLocations()
  }
  function update(key: string, change: (record: ServerLocations) => void) {
    if (!key) return
    const record = { ...get(key) }
    change(record)
    record.updatedAt = Date.now()
    preferences.value.servers[key] = record
    persist()
  }
  function remember(key: string, side: Side, path: string) {
    if (!validPath(path)) return
    update(key, (record) => {
      record[side] = path
      const field = side === 'local' ? 'localRecent' : 'remoteRecent'
      record[field] = [path, ...record[field].filter((item) => item !== path)].slice(0, 20)
    })
  }
  function toggleBookmark(key: string, side: Side, path: string) {
    if (!validPath(path)) return
    update(key, (record) => {
      const field = side === 'local' ? 'localBookmarks' : 'remoteBookmarks'
      record[field] = record[field].includes(path)
        ? record[field].filter((item) => item !== path)
        : [path, ...record[field]].slice(0, 20)
    })
  }
  function savePair(key: string, name: string, local: string, remote: string) {
    if (!name.trim() || !validPath(local) || !validPath(remote)) return
    update(key, (record) => {
      const existing = record.pairs.find((pair) => pair.name === name.trim())
      record.pairs = [
        {
          id: existing?.id ?? `pair-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: name.trim().slice(0, 80),
          local,
          remote,
        },
        ...record.pairs.filter((pair) => pair.id !== existing?.id),
      ].slice(0, 20)
    })
  }
  function deletePair(key: string, id: string) {
    update(key, (record) => {
      record.pairs = record.pairs.filter((pair) => pair.id !== id)
    })
  }
  function rememberHost(key: string, host: string) {
    update(key, (record) => {
      record.preferredHost = host
    })
  }
  return { preferences, get, remember, toggleBookmark, savePair, deletePair, rememberHost, persist }
}

let shared: ReturnType<typeof createFileLocations> | undefined
export function useFileLocations() {
  if (!shared) {
    let storage: Storage | undefined
    try {
      storage = globalThis.localStorage
    } catch {}
    shared = createFileLocations(storage)
  }
  return shared
}
