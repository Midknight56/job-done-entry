// @ts-check

import { ACCOUNT_NEURONS, DAILY_NEURONS, PER_IP_NEURONS } from '../caps.js'

/** @returns {{dayTotal: (day: string, app?: string) => Promise<number>, add: (day: string, app: string, neurons: number) => Promise<number>, settle: (id: number, neurons: number) => Promise<void>}} */
export function memoryLedger() {
  /** @type {{id: number, app: string, day: string, neurons: number}[]} */
  const rows = []
  let nextId = 1
  return {
    async dayTotal(day, app) { return rows.filter((r) => r.day === day && (app === undefined || r.app === app)).reduce((n, r) => n + r.neurons, 0) },
    async add(day, app, neurons) { const id = nextId++; rows.push({ id, app, day, neurons }); return id },
    async settle(id, neurons) { const row = rows.find((r) => r.id === id); if (row) row.neurons = neurons },
  }
}

/** @param {D1Database} db */
export function d1Ledger(db) {
  return {
    /** @param {string} day @param {string} [app] */
    async dayTotal(day, app) {
      const query = app === undefined
        ? db.prepare('SELECT COALESCE(SUM(neurons), 0) AS total FROM ai_calls WHERE day = ?1').bind(day)
        : db.prepare('SELECT COALESCE(SUM(neurons), 0) AS total FROM ai_calls WHERE day = ?1 AND app = ?2').bind(day, app)
      const row = await query.first()
      return Number(row?.total || 0)
    },
    /** @param {string} day @param {string} app @param {number} neurons */
    async add(day, app, neurons) {
      const row = await db.prepare('INSERT INTO ai_calls(app, day, neurons, at) VALUES (?1, ?2, ?3, ?4) RETURNING id').bind(app, day, neurons, Date.now()).first()
      return Number(row?.id)
    },
    /** @param {number} id @param {number} neurons */
    async settle(id, neurons) {
      await db.prepare('UPDATE ai_calls SET neurons = ?2 WHERE id = ?1').bind(id, neurons).run()
    },
    /** @param {string} day @param {string} app @param {number} neurons @param {number} dailyLimit @returns {Promise<{ok: true, id: number} | {ok: false, reason: 'account'|'day'}>} */
    async reserve(day, app, neurons, dailyLimit) {
      const row = await db.prepare('INSERT INTO ai_calls(app, day, neurons, at) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COALESCE(SUM(neurons), 0) FROM ai_calls WHERE day = ?2) + ?3 <= ?5 AND (SELECT COALESCE(SUM(neurons), 0) FROM ai_calls WHERE day = ?2 AND app = ?1) + ?3 <= ?6 RETURNING id')
        .bind(app, day, neurons, Date.now(), ACCOUNT_NEURONS, dailyLimit).first()
      if (row?.id !== undefined) return { ok: true, id: Number(row.id) }
      if (await this.dayTotal(day) + neurons > ACCOUNT_NEURONS) return { ok: false, reason: /** @type {const} */ ('account') }
      return { ok: false, reason: /** @type {const} */ ('day') }
    },
  }
}

/** @returns {{get: (key: string) => Promise<number>, add: (key: string, n: number) => Promise<number>}} */
export function memoryCounter() {
  /** @type {Map<string, number>} */
  const values = new Map()
  return {
    async get(key) { return values.get(key) || 0 },
    async add(key, n) { const value = (values.get(key) || 0) + n; values.set(key, value); return value },
  }
}

/** @param {KVNamespace} kv @param {number} [ttlSeconds] */
export function kvCounter(kv, ttlSeconds = 172800) {
  return {
    /** @param {string} key */
    async get(key) { return Number.parseFloat((await kv.get(key, 'text')) || '0') || 0 },
    /** @param {string} key @param {number} n */
    async add(key, n) { const value = (Number.parseFloat((await kv.get(key, 'text')) || '0') || 0) + n; await kv.put(key, String(value), { expirationTtl: ttlSeconds }); return value },
  }
}

/** @param {{ledger: ReturnType<typeof memoryLedger> | ReturnType<typeof d1Ledger>, perIp: ReturnType<typeof memoryCounter> | ReturnType<typeof kvCounter>, app: string, dailyLimit?: number, ipLimit?: number}} options */
export function createBudget({ ledger, perIp, app, dailyLimit = DAILY_NEURONS, ipLimit = PER_IP_NEURONS }) {
  let queued = Promise.resolve()
  let blocked = false
  const reservations = new Map()
  /** @param {{ipKey: string, day: string, neurons: number}} input @returns {Promise<{ok: true, id: number} | {ok: false, reason: 'account'|'day'|'ip'|'ledger'}>} */
  async function chargeOne({ ipKey, day, neurons }) {
    try {
      if (blocked) return { ok: false, reason: /** @type {const} */ ('ledger') }
      if (!Number.isFinite(neurons) || neurons < 0) return { ok: false, reason: /** @type {const} */ ('account') }
      if (await ledger.dayTotal(day) + neurons > ACCOUNT_NEURONS) return { ok: false, reason: /** @type {const} */ ('account') }
      if (await ledger.dayTotal(day, app) + neurons > dailyLimit) return { ok: false, reason: /** @type {const} */ ('day') }
      const key = `${ipKey}:${day}`
      if (await perIp.get(key) + neurons > ipLimit) return { ok: false, reason: /** @type {const} */ ('ip') }
      if ('reserve' in ledger) {
        const result = await ledger.reserve(day, app, neurons, dailyLimit)
        if (result.ok) {
          await perIp.add(key, neurons)
          reservations.set(result.id, { key, counter: neurons, settled: null })
        }
        return result
      }
      const id = await ledger.add(day, app, neurons)
      await perIp.add(key, neurons)
      reservations.set(id, { key, counter: neurons, settled: null })
      return { ok: true, id }
    } catch {
      return { ok: false, reason: /** @type {const} */ ('ledger') }
    }
  }
  return {
    /**
     * @param {{ipKey: string, day: string, neurons: number}} input
     * @returns {Promise<{ok: true, id: number} | {ok: false, reason: 'account'|'day'|'ip'|'ledger'}>}
     */
    async charge(input) {
      const next = queued.then(() => chargeOne(input))
      queued = next.then(() => {}, () => {})
      return next
    },
    /** @param {{id: number, neurons: number}} input */
    async settle({ id, neurons }) {
      if (!Number.isFinite(neurons) || neurons < 0) return
      const next = queued.then(async () => {
        const reservation = reservations.get(id)
        if (!reservation) return
        const corrected = Math.max(neurons, reservation.settled ?? 0)
        let failure
        // Each store must receive incurred usage even if the other store is unavailable.
        try {
          await ledger.settle(id, corrected)
          reservation.settled = corrected
        } catch (error) { failure = error }
        try {
          if (corrected > reservation.counter) {
            await perIp.add(reservation.key, corrected - reservation.counter)
            reservation.counter = corrected
          }
        } catch (error) { failure ||= error }
        if (failure) { blocked = true; throw failure }
      })
      queued = next.then(() => {}, () => {})
      await next
    },
    /** @param {{ipKey: string, day: string}} input */
    async left({ ipKey, day }) {
      if (blocked) return { app: 0, ip: 0, account: 0 }
      return {
        app: Math.max(0, dailyLimit - await ledger.dayTotal(day, app)),
        ip: Math.max(0, ipLimit - await perIp.get(`${ipKey}:${day}`)),
        account: Math.max(0, ACCOUNT_NEURONS - await ledger.dayTotal(day)),
      }
    },
  }
}
