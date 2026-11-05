import { expect, it, vi, afterEach } from 'vitest'
import * as flows from '../../src/flows/send.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { priceLines } from '../../src/pricing/ratecard.js'
import worker from '../../src/worker.js'
import { memoryKV } from './memory-kv.js'
import { renderProposal } from '../../public/cards.js'
import { jobWords } from '../../public/job-words.js'
import { openInvoiceSheet } from '../../public/sheet.js'
import { resetTokenCache } from '../../src/paypal/token.js'

const now = Date.parse('2026-11-05T14:00:00Z')
afterEach(() => { vi.unstubAllGlobals(); resetTokenCache() })

function setup(total = '50.00') {
  const ws = seedWorkspace({ id: 'settle6', now, tzOffsetMinutes: 0 })
  const visit = ws.jobs.find(j => j.id === 'j1')
  Object.assign(visit, { state: 'booked', depositPaid: true, depositInvoiceId: 'DEP6' })
  ws.invoices.DEP6 = { id: 'DEP6', customerId: visit.customerId, jobId: visit.id, kind: 'deposit', status: 'PAID', total, due: '0.00' }
  const draft = flows.proposeInvoiceDraft(ws, { customerId: visit.customerId, jobId: visit.id, summary: 'Call out', priced: priceLines([{ kind: 'callout' }], ws.settings.rateCard) })
  const api = { request: vi.fn(async () => ({ ok: true, json: { id: 'DEP6', status: 'PAID', amount: { value: total, currency_code: 'USD' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: total } } } })) }
  return { ws, visit, draft, api }
}

it('R6 item 3 shows the full deposit, applied credit and unresolved surplus', () => {
  const { draft } = setup()
  expect(draft.priced).toMatchObject({ total: '0.00', jobTotal: '48.60', depositTotal: '50.00', depositCredit: '48.60', depositSurplus: '1.40' })
})

it.each(['50.00', '48.60'])('R6 item 3 completes a fully covered bill with deposit %s and one linked receipt', async total => {
  const { ws, visit, draft, api } = setup(total)
  expect(flows.completeDraft).toBeTypeOf('function')
  const result = await flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })
  expect(result.settlement).toMatchObject({ jobId: visit.id, draftId: draft.id, depositInvoiceId: 'DEP6', depositTotal: total, depositCredit: '48.60', due: '0.00', depositSurplus: total === '50.00' ? '1.40' : '0.00', resolution: total === '50.00' ? 'required' : 'none' })
  expect(ws.settlements[result.settlement.id]).toEqual(result.settlement)
  expect(visit).toMatchObject({ state: 'paid', settlementId: result.settlement.id })
  expect(ws.invoices.DEP6.status).toBe('PAID')
  expect(Object.keys(ws.invoices)).toEqual(['DEP6'])
  expect(api.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true)
  expect(await flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now: now + 100 })).toEqual(result)
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(Object.keys(ws.settlements)).toHaveLength(1)
})

it('R6 item 3 requires confirmation before reading or completing', async () => {
  const { ws, draft, api } = setup(), before = structuredClone(ws)
  expect(flows.completeDraft).toBeTypeOf('function')
  await expect(flows.completeDraft(ws, draft.id, {}, { api, now })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  expect(ws).toEqual(before)
  expect(api.request).not.toHaveBeenCalled()
})

it('R6 item 3 rejects a stale draft after a refund changes available credit', async () => {
  const { ws, draft, api } = setup(), before = structuredClone(ws)
  api.request.mockResolvedValue({ ok: true, json: { id: 'DEP6', status: 'PARTIALLY_REFUNDED', amount: { value: '50.00', currency_code: 'USD' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '50.00' } }, refunds: { refund_amount: { value: '10.00' } } } })
  await expect(flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })).rejects.toMatchObject({ code: 'BALANCE_CHANGED' })
  expect(ws).toEqual(before)
})

it('R6 item 3 completes using a known retained deposit after a partial refund', async () => {
  const { ws, visit, api } = setup()
  Object.assign(ws.invoices.DEP6, { total: '60.00', status: 'PARTIALLY_REFUNDED', paid: '60.00', refunded: '10.00' })
  const draft = flows.proposeInvoiceDraft(ws, { customerId: visit.customerId, jobId: visit.id, summary: 'Work', priced: priceLines([{ kind: 'callout' }], ws.settings.rateCard) })
  api.request.mockResolvedValue({ ok: true, json: { id: 'DEP6', status: 'PARTIALLY_REFUNDED', amount: { value: '60.00', currency_code: 'USD' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '60.00' } }, refunds: { refund_amount: { value: '10.00' } } } })
  const { settlement } = await flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })
  expect(settlement).toMatchObject({ depositTotal: '60.00', depositRetained: '50.00', depositCredit: '48.60', depositSurplus: '1.40' })
})

it('R6 item 3 prevents another draft from using a completed visit again', async () => {
  const { ws, draft, visit, api } = setup()
  const other = flows.proposeInvoiceDraft(ws, { customerId: visit.customerId, jobId: visit.id, summary: 'Duplicate', priced: priceLines([{ kind: 'callout' }], ws.settings.rateCard) })
  await flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })
  await expect(flows.completeDraft(ws, other.id, { confirmed: true }, { api, now })).rejects.toMatchObject({ code: 'ALREADY_SETTLED' })
  await expect(flows.sendDraft(ws, other.id, { api, env: {}, now })).rejects.toMatchObject({ code: 'ALREADY_SETTLED' })
  expect(api.request).toHaveBeenCalledTimes(1)
})

