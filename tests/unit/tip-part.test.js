// Tips and part payment on one invoice. The shapes are the sandbox's own: an invoice made on 28 Oct 2026 with both
// flags answered 201, and after the buyer paid 100.00 plus a 10.00 tip it read PARTIALLY_PAID with amount 292.42,
// gratuity 10.00, paid_amount 110.00 and due_amount 182.42 (tests/fixtures/invoice-partially_paid.json).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { invoiceBody, readInvoice } from '../../src/paypal/invoices.js'
import { handleWebhook, paymentOf } from '../../src/paypal/webhooks.js'
import { applyStatus } from '../../src/state/money.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { proposeInvoiceDraft, sendDraft, setPaymentOptions } from '../../src/flows/send.js'
import { DEMO_RATE_CARD, depositPriced, priceLines } from '../../src/pricing/ratecard.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const partly = JSON.parse(readFileSync(new URL('../fixtures/invoice-partially_paid.json', import.meta.url), 'utf8'))
const maria = () => priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Kitchen tap', cost: 89 }], DEMO_RATE_CARD)
const body = (o = {}) => invoiceBody({ business: 'B', given: 'Maria', surname: 'Lopez', email: 'a@example.com', priced: maria(), reference: 'r', ...o })

/** The sandbox invoice after the full rest was paid too: the same tip, nothing due. */
const fullyPaid = () => ({ ...partly, status: 'PAID', due_amount: { currency_code: 'USD', value: '0.00' }, payments: { ...partly.payments, paid_amount: { currency_code: 'USD', value: '292.42' } } })

beforeEach(() => resetTokenCache())

describe('the invoice body', () => {
  it('asks for a tip and a part payment in the shape the sandbox accepted', () => {
    expect(body({ allowTip: true, partMinimum: '50.00' }).configuration).toEqual({
      allow_tip: true,
      partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '50.00' } },
    })
  })

  it('asks for neither when not told to', () => {
    expect(body().configuration).toEqual({ allow_tip: false })
  })
})

describe('reading a part paid invoice', () => {
  it('reads the tip and what was paid', () => {
    expect(readInvoice(partly)).toMatchObject({ status: 'PARTIALLY_PAID', due: '182.42', paid: '110.00', tip: '10.00' })
  })

  it('reads a webhook resource the same way, and a PAID event on a part paid invoice stays part paid', () => {
    expect(paymentOf({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: partly } })).toEqual({ status: 'PARTIALLY_PAID', due: '182.42', paid: '110.00', tip: '10.00' })
    expect(paymentOf({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: fullyPaid() } })).toMatchObject({ status: 'PAID', tip: '10.00' })
    expect(paymentOf({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { ...partly, status: 'PAYMENT_PENDING' } } }).status).toBe('PAYMENT_PENDING')
    expect(paymentOf({ event_type: 'INVOICING.INVOICE.CANCELLED', resource: { id: 'X' } }).status).toBe('CANCELLED')
  })
})

