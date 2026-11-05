// A fake fetch for PayPal: records every call and answers from a list of scripted replies per path.

/**
 * @param {Record<string, Array<{status: number, body?: any, headers?: Record<string,string>}>>} script
 *   keyed by "METHOD /path"; each call takes the next reply; the last reply repeats.
 */
export function fakePayPal(script = {}) {
  const calls = []
  let tokens = 0
  /** @param {string|Request} input @param {RequestInit} [init] */
  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const method = (init.method || 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    calls.push({ method, path: url.pathname + url.search, headers, body: init.body })
    if (url.pathname === '/v1/oauth2/token') {
      tokens++
      const replies = script['POST /v1/oauth2/token']
      if (replies) return reply(replies.length > 1 ? replies.shift() : replies[0])
      return Response.json({ access_token: `tok${tokens}`, expires_in: 32400, token_type: 'Bearer' })
    }
    const key = `${method} ${url.pathname}`
    const replies = script[key]
    if (!replies) return Response.json({ name: 'NOT_SCRIPTED', debug_id: 'dbg0' }, { status: 404 })
    return reply(replies.length > 1 ? replies.shift() : replies[0])
  }
  return { fetch, calls, tokenFetches: () => tokens }
}

function reply(r) {
  const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
  return new Response(body, { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } })
}

export const ENV = { PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y' }
