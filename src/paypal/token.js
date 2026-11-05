// @ts-check
// The PayPal access token: minted with the client credentials grant and cached in this isolate's memory only.
// PayPal's guidance: read expires_in from the response, cache the token, refresh before it runs out.

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
const REFRESH_MARGIN_MS = 300_000
const REQUEST_TIMEOUT_MS = 10_000

/** @type {{ token: string, expiresAt: number, base: string } | null} */
let cache = null
/** @type {Promise<string> | null} */
let inFlight = null

export function resetTokenCache() {
  cache = null
  inFlight = null
}

/**
 * @param {{ PAYPAL_CLIENT_ID?: string, PAYPAL_CLIENT_SECRET?: string, PAYPAL_BASE?: string }} env
 * @param {{ fetch?: typeof fetch, now?: () => number, force?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function getToken(env, opts = {}) {
  const now = opts.now || Date.now
  const base = env.PAYPAL_BASE || SANDBOX_BASE
  if (!opts.force && cache && cache.base === base && cache.expiresAt - now() > REFRESH_MARGIN_MS) return cache.token
  if (opts.force) cache = null
  if (!inFlight) inFlight = mint(env, base, opts.fetch || fetch, now, opts.timeoutMs || REQUEST_TIMEOUT_MS).finally(() => { inFlight = null })
  return inFlight
}

/** @param {typeof fetch} fetchFn @param {RequestInfo | URL} input @param {RequestInit} init @param {number} timeoutMs */
export async function fetchWithTimeout(fetchFn, input, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  return promiseWithTimeout(fetchFn(input, { ...init, signal: controller.signal }), timeoutMs, () => controller.abort())
}

/** @template T @param {Promise<T>} promise @param {number} timeoutMs @param {() => void} onTimeout @returns {Promise<T>} */
export async function promiseWithTimeout(promise, timeoutMs, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(Object.assign(new Error('PayPal request timed out'), { code: 'TIMEOUT' }))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {any} env @param {string} base @param {typeof fetch} fetchFn @param {() => number} now @param {number} timeoutMs */
async function mint(env, base, fetchFn, now, timeoutMs) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal keys are not set')
  const res = await fetchWithTimeout(fetchFn, base + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, timeoutMs)
  if (res.status !== 200) throw new Error(`PayPal token HTTP ${res.status}`)
  const json = /** @type {{ access_token: string, expires_in: number }} */ (await promiseWithTimeout(res.json(), timeoutMs, () => {}))
  if (typeof json.access_token !== 'string' || !json.access_token || !Number.isFinite(Number(json.expires_in)) || Number(json.expires_in) <= 0) throw new Error('PayPal token response is invalid')
  cache = { token: json.access_token, expiresAt: now() + Number(json.expires_in) * 1000, base }
  return json.access_token
}