describe('the payment options on a draft', () => {
  it('a job invoice may take a tip and a part payment of at least the rate card deposit', () => {
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    const d = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    setPaymentOptions(d, { tip: true, part: true }, DEMO_RATE_CARD)
    expect(d).toMatchObject({ allowTip: true, partMinimum: '50.00' })
    setPaymentOptions(d, { tip: false, part: false }, DEMO_RATE_CARD)
    expect(d.allowTip).toBe(false)
    expect(d.partMinimum).toBeUndefined()
  })

  it('a deposit, or a total no bigger than the deposit, takes no part payment and no tip on a deposit', () => {
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    const deposit = proposeInvoiceDraft(ws, { customerId: 'c1', priced: depositPriced(DEMO_RATE_CARD), summary: 'Deposit', kind: 'deposit' })
    setPaymentOptions(deposit, { tip: true, part: true }, DEMO_RATE_CARD)
    expect(deposit.allowTip).toBe(false)
    expect(deposit.partMinimum).toBeUndefined()
    const small = proposeInvoiceDraft(ws, { customerId: 'c1', priced: priceLines([{ kind: 'callout' }], DEMO_RATE_CARD), summary: 'Call out' })
    setPaymentOptions(small, { tip: true, part: true }, DEMO_RATE_CARD)
    expect(small.allowTip).toBe(true)
    expect(small.partMinimum).toBeUndefined()
  })

  it('the Send tap creates the invoice with the draft’s options', async () => {
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    const d = proposeInvoiceDraft(ws, { customerId: 'c1', priced: maria(), summary: 'Kitchen tap' })
    setPaymentOptions(d, { tip: true, part: true }, DEMO_RATE_CARD)
    const read = { status: 200, body: { id: 'INV2-MARIA', status: 'SENT', amount: { value: '282.42' }, due_amount: { value: '282.42' } } }
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-MARIA' } }],
      'GET /v2/invoicing/invoices/INV2-MARIA': [read],
      'POST /v2/invoicing/invoices/INV2-MARIA/send': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-MARIA/generate-qr-code': [{ status: 500, body: {} }],
    })
    const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' }
    ws.customers.find((c) => c.id === 'c1').email = 'maria@example.com'
    await sendDraft(ws, d.id, { api: createPayPal(env, { fetch: pp.fetch, sleep: async () => {} }), env, now: 1 })
    const created = JSON.parse(pp.calls.find((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices').body)
    expect(created.configuration.allow_tip).toBe(true)
    expect(created.configuration.partial_payment.minimum_amount_due.value).toBe('50.00')
  })
})

describe('a part payment and a tip reach the workspace', () => {
  const seed = () => {
    const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-29T14:00:00Z'), tzOffsetMinutes: 0 })
    ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '282.42', due: '282.42', status: 'SENT', sentAt: 1, reminders: 0 }
    ws.jobs.find((j) => j.id === 'j2').state = 'sent'
    return ws
  }

  it('part paid keeps the job open with what is left, then paid in full turns it green and names the tip', () => {
    const ws = seed()
    expect(applyStatus(ws, 'INV2-MARIA', 'PARTIALLY_PAID', 5, { due: '182.42', paid: '110.00', tip: '10.00' })).toBe(true)
    expect(ws.invoices['INV2-MARIA']).toMatchObject({ status: 'PARTIALLY_PAID', due: '182.42', paid: '110.00', tip: '10.00' })
    expect(ws.jobs.find((j) => j.id === 'j2').state).toBe('part')
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 100.00 plus a 10.00 tip. 182.42 left.')
    expect(applyStatus(ws, 'INV2-MARIA', 'PARTIALLY_PAID', 6, { due: '182.42', paid: '110.00', tip: '10.00' })).toBe(false)
    expect(applyStatus(ws, 'INV2-MARIA', 'PARTIALLY_PAID', 7, { due: '82.42', paid: '210.00', tip: '10.00' })).toBe(true)
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 100.00. 82.42 left.')
    expect(applyStatus(ws, 'INV2-MARIA', 'PAID', 8, { due: '0.00', paid: '292.42', tip: '10.00' })).toBe(true)
    expect(ws.jobs.find((j) => j.id === 'j2').state).toBe('paid')
    expect(ws.invoices['INV2-MARIA']).toMatchObject({ status: 'PAID', due: '0.00', tip: '10.00' })
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 282.42 plus a 10.00 tip.')
  })

  it('a paid in full with a tip in one go names the tip', () => {
    const ws = seed()
    applyStatus(ws, 'INV2-MARIA', 'PAID', 5, { due: '0.00', paid: '292.42', tip: '10.00' })
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 282.42 plus a 10.00 tip.')
  })

  it('a real PAID webhook on a part paid invoice does not turn the job green', async () => {
    const kv = memoryKV()
    await kv.put('ws:w1', JSON.stringify(seed()))
    await kv.put('inv:INV2-MARIA', 'w1')
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: 'WH-OURS' }
    const event = { id: 'E-PART', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { ...partly, id: 'INV2-MARIA' } } }
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-sig': 'sig==',
      'paypal-transmission-time': '2026-10-29T15:00:00Z',
    }
    const res = await handleWebhook(new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) }), env, { waitUntil: () => {} }, { fetch: pp.fetch, now: () => 5 })
    expect(res.status).toBe(200)
    const ws = JSON.parse(await kv.get('ws:w1'))
    expect(ws.invoices['INV2-MARIA']).toMatchObject({ status: 'PARTIALLY_PAID', due: '182.42', tip: '10.00' })
    expect(ws.jobs.find((j) => j.id === 'j2').state).toBe('part')
  })
})
