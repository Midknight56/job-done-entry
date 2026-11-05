import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { fakePayPal, ENV } from './fake-paypal.js'

beforeEach(() => resetTokenCache())

const created = { status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-NEW1', rel: 'self', method: 'GET' } }

describe('request ids and retries', () => {
  it('every POST carries PayPal-Request-Id; the caller id is used as given', async () => {
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices': [created], 'POST /v2/invoicing/invoices/INV2-NEW1/send': [{ status: 200, body: {} }] })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await api.request({ method: 'POST', path: '/v2/invoicing/invoices', body: {}, requestId: 'jd-w1-j1-create' })
    await api.request({ method: 'POST', path: '/v2/invoicing/invoices/INV2-NEW1/send', body: {} })
    const posts = pp.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v2/'))
    expect(posts[0].headers.get('paypal-request-id')).toBe('jd-w1-j1-create')
    expect(posts[1].headers.get('paypal-request-id')).toMatch(/.{8,}/)
  })

  it('a 429 is retried with backoff and the retry reuses the same request id', async () => {
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices': [{ status: 429, body: { name: 'RATE_LIMIT_REACHED', debug_id: 'd429' } }, { status: 429, body: {} }, created] })
    const waits = []
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async (ms) => { waits.push(ms) } })
    const res = await api.request({ method: 'POST', path: '/v2/invoicing/invoices', body: {}, requestId: 'jd-w1-j1-create' })
    expect(res.status).toBe(201)
    const posts = pp.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v2/'))
    expect(posts.length).toBe(3)
    expect(new Set(posts.map((p) => p.headers.get('paypal-request-id')))).toEqual(new Set(['jd-w1-j1-create']))
    expect(waits.length).toBe(2)
    expect(waits[1]).toBeGreaterThan(waits[0])
  })

  it('gives up after a few 429s and returns the last answer', async () => {
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices': [{ status: 429, body: { name: 'RATE_LIMIT_REACHED' } }] })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    const res = await api.request({ method: 'POST', path: '/v2/invoicing/invoices', body: {}, requestId: 'r' })
    expect(res.status).toBe(429)
    expect(pp.calls.filter((c) => c.path.startsWith('/v2/')).length).toBeLessThanOrEqual(4)
  })

  it('keeps debug_id and the error name, and logs no token', async () => {
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'abc123', details: [{ issue: 'MISSING_FIELD' }] } }] })
    const log = []
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {}, log: (e) => log.push(e) })
    const res = await api.request({ method: 'POST', path: '/v2/invoicing/invoices', body: {}, requestId: 'r' })
    expect(res.status).toBe(422)
    expect(res.debugId).toBe('abc123')
    expect(res.errorName).toBe('UNPROCESSABLE_ENTITY')
    expect(log[0]).toMatchObject({ kind: 'paypal', method: 'POST', path: '/v2/invoicing/invoices', status: 422, debugId: 'abc123' })
    expect(JSON.stringify(log)).not.toMatch(/tok1|secret-y|id-x/)
  })
})
