import { computed, onBeforeUnmount, ref, watch } from 'vue'

export interface BrowserEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: string
  permissions?: string
}
export interface BrowserSnapshot {
  path: string
  draft: string
  entries: BrowserEntry[]
  history: string[]
  historyIndex: number
  selected: string[]
  focused: string
  scroll: number
  search: string
  updatedAt: number
  sort: 'name' | 'size' | 'modified'
  descending: boolean
}
export const DIRECTORY_CACHE_TTL = 30_000

export function useDirectoryBrowser(options: {
  contextKey: () => string
  read: (path: string) => Promise<{ path: string; entries: BrowserEntry[] }>
  enabled?: () => boolean
  onVisited?: (path: string) => void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const path = ref(''),
    draft = ref(''),
    entries = ref<BrowserEntry[]>([])
  const history = ref<string[]>([]),
    historyIndex = ref(-1)
  const selected = ref<string[]>([]),
    focused = ref(''),
    anchor = ref('')
  const scroll = ref(0),
    search = ref(''),
    showHidden = ref(true)
  const loading = ref(false),
    refreshing = ref(false),
    error = ref(''),
    updatedAt = ref(0)
  const sort = ref<'name' | 'size' | 'modified'>('name'),
    descending = ref(false)
  let request = 0
  const cache = new Map<string, { path: string; entries: BrowserEntry[]; at: number }>()
  const inFlight = new Map<string, { version: number; promise: Promise<boolean> }>()

  const visibleEntries = computed(() =>
    entries.value
      .filter(
        (entry) =>
          (showHidden.value || !entry.name.startsWith('.')) &&
          entry.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
      )
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        const comparison =
          sort.value === 'size'
            ? a.size - b.size
            : sort.value === 'modified'
              ? Number(a.modified) - Number(b.modified)
              : a.name.localeCompare(b.name, undefined, { numeric: true })
        return (comparison || a.name.localeCompare(b.name)) * (descending.value ? -1 : 1)
      }),
  )
  const selectedEntries = computed(() => entries.value.filter((entry) => selected.value.includes(entry.path)))
  const canBack = computed(() => historyIndex.value > 0)
  const canForward = computed(() => historyIndex.value < history.value.length - 1)

  function apply(
    response: { path: string; entries: BrowserEntry[] },
    recordHistory: boolean,
    preserve: boolean,
    at: number,
  ) {
    const samePath = path.value === response.path
    path.value = response.path
    if (!preserve || !samePath) draft.value = response.path
    entries.value = response.entries.map((entry) => ({ ...entry }))
    updatedAt.value = at
    const available = new Set(entries.value.map((entry) => entry.path))
    selected.value = preserve && samePath ? selected.value.filter((value) => available.has(value)) : []
    if (!preserve || !samePath) {
      scroll.value = 0
      focused.value = ''
      anchor.value = ''
      search.value = ''
    }
    if (focused.value && !available.has(focused.value)) focused.value = ''
    if (recordHistory && history.value[historyIndex.value] !== response.path) {
      history.value = [...history.value.slice(0, historyIndex.value + 1), response.path].slice(-50)
      historyIndex.value = history.value.length - 1
    }
    options.onVisited?.(response.path)
  }

  async function load(
    destination = path.value || '.',
    settings: { force?: boolean; recordHistory?: boolean; preserve?: boolean; background?: boolean } = {},
  ): Promise<boolean> {
    if (options.enabled && !options.enabled()) return false
    const owner = options.contextKey(),
      key = `${owner}\u0000${destination}`
    const pending = inFlight.get(key)
    if (!settings.force && pending?.version === request) return pending.promise
    const version = ++request
    const old = cache.get(key)
    const preserve = settings.preserve ?? destination === path.value
    if (old && !settings.force) {
      apply(old, settings.recordHistory !== false, preserve, old.at)
      if (now() - old.at < DIRECTORY_CACHE_TTL) {
        loading.value = false
        refreshing.value = false
        error.value = ''
        return true
      }
    }
    loading.value = !(settings.background || (old && !settings.force))
    refreshing.value = !loading.value
    error.value = ''
    let operation!: Promise<boolean>
    operation = (async () => {
      try {
        const response = await options.read(destination)
        if (version !== request || owner !== options.contextKey() || (options.enabled && !options.enabled()))
          return false
        const record = { ...response, entries: response.entries.map((entry) => ({ ...entry })), at: now() }
        cache.set(key, record)
        cache.set(`${owner}\u0000${response.path}`, record)
        while (cache.size > 100) cache.delete(cache.keys().next().value!)
        apply(response, settings.recordHistory !== false, preserve, record.at)
        return true
      } catch (reason) {
        if (version === request && owner === options.contextKey())
          error.value = reason instanceof Error ? reason.message : String(reason)
        return false
      } finally {
        if (version === request) {
          loading.value = false
          refreshing.value = false
        }
      }
    })()
    inFlight.set(key, { version, promise: operation })
    void operation.then(() => {
      if (inFlight.get(key)?.promise === operation) inFlight.delete(key)
    })
    return operation
  }

  async function goHistory(delta: number) {
    const index = historyIndex.value + delta
    if (index < 0 || index >= history.value.length) return
    const owner = options.contextKey()
    const operation = load(history.value[index], { recordHistory: false, preserve: false })
    const version = request
    if (await operation && version === request && owner === options.contextKey())
      historyIndex.value = index
  }

  function select(
    entry: BrowserEntry,
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
  ) {
    const list = visibleEntries.value
    if (modifiers.shiftKey && anchor.value) {
      const a = list.findIndex((item) => item.path === anchor.value),
        b = list.findIndex((item) => item.path === entry.path)
      if (a >= 0 && b >= 0)
        selected.value = list.slice(Math.min(a, b), Math.max(a, b) + 1).map((item) => item.path)
      else {
        selected.value = [entry.path]
        anchor.value = entry.path
      }
    } else if (modifiers.ctrlKey || modifiers.metaKey) {
      selected.value = selected.value.includes(entry.path)
        ? selected.value.filter((value) => value !== entry.path)
        : [...selected.value, entry.path]
      anchor.value = entry.path
    } else {
      selected.value = [entry.path]
      anchor.value = entry.path
    }
    focused.value = entry.path
  }

  function snapshot(): BrowserSnapshot {
    return {
      path: path.value,
      draft: draft.value,
      entries: entries.value.map((entry) => ({ ...entry })),
      history: [...history.value],
      historyIndex: historyIndex.value,
      selected: [...selected.value],
      focused: focused.value,
      scroll: scroll.value,
      search: search.value,
      updatedAt: updatedAt.value,
      sort: sort.value,
      descending: descending.value,
    }
  }

  function restore(value?: BrowserSnapshot) {
    request++
    inFlight.clear()
    loading.value = false
    refreshing.value = false
    error.value = ''
    path.value = value?.path ?? ''
    draft.value = value?.draft ?? ''
    entries.value = value?.entries.map((entry) => ({ ...entry })) ?? []
    history.value = value ? [...value.history] : []
    historyIndex.value = value?.historyIndex ?? -1
    selected.value = value ? [...value.selected] : []
    focused.value = value?.focused ?? ''
    anchor.value = focused.value
    scroll.value = value?.scroll ?? 0
    search.value = value?.search ?? ''
    updatedAt.value = value?.updatedAt ?? 0
    sort.value = value?.sort ?? 'name'
    descending.value = value?.descending ?? false
  }

  function invalidate(destination = path.value) {
    const owner = `${options.contextKey()}\u0000`
    for (const [key, record] of cache) {
      if (key.startsWith(owner) && (key === `${owner}${destination}` || record.path === destination))
        cache.delete(key)
    }
    if (inFlight.get(`${owner}${destination}`)?.version === request) {
      request++
      loading.value = false
      refreshing.value = false
    }
    if (destination === path.value) updatedAt.value = 0
  }
  function refreshIfStale() {
    if (!path.value || now() - updatedAt.value < DIRECTORY_CACHE_TTL) return Promise.resolve(true)
    return load(path.value, { force: true, recordHistory: false, preserve: true, background: true })
  }

  async function suggestions(input: string) {
    const split = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
    const directory = split >= 0 ? input.slice(0, split + 1) : path.value
    if (!directory || (options.enabled && !options.enabled())) return []
    const owner = options.contextKey()
    try {
      const result = await options.read(directory)
      return owner === options.contextKey() ? result.entries.filter(entry => entry.isDir).map(entry => entry.path) : []
    } catch {
      return []
    }
  }

  watch([search, showHidden], () => {
    const shown = new Set(visibleEntries.value.map((entry) => entry.path))
    selected.value = selected.value.filter((value) => shown.has(value))
    if (!shown.has(focused.value)) focused.value = ''
  }, { flush: 'sync' })

  onBeforeUnmount(() => {
    request++
    inFlight.clear()
  })

  return {
    path,
    draft,
    entries,
    history,
    historyIndex,
    selected,
    focused,
    scroll,
    search,
    showHidden,
    sort,
    descending,
    loading,
    refreshing,
    error,
    updatedAt,
    visibleEntries,
    selectedEntries,
    canBack,
    canForward,
    load,
    goHistory,
    select,
    snapshot,
    restore,
    invalidate,
    refreshIfStale,
    suggestions,
  }
}
