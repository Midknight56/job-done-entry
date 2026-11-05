import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { seedWorkspace } from '../../src/state/workspace.js'
import { sendReminderTap } from '../../src/flows/reminders.js'
import { handleWebhook } from '../../src/paypal/webhooks.js'
import { applyStatus } from '../../src/state/money.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { recordCashTap } from '../../src/flows/cash.js'

const now = Date.parse('2026-11-05T14:00:00Z')
const workspace = () => {
  const ws = seedWorkspace({ id: 'repairs5', now, tzOffsetMinutes: 0 })
  ws.invoices.INV = { id: 'INV', customerId: 'c1', jobId: 'j1', kind: 'invoice', status: 'SENT', total: '100.00', due: '100.00' }
  ws.jobs.find(j => j.id === 'j1').state = 'sent'
  return ws
}

it('R5 item 1 offers standard delivery and keeps custom wording separate', async () => {
  const ws = workspace(), requests = [], delivered = []
  // The provider ignores custom subject and note, as its reminder contract specifies.
  const api = { request: async p => {
    requests.push(p)
    delivered.push('Standard invoice reminder')
    return { ok: true }
  } }
  await sendReminderTap(ws, 'INV', 'Please pay before the purple moon rises.', { api, now })
  expect(delivered).toEqual(['Standard invoice reminder'])
  expect(requests[0].body).not.toHaveProperty('note')
  expect(requests[0].body).not.toHaveProperty('subject')
  const cards = readFileSync('public/cards.js', 'utf8').split("proposal.kind === 'reminder'")[1].split("proposal.kind === 'answer'")[0]
  expect(cards).toContain('Send PayPal reminder')
  expect(cards).toContain('PayPal sends its standard reminder.')
  expect(cards).toContain('Your own message, to copy into a text or email')
  expect(cards).not.toContain('proposal.tone')
  expect(cards).not.toContain('{ text: proposal.edited }')
})

it.each(['0.00', '5.00'])('R5 item 3 reconciles partial cash immediately with tip %s', async tip => {
  const ws = workspace()
  const due = (60 + Number(tip)).toFixed(2)
  const reads = [
    { id: 'INV', status: 'SENT', amount: { value: '100.00', currency_code: 'USD' }, due_amount: { value: '100.00' } },
    { id: 'INV', status: 'PARTIALLY_PAID', due_amount: { value: due }, payments: { paid_amount: { value: '40.00' } }, gratuity: { value: tip } },
  ]
  const api = { request: async ({ method }) => ({ ok: true, json: method === 'GET' ? reads.shift() : {} }) }
  expect(await recordCashTap(ws, 'INV', '40.00', { api, now })).toEqual({ status: 'PARTIALLY_PAID', due })
  expect(ws.invoices.INV).toMatchObject({ status: 'PARTIALLY_PAID', paid: '40.00', due, cash: true })
  if (Number(tip)) expect(ws.invoices.INV.tip).toBe(tip)
  expect(ws.jobs.find(j => j.id === 'j1').state).toBe('part')
  expect(ws.notices.at(-1)).toMatchObject({ kind: 'part', invoiceId: 'INV' })
  expect(ws.notices.at(-1).text).toContain(`${due} left.`)
})

it('R5 item 3 preserves reconciled money when cash readback is stale', async () => {
  const ws = workspace()
  applyStatus(ws, 'INV', 'PARTIALLY_PAID', now, { paid: '60.00', due: '40.00' })
  const count = ws.notices.length
  const reads = [
    { id: 'INV', status: 'PARTIALLY_PAID', due_amount: { value: '40.00' }, payments: { paid_amount: { value: '60.00' } } },
    { id: 'INV', status: 'PARTIALLY_PAID', due_amount: { value: '70.00' }, payments: { paid_amount: { value: '30.00' } } },
  ]
  const api = { request: async ({ method }) => ({ ok: true, json: method === 'GET' ? reads.shift() : {} }) }
  expect(await recordCashTap(ws, 'INV', '10.00', { api, now })).toEqual({ status: 'PARTIALLY_PAID', due: '40.00' })
  expect(ws.invoices.INV).toMatchObject({ paid: '60.00', due: '40.00' })
  expect(ws.notices).toHaveLength(count)
})

it('R5 item 3 passes an explicit refund readback without guessing', async () => {
  const ws = workspace()
  const reads = [
    { id: 'INV', status: 'SENT', due_amount: { value: '100.00' } },
    { id: 'INV', status: 'PARTIALLY_REFUNDED', due_amount: { value: '60.00' }, payments: { paid_amount: { value: '40.00' } }, refunds: { refund_amount: { value: '10.00' } } },
  ]
  const api = { request: async ({ method }) => ({ ok: true, json: method === 'GET' ? reads.shift() : {} }) }
  await recordCashTap(ws, 'INV', '40.00', { api, now })
  expect(ws.invoices.INV).toMatchObject({ paid: '40.00', refunded: '10.00', due: '60.00', status: 'PARTIALLY_REFUNDED' })
})

it.each(['public/about.html', 'README.md'])('R5 item 4 explains visit confirmation before sending in %s', file => {
  const instructions = readFileSync(file, 'utf8')
  const paths = file === 'README.md' ? [instructions.split('## Judge in 60 seconds')[1].split('What to look at:')[0], instructions.split('## Try it')[1].split('Sandbox buyer')[0]] : [instructions.split('<h2>Try it</h2>')[1].split('</ol>')[0]]
  for (const path of paths) {
    expect(path).toContain('Choose the visit or enter a completed visit.')
    expect(path).toContain('Confirm visit')
    expect(path.indexOf('Confirm visit')).toBeLessThan(path.indexOf('Tap Send'))
  }
})

it.each(['SENT', 'UNPAID', 'SCHEDULED', 'PAYMENT_PENDING'])('R5 item 2 rejects stale %s after partial payment through webhooks', async status => {
  resetTokenCache()
  const ws = workspace(), kv = memoryKV()
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws))
  await kv.put('inv:INV', ws.id)
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', PAYPAL_WEBHOOK_ID: 'test' }
  const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }] })
  const headers = Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'].map(name => [name, 'test']))
  for (const [id, type, invoice] of [
    ['paid', 'PAID', { status: 'PARTIALLY_PAID', due_amount: { value: '40.00' }, payments: { paid_amount: { value: '60.00' } } }],
    ['old', 'UPDATED', { status, due_amount: { value: '100.00' } }],
  ]) {
    const event = { id, event_type: `INVOICING.INVOICE.${type}`, resource: { invoice: { id: 'INV', ...invoice } } }
    expect((await handleWebhook(new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) }), env, { waitUntil() {} }, { fetch: pp.fetch, now: () => now })).status).toBe(200)
  }
  const saved = JSON.parse(await kv.get(`ws:${ws.id}`))
  expect(saved.invoices.INV).toMatchObject({ status: 'PARTIALLY_PAID', paid: '60.00', due: '40.00' })
  expect(saved.jobs.find(j => j.id === 'j1').state).toBe('part')
  expect(saved.notices.filter(n => n.kind === 'part')).toHaveLength(1)
  // Explicit refund reports still reconcile independently.
  expect(applyStatus(saved, 'INV', 'PARTIALLY_REFUNDED', now, { paid: '60.00', due: '40.00', refunded: '10.00' })).toBe(true)
  expect(saved.invoices.INV.refunded).toBe('10.00')
})
