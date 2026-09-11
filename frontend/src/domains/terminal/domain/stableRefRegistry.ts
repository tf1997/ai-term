export function createStableRefRegistry<T>() {
  const values: Record<string, T | null> = {}
  const setters = new Map<string, (value: unknown) => void>()

  function refFor(key: string) {
    const existing = setters.get(key)
    if (existing) return existing
    const setter = (value: unknown) => {
      if (value === null) delete values[key]
      else values[key] = value as T
    }
    setters.set(key, setter)
    return setter
  }

  function remove(key: string) {
    delete values[key]
    setters.delete(key)
  }

  return { values, refFor, remove }
}
