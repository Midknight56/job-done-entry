// @ts-check
// The one way the app talks to PayPal: a token on every call, PayPal-Request-Id on every POST (reused on retries),
// a 401 mints a new token once, a 429 or a dropped GET backs off and tries again, and every call becomes a
// panel entry with its HTTP code, time and debug_id. The token is never logged.

import { fetchWithTimeout, getToken, promiseWithTimeout, resetTokenCache, SANDBOX_BASE } from './token.js'

const MAX_TRIES = 4
const BACKOFF_MS = 400
const MAX_RETRY_AFTER_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000

/**
 * @typedef {{ kind: 'paypal', method: string, path: string, status: number, ms: number, id?: string, debugId?: string, errorName?: string, at: number }} PanelEntry
 * @typedef {{ status: number, ok: boolean, json: any, text: string, contentType: string, debugId?: string, errorName?: string, ms: number }} PayPalResponse
 */

/**
 * @param {any} env
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (e: PanelEntry) => void, now?: () => number, timeoutMs?: number }} [deps]
 */
export function createPayPal(env, deps = {}) {
  const fetchFn = deps.fetch || ((input, init) => fetch(input, init))
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now || Date.now
  const timeoutMs = deps.timeoutMs || REQUEST_TIMEOUT_MS
  const base = env.PAYPAL_BASE || SANDBOX_BASE

  /**
   * @param {{ method: string, path: string, body?: any, requestId?: string, accept?: string, label?: string }} req
   * @returns {Promise<PayPalResponse>}
   */
  async function request(req) {
    const method = req.method.toUpperCase()
    const requestId = method === 'POST' ? req.requestId || crypto.randomUUID() : undefined
    const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    const started = now()
    let reminted = false
    let failureName = 'NO_CONNECTION'
    /** @type {Response | null} */
    let res = null
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const token = await getToken(env, { fetch: fetchFn, now, timeoutMs })
      /** @type {Record<string, string>} */
      const headers = { authorization: 'Bearer ' + token, accept: req.accept || 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (requestId) headers['paypal-request-id'] = requestId
      try {
        res = await fetchWithTimeout(fetchFn, base + req.path, { method, headers, body }, timeoutMs)
      } catch (error) {
        res = null
        failureName = error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'NO_CONNECTION'
        if (failureName !== 'TIMEOUT' && method !== 'POST' && attempt < MAX_TRIES - 1) { await sleep(BACKOFF_MS * 2 ** attempt); continue }
        break
      }
      if (res.status === 401 && !reminted) {
        reminted = true
        resetTokenCache()
        attempt-- // the fresh token gets its own try
        continue
      }
      if (res.status === 429 && attempt < MAX_TRIES - 1) {
        const retryAfter = retryAfterMs(res.headers.get('retry-after'), now())
        await sleep(Math.min(MAX_RETRY_AFTER_MS, retryAfter ?? BACKOFF_MS * 2 ** attempt))
        continue
      }
      break
    }
    const ms = now() - started
    if (!res) {
      const out = { status: 0, ok: false, json: null, text: '', contentType: '', errorName: failureName, ms }
      deps.log?.({ kind: 'paypal', method, path: req.label || req.path, status: 0, ms, errorName: failureName, at: now() })
      return out
    }
    const contentType = res.headers.get('content-type') || ''
    let text = ''
    try {
      text = res.status === 204 ? '' : await promiseWithTimeout(res.text(), timeoutMs, () => {})
    } catch (error) {
      const errorName = error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'NO_CONNECTION'
      const out = { status: 0, ok: false, json: null, text: '', contentType: '', errorName, ms: now() - started }
      deps.log?.({ kind: 'paypal', method, path: req.label || req.path, status: 0, ms: out.ms, errorName, at: now() })
      return out
    }
    let json = null
    if (text && contentType.includes('json')) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    const debugId = json?.debug_id || res.headers.get('paypal-debug-id') || undefined
    const errorName = res.status >= 400 ? json?.name || json?.error || undefined : undefined
    const out = { status: res.status, ok: res.status >= 200 && res.status < 300, json, text, contentType, debugId, errorName, ms }
    deps.log?.({ kind: 'paypal', method, path: req.label || req.path, status: res.status, ms, debugId, errorName, at: now() })
    return out
  }

  return { request }
}

/** @param {string | null} value @param {number} now */
function retryAfterMs(value, now) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}
