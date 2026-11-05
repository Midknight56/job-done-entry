import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { DAILY_ACTIONS, PER_IP_ACTIONS, PER_IP_INVOICES } from '../../src/caps.js'

const ctx = { waitUntil: () => {} }
const today = () => new Date().toISOString().slice(0, 10)
const request = (path, { method = 'GET', cookie = 'jd_ws=w1', body, headers = {}, host = 'job-done.test' } = {}) => new Request(`https://${host}${path}`, {
  method,
  headers: { cookie, 'cf-connecting-ip': '203.0.113.1', ...(body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : body instanceof Uint8Array ? body : typeof body === 'string' ? body : JSON.stringify(body),
})

async function setup({ workspace = true, env = {} } = {}) {
  const kv = memoryKV()
  if (workspace) await kv.put('ws:w1', JSON.stringify(seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })))
  vi.stubGlobal('fetch', fakePayPal({}).fetch)
  return { kv, env: { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', ...env } }
}

const call = (env, path, options) => worker.fetch(request(path, options), env, ctx)

async function visitorField(wid, suffix) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wid)))
  const hash = [...bytes].slice(0, 12).map((value) => value.toString(16).padStart(2, '0')).join('')
  return `visitor:${hash}:${suffix}`
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('outside attack cases', () => {
  it('handles malformed JSON as a safe empty object', async () => {
    const { env } = await setup()
    const response = await call(env, '/api/settings', { method: 'POST', body: '{broken' })
    expect(response.status).toBe(200)
  })

  it.each(['"text"', '[]', 'null', '17'])('does not crash on a JSON primitive %s', async (body) => {
    const { env } = await setup()
    const response = await call(env, '/api/agent', { method: 'POST', body })
    expect(response.status).toBe(422)
  })

  it('rejects an oversized JSON body before parsing it', async () => {
    const { env } = await setup()
    const response = await call(env, '/api/agent', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024) }) })
    expect(response.status).toBe(413)
  })

  it('rejects a body whose declared length is over the JSON limit', async () => {
    const { env } = await setup()
    const response = await call(env, '/api/settings', { method: 'POST', body: '{}', headers: { 'content-length': '1048577' } })
    expect(response.status).toBe(413)
  })

  it('does not let special object keys alter settings', async () => {
    const { env, kv } = await setup()
    const response = await call(env, '/api/settings', { method: 'POST', body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' })
    expect(response.status).toBe(200)
    expect((await kv.get('ws:w1')).includes('polluted')).toBe(false)
    expect({}.polluted).toBeUndefined()
  })

  it('does not treat numeric strings as agent text', async () => {
    const { env } = await setup()
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 123 } })
    expect(response.status).toBe(422)
  })

  it('bounds huge agent text and accepts empty text as a client error', async () => {
    const { env } = await setup()
    const huge = await call(env, '/api/agent', { method: 'POST', body: { text: 'x'.repeat(10000) } })
    const empty = await call(env, '/api/agent', { method: 'POST', body: { text: '' } })
    expect(huge.status).toBe(200)
    expect(empty.status).toBe(422)
  })

  it('does not pass control characters as meaningful agent text', async () => {
    const { env } = await setup()
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: '\u0000\u0001\u0002' } })
    expect(response.status).toBe(422)
  })

  it('keeps route methods and trailing slash behavior explicit', async () => {
    const { env } = await setup()
    expect((await call(env, '/api/settings')).status).toBe(404)
    expect((await call(env, '/api/state', { method: 'POST', body: {} })).status).toBe(404)
    expect((await call(env, '/api/settings/', { method: 'POST', body: {} })).status).toBe(404)
  })

  it('does not normalize double slashes into a valid API route', async () => {
    const { env } = await setup()
    expect((await call(env, '/api//state')).status).toBe(404)
  })

  it.each(['/api/%2e%2e/state', '/api/qr%2FQR1'])('does not route encoded path separators %s', async (path) => {
    const { env } = await setup()
    expect((await call(env, path)).status).toBe(404)
  })

  it('does not expose an invoice from another workspace', async () => {
    const { env, kv } = await setup()
    const other = seedWorkspace({ id: 'w2', now: Date.now(), tzOffsetMinutes: 0 })
    other.invoices['INV2-PRIVATE'] = { id: 'INV2-PRIVATE', customerId: 'c1', kind: 'invoice', total: '10.00', due: '10.00', status: 'SENT', sentAt: Date.now(), reminders: 0 }
    await kv.put('ws:w2', JSON.stringify(other))
    const response = await call(env, '/api/invoices/INV2-PRIVATE/cash', { method: 'POST', body: { amount: '10.00' } })
    expect(response.status).toBe(404)
  })

  it('returns not found for missing drafts and oddly named offers', async () => {
    const { env } = await setup()
    expect((await call(env, '/api/drafts/missing/send', { method: 'POST' })).status).toBe(404)
    expect((await call(env, '/api/offers/%21%40/accept', { method: 'POST' })).status).toBe(404)
  })

  it('never permits payment actions on the shared QR invoice', async () => {
    const { env, kv } = await setup()
    const ws = seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
    ws.invoices.SHARED = { id: 'SHARED', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: Date.now(), reminders: 0, shared: true }
    await kv.put('ws:w1', JSON.stringify(ws))
    expect((await call(env, '/api/qr/SHARED')).status).toBe(404)
    expect((await call(env, '/api/invoices/SHARED/cash', { method: 'POST', body: { amount: '340.00' } })).status).toBe(422)
  })

  it('rejects absent, forged and malformed workspace cookies', async () => {
    const { env } = await setup()
    expect((await call(env, '/api/state', { cookie: '' })).status).toBe(404)
    expect((await call(env, '/api/state', { cookie: 'jd_ws=missing' })).status).toBe(404)
    expect((await call(env, '/api/state', { cookie: 'jd_ws=w1!' })).status).toBe(404)
    expect((await call(env, '/api/state', { cookie: `jd_ws=${'a'.repeat(41)}` })).status).toBe(404)
  })

  it('does not grant production test powers from jd_test', async () => {
    const { env } = await setup({ env: { MODEL_STUB: '1' } })
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 'show my schedule' }, cookie: 'jd_ws=w1; jd_test=attacker', host: 'job-done.test' })
    expect(response.status).toBe(200)
    expect((await response.json()).replay).toBe(true)
  })

  it('does not grant maintainer powers for a wrong or partial token', async () => {
    const { env, kv } = await setup({ env: { MAINTAINER_TOKEN: 'm'.repeat(32) } })
    await call(env, '/api/settings', { method: 'POST', body: {} })
    const key = [...kv.keys()].find((item) => item.startsWith('cap:ip:'))
    const counts = JSON.parse(await kv.get(key))
    counts.actions = PER_IP_ACTIONS
    await kv.put(key, JSON.stringify(counts))
    for (const token of ['x'.repeat(32), 'm'.repeat(31), 'm'.repeat(33)]) {
      const response = await call(env, '/api/settings', { method: 'POST', body: {}, cookie: `jd_ws=w1; jd_maint=${token}` })
      expect(response.status).toBe(429)
    }
  })

  it('enforces the visitor cap across a changed forwarding IP on the same workspace', async () => {
    const { env } = await setup()
    for (let i = 0; i < PER_IP_ACTIONS; i++) {
      const address = i % 2 ? '198.51.100.8' : '198.51.100.9'
      expect((await call(env, '/api/settings', { method: 'POST', body: {}, headers: { 'cf-connecting-ip': address } })).status).toBe(200)
    }
    const response = await call(env, '/api/settings', { method: 'POST', body: {}, headers: { 'cf-connecting-ip': '198.51.100.9' } })
    expect(response.status).toBe(429)
  })

  it('enforces the visitor invoice cap across a changed forwarding IP', async () => {
    const { env, kv } = await setup()
    const ws = JSON.parse(await kv.get('ws:w1'))
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { lines: [] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    await kv.put(`cap:day:${today()}`, JSON.stringify({ [await visitorField('w1', 'invoices')]: PER_IP_INVOICES }))
    const response = await call(env, '/api/drafts/d1/send', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.9' } })
    expect(response.status).toBe(429)
  })

  it('uses a stable fallback when the forwarding IP is absent', async () => {
    const { env } = await setup()
    const response = await worker.fetch(request('/api/state', { headers: { 'cf-connecting-ip': '' } }), env, ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('fails closed when a stored daily counter is malformed', async () => {
    const { env, kv } = await setup()
    await kv.put(`cap:day:${today()}`, '{bad')
    const response = await call(env, '/api/settings', { method: 'POST', body: {} })
    expect(response.status).toBe(503)
  })

  it.each(['null', '[]', '{"actions":"250"}'])('fails closed for invalid daily counter data %s', async (value) => {
    const { env, kv } = await setup()
    await kv.put(`cap:day:${today()}`, value)
    expect((await call(env, '/api/settings', { method: 'POST', body: {} })).status).toBe(503)
  })

  it('keeps errors generic and API answers typed and uncacheable', async () => {
    const { env } = await setup()
    const broken = await worker.fetch(request('/api/state'), { ...env, JOBDONE: { async get(key) { if (key.startsWith('ws:')) throw new Error('secret-y https://internal.example stack'); return null } } }, ctx)
    const body = await broken.text()
    expect(broken.status).toBe(500)
    expect(body).not.toMatch(/stack|secret-y|internal\.example/)
    expect(broken.headers.get('content-type')).toContain('application/json')
    expect(broken.headers.get('cache-control')).toContain('no-store')
  })

  it('uses private cache rules for QR images', async () => {
    const { env, kv } = await setup()
    const ws = seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
    ws.invoices.QR1 = { id: 'QR1', customerId: 'c1', kind: 'invoice', qr: 'iVBORw0KGgo=', shared: false }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/qr/QR1')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('private')
  })

  it('rejects requests after the daily action cap', async () => {
    const { env, kv } = await setup()
    await kv.put(`cap:day:${today()}`, JSON.stringify({ actions: DAILY_ACTIONS }))
    expect((await call(env, '/api/settings', { method: 'POST', body: {} })).status).toBe(429)
  })
})
