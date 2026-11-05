import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { proposeInvoiceDraft, sendDraft } from '../../src/flows/send.js'
import { DEMO_RATE_CARD, priceLines } from '../../src/pricing/ratecard.js'
import { fakePayPal } from './fake-paypal.js'

const ENV = { PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', PAYPAL_BUYER_EMAIL: 'persona-buyer@sandbox.test' }
const QR_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
const qrBody = `--b1\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\n${QR_PNG_B64}\r\n--b1--`

function script() {
  return fakePayPal({
    'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-MARIA', rel: 'self', method: 'GET' } }],
    'POST /v2/invoicing/invoices/INV2-MARIA/send': [{ status: 200, body: { href: 'x', rel: 'payer-view', method: 'GET' } }],
    'POST /v2/invoicing/invoices/INV2-MARIA/generate-qr-code': [{ status: 200, body: qrBody, headers: { 'content-type': 'multipart/form-data; boundary=b1' } }],
    'GET /v2/invoicing/invoices/INV2-MARIA': [{ status: 200, body: { id: 'INV2-MARIA', status: 'SENT', amount: { currency_code: 'USD', value: '282.42' }, due_amount: { currency_code: 'USD', value: '282.42' }, detail: { reference: 'x', metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-MARIA' } } } }],
  })
}

const maria = () => priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Kitchen tap', cost: 89 }], DEMO_RATE_CARD)

beforeEach(() => resetTokenCache())

describe('the Send tap', () => {
  it('creates, reads the total, sends, gets the QR and reads the payer link in that order', async () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-28T14:00:00Z'), tzOffsetMinutes: -180 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    const pp = script()
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    const out = await sendDraft(ws, draft.id, { api, env: ENV, now: Date.parse('2026-10-28T14:01:00Z') })
    const calls = pp.calls.filter((c) => c.path.startsWith('/v2/')).map((c) => `${c.method} ${c.path}`)
    expect(calls).toEqual([
      'POST /v2/invoicing/invoices',
      'GET /v2/invoicing/invoices/INV2-MARIA',
      'POST /v2/invoicing/invoices/INV2-MARIA/send',
      'POST /v2/invoicing/invoices/INV2-MARIA/generate-qr-code',
      'GET /v2/invoicing/invoices/INV2-MARIA',
    ])
    expect(out.invoiceId).toBe('INV2-MARIA')
    expect(ws.invoices['INV2-MARIA']).toMatchObject({ total: '282.42', due: '282.42', status: 'SENT', qr: QR_PNG_B64, customerId: 'c1' })
    expect(ws.invoices['INV2-MARIA'].payerUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//)
    const posts = pp.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v2/'))
    expect(posts.map((p) => p.headers.get('paypal-request-id'))).toEqual([`jd-w1-${draft.id}-create`, `jd-w1-${draft.id}-send`, `jd-w1-${draft.id}-qr`])
    const created = JSON.parse(posts[0].body)
    expect(created.primary_recipients[0].billing_info.email_address).toBe('persona-buyer@sandbox.test')
    expect(created.items.map((i) => i.unit_amount.value)).toEqual(['45.00', '85.00', '89.00'])
    expect(created.detail.reference).toBe(`jd-w1-${draft.id}`)
  })

  it('sends when PayPal writes the same total another way', async () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-28T14:00:00Z'), tzOffsetMinutes: -180 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    const read = { status: 200, body: { id: 'INV2-MARIA', status: 'DRAFT', amount: { value: '282.420' }, due_amount: { value: '282.42' } } }
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-MARIA' } }],
      'GET /v2/invoicing/invoices/INV2-MARIA': [read, read],
      'POST /v2/invoicing/invoices/INV2-MARIA/send': [{ status: 200, body: { href: 'x' } }],
      'POST /v2/invoicing/invoices/INV2-MARIA/generate-qr-code': [{ status: 200, body: qrBody, headers: { 'content-type': 'multipart/form-data; boundary=b1' } }],
    })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await sendDraft(ws, draft.id, { api, env: ENV, now: 1 })
    expect(pp.calls.some((call) => call.path.endsWith('/send'))).toBe(true)
  })

  it('does not send when PayPal total differs from the draft and keeps the invoice id', async () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-28T14:00:00Z'), tzOffsetMinutes: -180 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-MARIA' } }],
      'GET /v2/invoicing/invoices/INV2-MARIA': [{ status: 200, body: { id: 'INV2-MARIA', status: 'DRAFT', amount: { value: '300.00' }, due_amount: { value: '300.00' } } }],
    })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await expect(sendDraft(ws, draft.id, { api, env: ENV, now: 1 })).rejects.toMatchObject({
      code: 'TOTAL_MISMATCH',
      status: 409,
      message: 'PayPal shows 300.00, the draft shows 282.42. Not sent.',
    })
    expect(ws.drafts[draft.id].invoiceId).toBe('INV2-MARIA')
    expect(pp.calls.some((call) => call.path.endsWith('/send'))).toBe(false)
  })

  it('a repeated tap makes no PayPal call', async () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-28T14:00:00Z'), tzOffsetMinutes: -180 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    const pp = script()
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await sendDraft(ws, draft.id, { api, env: ENV, now: 1 })
    const before = pp.calls.length
    const again = await sendDraft(ws, draft.id, { api, env: ENV, now: 2 })
    expect(again.invoiceId).toBe('INV2-MARIA')
    expect(pp.calls.length).toBe(before)
  })

  it('refuses a recipient that is not a sandbox persona or example.com, before any PayPal call', async () => {
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    ws.customers.push({ id: 'cX', name: 'Real Person', given: 'Real', surname: 'Person', address: '', email: 'someone@gmail.com' })
    const draft = proposeInvoiceDraft(ws, { customerId: 'cX', priced: maria(), summary: 'x' })
    const pp = script()
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await expect(sendDraft(ws, draft.id, { api, env: ENV, now: 1 })).rejects.toMatchObject({ code: 'RECIPIENT' })
    expect(pp.calls.length).toBe(0)
  })

  it('a create that failed with 422 leaves the draft unsent and shows the debug id', async () => {
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'x' })
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg422' } }] })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await expect(sendDraft(ws, draft.id, { api, env: ENV, now: 1 })).rejects.toMatchObject({ code: 'PAYPAL', status: 422, debugId: 'dbg422' })
    expect(ws.drafts[draft.id].invoiceId).toBeUndefined()
  })
})

