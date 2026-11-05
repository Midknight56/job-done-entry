import { expect, it, vi } from 'vitest'
import { createTools } from '../../src/agent/tools.js'
import { checkFinal } from '../../src/agent/guard.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { proposeInvoiceDraft, sendDraft } from '../../src/flows/send.js'
import { sendDeposit } from '../../src/state/holds.js'
import { jobWords } from '../../public/job-words.js'
const now = Date.parse('2026-11-05T14:00:00Z')
const workspace = () => seedWorkspace({ id: 'repairs', now, tzOffsetMinutes: 0 })
const env = { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }
function paidApi() {
  let reads = 0
  return { request: vi.fn(async ({ method, path }) => {
    if (method === 'GET') return { ok: true, json: { id: 'INV', status: ++reads === 1 ? 'DRAFT' : 'PAID', amount: { value: '50.00' }, due_amount: { value: '0.00' } } }
    if (path.endsWith('/invoices')) return { ok: true, json: { id: 'INV' } }
    return { ok: true, text: '' }
  }) }
}
it.each(['invoice', 'deposit'])('R3 item 1 reconciles paid %s readback', async (kind) => {
  const ws = workspace()
  const visit = ws.jobs[0]; visit.state = 'booked'
  const d = proposeInvoiceDraft(ws, { customerId: visit.customerId, jobId: visit.id, kind, summary: 'Work', priced: { total: '50.00', lines: [] } })
  await (kind === 'deposit' ? sendDeposit : sendDraft)(ws, d.id, { api: paidApi(), env, now })
  expect(visit.state).toBe(kind === 'deposit' ? 'booked' : 'paid')
  if (kind === 'deposit') expect(visit.depositPaid).toBe(true)
  expect(jobWords(visit, { ...ws, now }).words).toBe(kind === 'deposit' ? 'Deposit paid' : 'Paid')
})
it.each(['paid', 'cancelled', 'expired'])('R3 item 2 preserves %s hold on deposit retry', async (ended) => {
  const ws = workspace(), visit = ws.jobs[0]
  visit.state = ended === 'paid' ? 'booked' : 'released'
  const d = proposeInvoiceDraft(ws, { customerId: visit.customerId, jobId: visit.id, kind: 'deposit', summary: 'Work', priced: { total: '50.00' } })
  d.invoiceId = 'INV'; d.sentAt = now
  ws.invoices.INV = { id: 'INV', status: ended === 'paid' ? 'PAID' : 'CANCELLED' }
  ws.holds.push({ jobId: visit.id, invoiceId: 'INV', ended: ended === 'paid' ? 'paid' : 'released' })
  const before = JSON.stringify(ws), api = paidApi()
  await sendDeposit(ws, d.id, { api, env, now: now + 1000 })
  expect(JSON.stringify(ws)).toBe(before)
  expect(api.request).not.toHaveBeenCalled()
})
import { runTurn } from '../../src/agent/loop.js'
it('R3 item 3 rejects aggregate labour and adds the required priced callout', () => {
  const ctx = { transcript: 'Invoice Maria for one hour', results: [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
    { tool: 'price_lines', result: { lines: [{ id: 'a', kind: 'labour', quantity: '1' }, { id: 'b', kind: 'labour', quantity: '1' }, { id: 'c', kind: 'callout' }] } },
  ] }
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['a', 'b', 'c'] }, ctx).ok).toBe(false)
  const result = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['a'] }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.proposal.line_ids).toEqual(['a', 'c'])
})
it('R3 item 3 repeated pricing reuses charges and produces 140.40', async () => {
  const ws = workspace(), transcript = 'Invoice Maria for one hour'
  const { tools } = createTools(ws, { transcript, now })
  const args = { lines: [{ kind: 'labour', hours: 1 }, { kind: 'labour', hours: 1 }] }
  const first = await tools.price_lines(args), second = await tools.price_lines(args)
  expect(first.total).toBe('140.40')
  expect(second.lines).toEqual(first.lines)
  const replies = [{ calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'price_lines', args }] }, { final: { kind: 'invoice', customer_id: 'c1', line_ids: first.lines.map(l => l.id) } }]
  const result = await runTurn(ws, transcript, { now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }) })
  expect(result.proposal.priced.total).toBe('140.40')
})
it('R3 item 4 uses the spoken booking duration and guards the final slot', async () => {
  const ws = workspace(), transcript = 'Book Maria for two hours next week'
  const { tools } = createTools(ws, { transcript, now })
  const conflict = await tools.find_slots({ duration_hours: 0.5 })
  expect(conflict.error).toBeUndefined()
  expect(conflict.slots.every(s => Date.parse(s.end) - Date.parse(s.start) === 7200000)).toBe(true)
  const valid = conflict
  const result = checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 'short' }, { transcript, results: [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
    { tool: 'find_slots', result: { slots: [{ id: 'short', start: '2026-11-09T08:00:00Z', end: '2026-11-09T08:30:00Z' }] } },
  ] })
  expect(result.ok).toBe(false)
})
it('R3 item 4 uses and states a one hour default when duration is absent', async () => {
  const { tools } = createTools(workspace(), { transcript: 'Book Maria tomorrow', now })
  const result = await tools.find_slots({})
  expect(result.defaultDurationHours).toBe(1)
  expect(result.slots.every(s => Date.parse(s.end) - Date.parse(s.start) === 3600000)).toBe(true)
})
it.each([0, -240, 330])('R3 item 5 morning slots end by local noon at offset %s', async (tz) => {
  const ws = workspace(); ws.tz = tz; ws.jobs = []
  const { tools } = createTools(ws, { transcript: 'Book Maria for half an hour tomorrow morning', now })
  const result = await tools.find_slots({ duration_hours: 0.5 })
  expect(result.slots.length).toBeGreaterThan(0)
  expect(result.slots.every(s => { const end = new Date(Date.parse(s.end) + tz * 60000); return end.getUTCHours() * 60 + end.getUTCMinutes() <= 720 })).toBe(true)
})
import { paymentOf } from '../../src/paypal/webhooks.js'
import { applyStatus } from '../../src/state/money.js'
import { balancePrice } from '../../src/flows/send.js'
import { paymentState } from '../../public/payment-state.js'
import { readInvoice } from '../../src/paypal/invoices.js'
it('R3 item 6 preserves partial refunds and retained deposit credit', () => {
  const invoice = { status: 'PARTIALLY_REFUNDED', amount: { value: '50.00' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '50.00' } }, refunds: { refund_amount: { value: '10.00' } } }
  const payment = paymentOf({ event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice } })
  expect(payment.status).toBe('PARTIALLY_REFUNDED')
  expect(payment.refunded).toBe('10.00')
  expect(readInvoice(invoice).refunded).toBe('10.00')
  const ws = workspace(), visit = ws.jobs[0]
  visit.state = 'booked'; visit.depositPaid = true; visit.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: visit.id, total: '50.00', status: 'PAID', due: '0.00' }
  applyStatus(ws, 'DEP', payment.status, now, payment)
  expect(ws.invoices.DEP).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded: '10.00', paid: '50.00' })
  expect(visit.depositPaid).toBe(true)
  expect(balancePrice(ws, visit.id, { total: '140.40' })).toMatchObject({ total: '100.40', depositCredit: '40.00' })
  expect(paymentState(ws.invoices.DEP)).toMatchObject({ closed: true, label: 'Part refunded, 10.00 returned' })
  expect(jobWords(visit, { ...ws, now }).words).toBe('Deposit part refunded, 10.00 returned')
  applyStatus(ws, 'DEP', 'REFUNDED', now + 1, { refunded: '50.00' })
  expect(visit.depositPaid).toBe(false)
  expect(balancePrice(ws, visit.id, { total: '140.40' }).total).toBe('140.40')
})
it('R3 item 6 leaves an unspecified refund unresolved', () => {
  expect(paymentOf({ event_type: 'INVOICING.INVOICE.REFUNDED', resource: { id: 'DEP' } }).status).toBeUndefined()
})
vi.mock('../../public/recorder.js', () => ({ startRecording: vi.fn() }))
import { startRecording } from '../../public/recorder.js'
import { setupTalk } from '../../public/talk.js'
function talkControls() {
  const handlers = {}, button = { addEventListener: (name, handler) => { handlers[name] = handler }, classList: { add() {}, remove() {} }, setPointerCapture() {} }
  const text = {}, timer = {}
  vi.stubGlobal('document', { querySelector: s => s === '#talk' ? button : s === '#say' ? text : timer })
  const request = vi.fn(async () => ({ text: 'Work' })), submitText = vi.fn()
  setupTalk({ request, submitText, showError: vi.fn() })
  return { handlers, request, submitText, timer }
}
it.each([' ', 'Enter'])('R3 item 7 records on keyboard hold %s and ignores repeat starts', async (key) => {
  const controls = talkControls(), stop = vi.fn(async () => new Blob(['audio']))
  startRecording.mockReset().mockResolvedValue({ stop, seconds: () => 1, cancel: vi.fn() })
  try {
    await controls.handlers.keydown?.({ key, preventDefault() {}, repeat: false })
    await controls.handlers.keydown?.({ key, preventDefault() {}, repeat: true })
    expect(startRecording).toHaveBeenCalledOnce()
    await controls.handlers.keyup?.({ key, preventDefault() {} })
    expect(stop).toHaveBeenCalledOnce()
    expect(controls.submitText).toHaveBeenCalledWith('Work')
  } finally { vi.unstubAllGlobals() }
})
it('R3 item 7 cancels permission granted after keyboard release', async () => {
  const controls = talkControls(), cancel = vi.fn()
  let grant
  startRecording.mockReset().mockImplementation(() => new Promise(resolve => { grant = resolve }))
  try {
    const pending = controls.handlers.keydown?.({ key: 'Enter', preventDefault() {}, repeat: false })
    await controls.handlers.keyup?.({ key: 'Enter', preventDefault() {} })
    expect(startRecording).toHaveBeenCalledOnce()
    grant({ cancel, seconds: () => 1 })
    await pending
    expect(cancel).toHaveBeenCalledOnce()
    expect(controls.request).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
import { releaseExpired } from '../../src/state/holds.js'
it('R3 item 6 does not cancel a partially refunded deposit on expiry', async () => {
  const ws = workspace(), visit = ws.jobs[0]
  visit.state = 'held'; visit.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: visit.id, total: '50.00', status: 'SENT' }
  ws.holds.push({ jobId: visit.id, invoiceId: 'DEP', start: visit.start, end: visit.end, expiresAt: now - 1 })
  const request = vi.fn(async () => ({ ok: true, json: { status: 'PARTIALLY_REFUNDED', amount: { value: '50.00' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '50.00' } }, refunds: { refund_amount: { value: '10.00' } } } }))
  await releaseExpired(ws, { api: { request }, now })
  expect(request).toHaveBeenCalledOnce()
  expect(ws.holds[0].ended).toBe('paid')
  expect(visit.state).toBe('booked')
  expect(ws.invoices.DEP.status).toBe('PARTIALLY_REFUNDED')
})
import { handleWebhook } from '../../src/paypal/webhooks.js'
import { WorkspaceDO } from '../../src/state/workspace-do.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { resetTokenCache } from '../../src/paypal/token.js'
it.each([false, true])('R3 item 6 persists signed partial refunds with durable storage %s', async (durable) => {
  resetTokenCache()
  const ws = workspace(), kv = memoryKV(), values = new Map()
  const visit = ws.jobs[0]; visit.depositPaid = true; visit.depositInvoiceId = 'DEP'; visit.state = 'booked'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: visit.id, customerId: visit.customerId, status: 'PAID', total: '50.00', due: '0.00' }
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws)); await kv.put('inv:DEP', ws.id)
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', PAYPAL_WEBHOOK_ID: 'test' }
  if (durable) {
    const storage = { get: async key => values.get(key), put: async (key, value) => { values.set(key, value) }, setAlarm: async () => {} }
    const object = new WorkspaceDO({ storage, id: { name: ws.id } }, env)
    env.WORKSPACE = { idFromName: name => name, get: () => object }
  }
  const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }] })
  const event = { id: 'refund1', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: 'DEP', status: 'PARTIALLY_REFUNDED', due_amount: { value: '0.00' }, payments: { paid_amount: { value: '50.00' } }, refunds: { refund_amount: { value: '10.00' } } } } }
  const headers = Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'].map(name => [name, 'test']))
  const post = () => new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) })
  expect((await handleWebhook(post(), env, { waitUntil() {} }, { fetch: pp.fetch, now: () => now })).status).toBe(200)
  const saved = JSON.parse(durable ? values.get('ws') : await kv.get(`ws:${ws.id}`))
  expect(saved.invoices.DEP).toMatchObject({ status: 'PARTIALLY_REFUNDED', paid: '50.00', refunded: '10.00', due: '0.00' })
  expect(balancePrice(saved, visit.id, { total: '140.40' }).total).toBe('100.40')
  const before = JSON.stringify(saved)
  expect((await handleWebhook(post(), env, { waitUntil() {} }, { fetch: pp.fetch, now: () => now })).status).toBe(200)
  expect(durable ? values.get('ws') : await kv.get(`ws:${ws.id}`)).toBe(before)
})
it('R3 item 6 refuses unknown deposit credit and ignores stale refund reports', () => {
  const ws = workspace(), visit = ws.jobs[0]; visit.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: visit.id, total: '50.00', status: 'PARTIALLY_REFUNDED' }
  expect(() => balancePrice(ws, visit.id, { total: '140.40' })).toThrow(expect.objectContaining({ code: 'REFUND_UNRESOLVED' }))
  applyStatus(ws, 'DEP', 'PARTIALLY_REFUNDED', now, { paid: '50.00', refunded: '20.00', due: '0.00' })
  const before = JSON.stringify(ws)
  applyStatus(ws, 'DEP', 'PARTIALLY_REFUNDED', now + 1, { paid: '50.00', refunded: '10.00', due: '0.00' })
  applyStatus(ws, 'DEP', 'PAID', now + 1)
  expect(JSON.stringify(ws)).toBe(before)
})
it.each(['PARTIALLY_REFUNDED', 'PAID', 'unavailable'])('R3 item 6 reads missing refund details and keeps %s unresolved when needed', async (readStatus) => {
  resetTokenCache()
  const ws = workspace(), kv = memoryKV()
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', status: 'PAID', total: '50.00', due: '0.00' }
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws)); await kv.put('inv:DEP', ws.id)
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', PAYPAL_WEBHOOK_ID: 'test' }
  const pp = fakePayPal({
    'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }],
    'GET /v2/invoicing/invoices/DEP': [{ status: readStatus === 'unavailable' ? 404 : 200, body: { status: readStatus, amount: { value: '50.00' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '50.00' } }, refunds: { refund_amount: { value: '10.00' } } } }],
  })
  const event = { id: 'missing-refund', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { id: 'DEP' } }
  const headers = Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'].map(name => [name, 'test']))
  const response = await handleWebhook(new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) }), env, { waitUntil() {} }, { fetch: pp.fetch })
  const resolved = readStatus === 'PARTIALLY_REFUNDED'
  expect(response.status).toBe(resolved ? 200 : 503)
  const saved = JSON.parse(await kv.get(`ws:${ws.id}`))
  expect(saved.invoices.DEP.status).toBe(resolved ? 'PARTIALLY_REFUNDED' : 'PAID')
  expect(await kv.get('evt:missing-refund')).toBe(resolved ? '1' : null)
})
it('R3 item 6 keeps a paid final visit paid when its deposit is partly refunded', () => {
  const ws = workspace(), visit = ws.jobs[0]
  visit.state = 'paid'; visit.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', jobId: visit.id, kind: 'deposit', status: 'PAID', total: '50.00', due: '0.00' }
  applyStatus(ws, 'DEP', 'PARTIALLY_REFUNDED', now, { paid: '50.00', refunded: '10.00', due: '0.00' })
  expect(visit.state).toBe('paid')
})
it('R3 item 7 keeps the thirty second guard and stops on blur', async () => {
  vi.useFakeTimers()
  const controls = talkControls(), stop = vi.fn(async () => new Blob(['audio']))
  startRecording.mockReset().mockResolvedValue({ stop, seconds: () => 30, cancel: vi.fn() })
  try {
    await controls.handlers.keydown({ key: ' ', preventDefault() {}, repeat: false })
    await vi.advanceTimersByTimeAsync(200)
    expect(stop).toHaveBeenCalledOnce()
    await controls.handlers.keyup({ key: ' ', preventDefault() {} })
    expect(stop).toHaveBeenCalledOnce()
    await controls.handlers.keydown({ key: 'Enter', preventDefault() {}, repeat: false })
    await controls.handlers.blur()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
})
it('follow-up uses the spoken two hour duration when the model passes one hour', async () => {
  const { tools } = createTools(workspace(), { now, transcript: 'Book Maria for two hours next week' })
  const result = await tools.find_slots({ duration_hours: 1 })
  expect(result.error).toBeUndefined()
  expect(result.slots.length).toBeGreaterThan(0)
  expect(result.slots.every(s => Date.parse(s.end) - Date.parse(s.start) === 7200000)).toBe(true)
})
it('follow-up invoice adds the priced callout when labour is selected without it', () => {
  const baseLines = [
    { id: 'lab', kind: 'labour', quantity: '2' },
    { id: 'part', kind: 'part', description: 'Part', cost: '30.00', unitAmount: '30.00' },
    { id: 'call', kind: 'callout', quantity: '1' },
  ]
  const results = (pricedLines) => [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
    { tool: 'price_lines', result: { lines: pricedLines } },
  ]
  const ctx = { transcript: 'Invoice Maria for two hours and a part costing 30 dollars', results: results(baseLines) }
  const result = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['lab', 'part'] }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.proposal.line_ids).toEqual(['lab', 'part', 'call'])
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['lab', 'part'] }, { ...ctx, results: results(baseLines.filter(l => l.kind !== 'callout')) }).ok).toBe(false)
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['lab', 'call', 'call2'] }, { ...ctx, results: results([...baseLines, { id: 'call2', kind: 'callout' }]) }).ok).toBe(false)
})