it('R6 item 3 keeps a positive balance payable and does not complete it', async () => {
  const { ws, draft, api } = setup('40.00'), before = structuredClone(ws)
  expect(draft.priced.total).toBe('8.60')
  await expect(flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })).rejects.toMatchObject({ code: 'NO_COVER' })
  expect(ws).toEqual(before)
  expect(api.request).not.toHaveBeenCalled()
})

it.each(['unavailable', 'REFUNDED', 'PARTIALLY_REFUNDED', 'SENT', 'missing amount'])('R6 item 3 leaves uncertain deposit unresolved: %s', async status => {
  const { ws, draft, api } = setup(), before = structuredClone(ws)
  api.request.mockResolvedValue({ ok: status !== 'unavailable', status: 503, json: { id: 'DEP6', status, amount: status === 'missing amount' ? undefined : { value: '50.00', currency_code: 'USD' }, due_amount: { value: '0.00' } } })
  expect(flows.completeDraft).toBeTypeOf('function')
  await expect(flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })).rejects.toThrow()
  expect(ws).toEqual(before)
})

it('R6 item 3 persists completion through its own route without an invoice allowance or invoice write', async () => {
  const { ws, draft } = setup(), kv = memoryKV()
  await kv.put('ws:settle6', JSON.stringify(ws))
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/oauth2/token') ? { access_token: 'test', expires_in: 100 } : { id: 'DEP6', status: 'PAID', amount: { value: '50.00', currency_code: 'USD' }, due_amount: { value: '0.00' } }), { headers: { 'content-type': 'application/json' } })))
  const response = await worker.fetch(new Request(`https://job-done.test/api/drafts/${draft.id}/complete`, { method: 'POST', headers: { cookie: 'jd_ws=settle6', 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) }), { JOBDONE: kv, PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test' }, { waitUntil() {} })
  expect(response.status).toBe(200)
  const body = await response.json(), saved = JSON.parse(await kv.get('ws:settle6'))
  expect(saved.jobs.find(j => j.id === 'j1')).toMatchObject({ state: 'paid', settlementId: body.settlement.id })
  expect(saved.settlements[body.settlement.id].depositSurplus).toBe('1.40')
  expect(JSON.parse(await kv.get(`cap:day:${new Date().toISOString().slice(0, 10)}`)).invoices || 0).toBe(0)
})

it('R6 item 3 offers Complete job only after explicit confirmation', async () => {
  const { ws, draft } = setup(), controls = new Map()
  const element = tag => ({ tag, dataset: {}, classList: { contains: () => false }, append() {}, before() {}, after() {}, getAttribute: () => null,
    querySelector: key => { if (!controls.has(key)) controls.set(key, element(key)); return controls.get(key) }, querySelectorAll: () => [],
  })
  vi.stubGlobal('document', { createElement: element })
  const post = vi.fn(async () => ({}))
  const card = renderProposal({ kind: 'invoice', draftId: draft.id, jobId: 'j1', customer: 'Maria', priced: draft.priced }, { state: { now, ws }, money: String, esc: String, post, onDone() {}, onError(error) { throw error } })
  expect(card.innerHTML).toContain('Complete job')
  expect(card.innerHTML).toContain('Surplus to resolve')
  const button = controls.get('.primary')
  expect(button.disabled).toBe(true)
  const confirmation = controls.get('[name="completeConfirmed"]')
  expect(confirmation).toBeDefined()
  confirmation.checked = true
  confirmation.onchange()
  expect(button.disabled).toBe(false)
  await button.onclick()
  expect(post).toHaveBeenCalledWith(`/api/drafts/${draft.id}/complete`, { confirmed: true })
})

it('R6 item 3 shows a saved receipt and calendar state without a payment link', async () => {
  const { ws, draft, visit, api } = setup()
  const { settlement } = await flows.completeDraft(ws, draft.id, { confirmed: true }, { api, now })
  expect(jobWords(visit, { ...ws, now })).toMatchObject({ state: 'paid', words: 'Complete, paid by deposit', amount: 'Applied 48.60. Surplus 1.40 needs resolution' })
  const children = []
  const sheet = { hidden: true, dataset: {}, replaceChildren() { children.length = 0 }, append: element => children.push(element) }
  vi.stubGlobal('document', { activeElement: { focus() {} }, querySelector: () => sheet, addEventListener() {}, removeEventListener() {}, createElement: tag => ({ tag }) })
  const request = vi.fn()
  await openInvoiceSheet(settlement.id, { ws }, request)
  expect(children.map(element => element.textContent)).toEqual(expect.arrayContaining(['Job complete', 'Deposit invoice DEP6', 'Paid deposit 50.00', 'Applied credit 48.60', 'Surplus to resolve 1.40', 'Remaining balance 0.00']))
  expect(children.some(element => element.tag === 'a' || element.tag === 'img')).toBe(false)
  expect(request).not.toHaveBeenCalled()
  children.find(element => element.textContent === 'Close').onclick()
})