describe('two taps at once', () => {
  it('each draft has a fixed invoice number; a duplicate number finds the first invoice and makes no second one', async () => {
    const ws = seedWorkspace({ id: 'abcdef1234567890', now: 0, tzOffsetMinutes: 0 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] } }],
      'POST /v2/invoicing/search-invoices': [{ status: 200, body: { items: [{ id: 'INV2-MARIA', status: 'SENT' }] } }],
      'POST /v2/invoicing/invoices/INV2-MARIA/send': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }],
      'POST /v2/invoicing/invoices/INV2-MARIA/generate-qr-code': [{ status: 200, body: qrBody, headers: { 'content-type': 'multipart/form-data; boundary=b1' } }],
      'GET /v2/invoicing/invoices/INV2-MARIA': [{ status: 200, body: { id: 'INV2-MARIA', status: 'SENT', amount: { value: '282.42', currency_code: 'USD' }, due_amount: { value: '282.42', currency_code: 'USD' } } }],
    })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    const out = await sendDraft(ws, draft.id, { api, env: ENV, now: 1 })
    expect(out.invoiceId).toBe('INV2-MARIA')
    const created = JSON.parse(pp.calls.find((c) => c.path === '/v2/invoicing/invoices').body)
    expect(created.detail.invoice_number).toBe(`JD-ABCDEF123456-${draft.id.toUpperCase()}`)
    expect(created.detail.invoice_number.length).toBeLessThanOrEqual(25)
  })
})
