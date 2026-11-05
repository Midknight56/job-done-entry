// @ts-check
// KV storage. One document per workspace (everything a user action changes is saved in one write), an index from
// each invoice id to its workspace for webhooks, and the day's counters. See src/caps.js for the write arithmetic.

const WS_TTL = 30 * 86_400
const INV_TTL = 60 * 86_400

/** @param {any} env @param {string} wid */
export async function loadWs(env, wid) {
  if (!wid || !/^[a-z0-9]{1,40}$/.test(wid)) return null
  if (env.WORKSPACE_STORE) {
    const text = await env.WORKSPACE_STORE.get('ws')
    return text ? JSON.parse(text) : null
  }
  const text = await env.JOBDONE.get(`ws:${wid}`)
  return text ? JSON.parse(text) : null
}

/** @param {any} env @param {any} ws */
export async function saveWs(env, ws) {
  if (env.WORKSPACE_STORE) {
    await env.WORKSPACE_STORE.put('ws', JSON.stringify(ws))
    return
  }
  if (env.WORKSPACE) {
    const object = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id))
    await object.fetch(new Request('https://do.internal/internal/workspace', { method: 'PUT', body: JSON.stringify(ws) }))
    return
  }
  await env.JOBDONE.put(`ws:${ws.id}`, JSON.stringify(ws), { expirationTtl: WS_TTL })
}

/** @param {any} env @param {string} invoiceId @param {string} wid */
export async function indexInvoice(env, invoiceId, wid) {
  await env.JOBDONE.put(`inv:${invoiceId}`, wid, { expirationTtl: INV_TTL })
}

/**
 * The day's counters in one KV document, read once and written once per request: actions, invoices, demos,
 * and, when no D1 ledger is bound, the app's neurons.
 * @param {any} env @param {string} key
 */
export async function loadCounter(env, key) {
  const text = await env.JOBDONE.get(key)
  const value = text ? JSON.parse(text) : {}
  let dirty = false
  return {
    value,
    /** @param {string} field @param {number} n */
    add(field, n) { value[field] = (value[field] || 0) + n; dirty = true },
    /** @param {string} field */
    get(field) { return value[field] || 0 },
    /** @param {number} ttl */
    async flush(ttl) { if (dirty) await env.JOBDONE.put(key, JSON.stringify(value), { expirationTtl: ttl }); dirty = false },
  }
}

/**
 * @typedef {{ field: string, n: number, limit: number }} CapItem
 * @param {any} env @param {string} dayKey @param {string} ipKey
 * @param {any} dayCounter @param {any} ipCounter @param {CapItem[]} dayItems @param {CapItem[]} ipItems
 */
export async function reserveCaps(env, dayKey, ipKey, dayCounter, ipCounter, dayItems, ipItems) {
  /** @param {string} key @param {any} counter @param {'reserve'|'release'} operation @param {CapItem[]} items */
  async function change(key, counter, operation, items) {
    if (env.CAPS) {
      const object = env.CAPS.get(env.CAPS.idFromName(key))
      const response = await object.fetch(new Request(`https://do.internal/${operation}`, { method: 'POST', body: JSON.stringify({ items }) }))
      if (!response.ok) throw new Error('Shared counter unavailable')
      return response.json()
    }
    const values = counter.value
    if (operation === 'reserve' && items.some(({ field, n, limit }) => counter.get(field) + n > limit)) return { ok: false, values }
    for (const { field, n } of items) counter.add(field, operation === 'reserve' ? n : -Math.min(counter.get(field), n))
    return { ok: true, values }
  }
  const day = await change(dayKey, dayCounter, 'reserve', dayItems)
  /** @param {CapItem[]} items @param {any} values */
  const failedField = (items, values) => items.find(({ field, n, limit }) => (values[field] || 0) + n > limit)?.field
  if (!day.ok) return { ok: false, field: failedField(dayItems, day.values), release: async () => {} }
  let ip
  try {
    ip = await change(ipKey, ipCounter, 'reserve', ipItems)
  } catch (error) {
    await change(dayKey, dayCounter, 'release', dayItems)
    throw error
  }
  if (!ip.ok) {
    await change(dayKey, dayCounter, 'release', dayItems)
    return { ok: false, field: failedField(ipItems, ip.values), release: async () => {} }
  }
  return { ok: true, field: undefined,
    /** @param {string} [field] */
    async release(field) {
      const select = (items) => field ? items.filter((item) => item.field === field || item.field.endsWith(`:${field}`)) : items
      await change(dayKey, dayCounter, 'release', select(dayItems))
      await change(ipKey, ipCounter, 'release', select(ipItems))
    },
  }
}
