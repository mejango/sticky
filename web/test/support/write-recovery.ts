/** Browser persistence and cross-tab exclusion for actual reviewed-write tests. */
export function browserWriteRecoveryModel() {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
    clear: () => values.clear(),
  }
  const held = new Map<string, Promise<void>>()
  const locks = {
    async request<T>(
      name: string,
      optionsOrCallback: { ifAvailable?: boolean } | ((lock: { name: string } | null) => Promise<T>),
      providedCallback?: (lock: { name: string } | null) => Promise<T>,
    ): Promise<T> {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : providedCallback!
      if (options.ifAvailable && held.has(name)) return callback(null)
      while (held.has(name)) await held.get(name)
      let release!: () => void
      held.set(name, new Promise<void>(resolve => { release = resolve }))
      try { return await callback({ name }) }
      finally { held.delete(name); release() }
    },
  } as Pick<LockManager, 'request'>
  return { storage, locks }
}
