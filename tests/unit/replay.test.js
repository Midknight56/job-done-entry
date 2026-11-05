import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import samples from '../../samples/replay.json'
import worker from '../../src/worker.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { DAILY_NEURONS } from '../../src/caps.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const qr = `--b\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgo=\r\n--b--`

/** A Worker env with a spent AI day: every model call would be refused. */
function spentEnv() {
  const kv = memoryKV()
  let aiCalls = 0
  const pp = fakePayPal({
    'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-R1' } }],
    'POST /v2/invoicing/invoices/INV2-R1/send': [{ status: 200, body: {} }],
    'POST /v2/invoicing/invoices/INV2-R1/generate-qr-code': [{ status: 200, body: qr, headers: { 'content-type': 'multipart/form-data; boundary=b' } }],
    'GET /v2/invoicing/invoices/INV2-R1': [{ status: 200, body: { id: 'INV2-R1', status: 'SENT', amount: { value: '282.42', currency_code: 'USD' }, due_amount: { value: '282.42', currency_code: 'USD' } } }],
  })
  const env = {
    JOBDONE: kv,
    AI: { run: async () => { aiCalls++; return { response: '{}' } } },
    PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', PAYPAL_BUYER_EMAIL: 'persona-buyer@sandbox.test', IP_SALT: 'salt',
  }
  // The app's whole day is already spent in the ledger (no D1 binding here, so the ledger is the KV day counter).
  kv.put(`cap:day:${new Date().toISOString().slice(0, 10)}`, JSON.stringify({ neurons: DAILY_NEURONS }))
  vi.stubGlobal('fetch', pp.fetch)
  return { env, pp, aiCalls: () => aiCalls }
}

const ctx = { waitUntil: () => {} }
const call = async (env, method, path, body, cookie) => {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }
  if (cookie) headers.cookie = cookie
  return worker.fetch(new Request(`https://job-done.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx)
}

beforeEach(() => resetTokenCache())
afterEach(() => vi.unstubAllGlobals())

// The Maria case needs real recorded model output in samples/replay.json (recorded on the second Cloudflare account).
const recorded = Object.keys(samples.turns || {}).length > 0

describe('replay mode', () => {
  it.skipIf(!recorded)('at the neuron cap a scripted line is answered from the recorded model output, labelled, and the PayPal calls stay live', async () => {
    const { env, pp, aiCalls } = spentEnv()
    const made = await call(env, 'POST', '/api/workspace', { tz: 0 })
    const cookie = made.headers.get('set-cookie').split(';')[0]
    const res = await call(env, 'POST', '/api/agent', { text: 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.' }, cookie)
    const out = await res.json()
    expect(aiCalls()).toBe(0)
    expect(out.replay).toBe(true)
    expect(out.proposal).toMatchObject({ kind: 'invoice' })
    expect(out.proposal.priced.total).toBe('282.42')
    expect(out.state.budget.replay).toBe(true)
    const confirmed = await call(env, 'POST', `/api/drafts/${out.proposal.draftId}/visit`, { jobId: 'j2' }, cookie)
    expect(confirmed.status).toBe(200)
    const sent = await call(env, 'POST', `/api/drafts/${out.proposal.draftId}/send`, null, cookie)
    expect(sent.status).toBe(200)
    expect(pp.calls.some((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices')).toBe(true)
  })

  it('at the cap a line with no recording gets a plain message and the scripted lines to try', async () => {
    const { env } = spentEnv()
    const made = await call(env, 'POST', '/api/workspace', { tz: 0 })
    const cookie = made.headers.get('set-cookie').split(';')[0]
    const out = await (await call(env, 'POST', '/api/agent', { text: 'Something nobody recorded' }, cookie)).json()
    expect(out.proposal).toBe(null)
    expect(out.replay).toBe(true)
    expect(out.message).toMatch(/free AI budget/)
    expect(out.lines.length).toBeGreaterThan(0)
  })
})

describe('the ledger guard', () => {
  it('with no ledger bound, no live model call is made even with budget left', async () => {
    const kv = memoryKV()
    let aiCalls = 0
    const env = { JOBDONE: kv, AI: { run: async () => { aiCalls++; return { response: '{}' } } }, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', IP_SALT: 'salt' }
    vi.stubGlobal('fetch', fakePayPal({}).fetch)
    const made = await call(env, 'POST', '/api/workspace', { tz: 0 })
    const cookie = made.headers.get('set-cookie').split(';')[0]
    const out = await (await call(env, 'POST', '/api/agent', { text: 'Something nobody recorded' }, cookie)).json()
    expect(aiCalls).toBe(0)
    expect(out.replay).toBe(true)
    const clip = new Uint8Array(44 + 32000)
    const v = new DataView(clip.buffer)
    ;[...'RIFF'].forEach((c, i) => v.setUint8(i, c.charCodeAt(0))); v.setUint32(4, 36 + 32000, true)
    ;[...'WAVEfmt '].forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0))); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    ;[...'data'].forEach((c, i) => v.setUint8(36 + i, c.charCodeAt(0))); v.setUint32(40, 32000, true)
    const voice = await worker.fetch(new Request('https://job-done.test/api/voice', { method: 'POST', headers: { cookie, 'content-type': 'audio/wav', 'cf-connecting-ip': '203.0.113.9' }, body: clip }), env, ctx)
    expect(voice.status).toBe(503)
    expect(aiCalls).toBe(0)
  })
})
