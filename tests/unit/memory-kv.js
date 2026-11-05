// A Workers KV stand in for unit tests: get, put (with expirationTtl ignored), delete, and a count of writes.

export function memoryKV() {
  const map = new Map()
  let writes = 0
  return {
    async get(key, type) {
      const v = map.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key, value) {
      writes++
      map.set(key, String(value))
    },
    async delete(key) {
      map.delete(key)
    },
    keys: () => map.keys(),
    writes: () => writes,
  }
}
