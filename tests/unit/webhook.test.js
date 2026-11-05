import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resetTokenCache } from '../../src/paypal/token.js'
import { handleWebhook, invoiceIdOf } from '../../src/paypal/webhooks.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const sample = readFileSync(new URL('../fixtures/event-invoice-paid-sample.json', import.meta.url), 'utf8')
const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig==',
  'paypal-transmission-time': '2026-10-29T15:00:00Z',
}

function setup(verification = 'SUCCESS') {
  const kv = memoryKV()
  const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: verification } }] })
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: 'WH-OURS' }
  const waits = []
  const ctx = { waitUntil: (p) => waits.push(p) }
  return { kv, pp, env, ctx, settle: () => Promise.all(waits) }
}

async function seedMaria(kv) {
  const ws = seedWorkspace({ id: 'w1', now: Date.parse('2026-10-29T14:00:00Z'), tzOffsetMinutes: 0 })
  ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '282.42', due: '282.42', status: 'SENT', sentAt: 1, reminders: 0 }
  ws.jobs.find((j) => j.id === 'j2').state = 'sent'
  await kv.put('ws:w1', JSON.stringify(ws))
  await kv.put('inv:INV2-MARIA', 'w1')
}

function event(id, type, resourceId) {
  const e = JSON.parse(sample)
  e.id = id
  e.event_type = type
  e.resource.id = resourceId
  return JSON.stringify(e, null, 1) // odd spacing on purpose: the raw text must reach PayPal unchanged
}

const post = (body, headers = HEADERS) => new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body })

beforeEach(() => resetTokenCache())

describe('the PayPal webhook', () => {
  it('reads the invoice id from a real event (resource.invoice.id) and from the simulated sample (resource.id)', () => {
    expect(invoiceIdOf({ resource: { invoice: { id: 'INV2-REAL' } } })).toBe('INV2-REAL')
    expect(invoiceIdOf(JSON.parse(sample))).toMatch(/^INV2-/)
  })

  it('missing headers give 400 and no PayPal call', async () => {
    const s = setup()
    const res = await handleWebhook(post(event('E1', 'INVOICING.INVOICE.PAID', 'INV2-MARIA'), { 'paypal-auth-algo': 'x' }), s.env, s.ctx, { fetch: s.pp.fetch })
    expect(res.status).toBe(400)
    expect(s.pp.calls.length).toBe(0)
  })

  it('sends the raw body unchanged inside the verify request', async () => {
    const s = setup()
    await seedMaria(s.kv)
    const raw = event('E1', 'INVOICING.INVOICE.PAID', 'INV2-MARIA')
    await handleWebhook(post(raw), s.env, s.ctx, { fetch: s.pp.fetch })
    const verify = s.pp.calls.find((c) => c.path === '/v1/notifications/verify-webhook-signature')
    expect(verify.body).toContain(`"webhook_event":${raw}`)
    expect(JSON.parse(verify.body)).toMatchObject({ webhook_id: 'WH-OURS', transmission_id: 'tx-1', auth_algo: 'SHA256withRSA' })
  })

  it('a verify result other than SUCCESS gives 400 and no change', async () => {
    const s = setup('FAILURE')
    await seedMaria(s.kv)
    const res = await handleWebhook(post(event('E1', 'INVOICING.INVOICE.PAID', 'INV2-MARIA')), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    expect(res.status).toBe(400)
    const ws = JSON.parse(await s.kv.get('ws:w1'))
    expect(ws.invoices['INV2-MARIA'].status).toBe('SENT')
    expect(ws.panel.at(-1)).toMatchObject({ kind: 'guard' })
  })

  it('PAID turns the job green, answers 200, and a repeated event id is ignored', async () => {
    const s = setup()
    await seedMaria(s.kv)
    const res = await handleWebhook(post(event('E1', 'INVOICING.INVOICE.PAID', 'INV2-MARIA')), s.env, s.ctx, { fetch: s.pp.fetch, now: () => 5 })
    expect(res.status).toBe(200)
    await s.settle()
    let ws = JSON.parse(await s.kv.get('ws:w1'))
    expect(ws.invoices['INV2-MARIA']).toMatchObject({ status: 'PAID', due: '0.00' })
    expect(ws.jobs.find((j) => j.id === 'j2').state).toBe('paid')
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 282.42.')
    expect(ws.panel.at(-1)).toMatchObject({ kind: 'webhook', text: expect.stringContaining('SUCCESS') })
    const panelSize = ws.panel.length
    const again = await handleWebhook(post(event('E1', 'INVOICING.INVOICE.PAID', 'INV2-MARIA')), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    expect(again.status).toBe(200)
    ws = JSON.parse(await s.kv.get('ws:w1'))
    expect(ws.panel.length).toBe(panelSize)
  })

  it('an unknown invoice id gives 200 and is dropped (another app shares the sandbox app)', async () => {
    const s = setup()
    const res = await handleWebhook(post(event('E2', 'INVOICING.INVOICE.PAID', 'INV2-OTHER')), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    expect(res.status).toBe(200)
    expect([...s.kv.keys()].filter((k) => k.startsWith('ws:'))).toHaveLength(0)
  })

  it('CANCELLED on a held deposit releases the slot', async () => {
    const s = setup()
    const ws = seedWorkspace({ id: 'w1', now: 0, tzOffsetMinutes: 0 })
    ws.jobs.push({ id: 'j20', customerId: 'c1', summary: 'Bathroom tap', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', state: 'held', depositInvoiceId: 'INV2-DEP' })
    ws.holds.push({ jobId: 'j20', invoiceId: 'INV2-DEP', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', expiresAt: 999 })
    ws.invoices['INV2-DEP'] = { id: 'INV2-DEP', customerId: 'c1', jobId: 'j20', kind: 'deposit', total: '50.00', due: '50.00', status: 'SENT', reminders: 0 }
    await s.kv.put('ws:w1', JSON.stringify(ws))
    await s.kv.put('inv:INV2-DEP', 'w1')
    await handleWebhook(post(event('E3', 'INVOICING.INVOICE.CANCELLED', 'INV2-DEP')), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    const after = JSON.parse(await s.kv.get('ws:w1'))
    expect(after.jobs.find((j) => j.id === 'j20').state).toBe('released')
    expect(after.jobs.find((j) => j.id === 'j5').state).toBe('offered')
  })
})
