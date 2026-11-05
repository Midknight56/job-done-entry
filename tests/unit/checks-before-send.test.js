import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker from '../../src/worker.js'
import { runTurn } from '../../src/agent/loop.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { proposeInvoiceDraft } from '../../src/flows/send.js'
import { DEMO_RATE_CARD, priceLines } from '../../src/pricing/ratecard.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const ctx = { waitUntil: () => {} }
const qr = `--b\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgo=\r\n--b--`
const call = (env, path, { method = 'GET', body, cookie } = {}) => {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }
  if (cookie) headers.cookie = cookie
  return worker.fetch(new Request(`https://job-done.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx)
}
const envWith = (kv) => ({ JOBDONE: kv, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', PAYPAL_BUYER_EMAIL: 'persona-buyer@sandbox.test', IP_SALT: 'salt' })

beforeEach(() => resetTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe('the total is read back before an invoice is sent', () => {
  it('a new demo sends Dave\'s invoice when PayPal shows the same total', async () => {
    const read = { status: 200, body: { id: 'INV2-DAVE', status: 'SENT', amount: { value: '108.00', currency_code: 'USD' }, due_amount: { value: '108.00', currency_code: 'USD' } } }
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-DAVE' } }],
      'GET /v2/invoicing/invoices/INV2-DAVE': [read, read],
      'POST /v2/invoicing/invoices/INV2-DAVE/send': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-DAVE/generate-qr-code': [{ status: 200, body: qr, headers: { 'content-type': 'multipart/form-data; boundary=b' } }],
    })
    vi.stubGlobal('fetch', pp.fetch)
    const kv = memoryKV()
    const made = await call(envWith(kv), '/api/workspace', { method: 'POST', body: { tz: 0 } })
    const out = await made.json()
    expect(out.ws.invoices['INV2-DAVE']).toMatchObject({ total: '108.00', status: 'SENT' })
    expect(await kv.get('inv:INV2-DAVE')).toBe(out.ws.id)
    expect(out.ws.notices).toEqual([])
  })

  it('a different total answers 409, sends nothing, and keeps the invoice id so a retry makes no second invoice', async () => {
    const kv = memoryKV()
    const ws = seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
    const priced = priceLines([{ kind: 'callout' }], DEMO_RATE_CARD)
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced, summary: 'Visit' })
    await kv.put('ws:w1', JSON.stringify(ws))
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-ODD' } }],
      'GET /v2/invoicing/invoices/INV2-ODD': [{ status: 200, body: { id: 'INV2-ODD', status: 'DRAFT', amount: { value: '999.00' } } }],
    })
    vi.stubGlobal('fetch', pp.fetch)
    const res = await call(envWith(kv), `/api/drafts/${draft.id}/send`, { method: 'POST', cookie: 'jd_ws=w1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'total_mismatch' })
    expect(pp.calls.some((c) => c.path.endsWith('/send'))).toBe(false)
    expect(JSON.parse(await kv.get('ws:w1')).drafts[draft.id].invoiceId).toBe('INV2-ODD')
  })
})

describe('a code written reason on a new customer card', () => {
  it('says no customer has that name yet', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const replies = [
      { calls: [{ tool: 'find_customer', args: { name: 'Zed' } }] },
      { final: { kind: 'invoice', customer_id: 'new', customer_name: 'Zed' } },
    ]
    const callModel = async () => ({ text: JSON.stringify(replies.shift()), neurons: 1 })
    const out = await runTurn(ws, 'Invoice Zed for a call out.', { callModel, now: NOW })
    expect(out.proposal).toEqual({ kind: 'new_customer', name: 'Zed', reason: 'No customer by that name yet.' })
  })
})
