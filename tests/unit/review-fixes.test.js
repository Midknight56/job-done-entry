import { it, expect } from 'vitest'
import { seedWorkspace } from '../../src/state/workspace.js'
import { applyStatus } from '../../src/state/money.js'
import { jobWords } from '../../public/job-words.js'
const now = Date.parse('2026-11-05T10:00:00Z')
const workspace = () => seedWorkspace({ id: 'regression', now, tzOffsetMinutes: 0 })
it('R1 clears a refunded deposit and reconciles calendar payment states', () => {
  const ws = workspace(), j = ws.jobs[0]
  j.state = 'booked'; j.depositPaid = true; j.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: j.id, status: 'PAID', total: '50.00', due: '0.00' }
  applyStatus(ws, 'DEP', 'REFUNDED', now)
  expect(j.depositPaid).toBe(false)
  expect(jobWords(j, { ...ws, now }).words).toBe('Deposit refunded')
  ws.invoices.BILL = { id: 'BILL', jobId: j.id, status: 'SENT', total: '100.00' }; j.invoiceId = 'BILL'
  applyStatus(ws, 'BILL', 'PARTIALLY_PAID', now, { paid: '20.00', due: '80.00' })
  expect(jobWords(j, { ...ws, now }).words).toBe('Part paid, 80.00 left')
  applyStatus(ws, 'BILL', 'CANCELLED', now)
  expect(jobWords(j, { ...ws, now }).words).toBe('Invoice cancelled')
})
import { vi } from 'vitest'
import { setupTalk } from '../../public/talk.js'
import { startRecording } from '../../public/recorder.js'
vi.mock('../../public/recorder.js', () => ({ startRecording: vi.fn() }))
it('R2 cancels permission granted after release and prevents overlapping startups', async () => {
  const events = {}, button = { addEventListener: (n, f) => { events[n] = f }, setPointerCapture() {}, classList: { add() {}, remove() {} } }
  const text = {}, timer = {}
  vi.stubGlobal('document', { querySelector: (s) => s === '#talk' ? button : s === '#say' ? text : timer })
  const grants = []
  startRecording.mockImplementation(() => new Promise((resolve) => { grants.push(resolve) }))
  const cancel = vi.fn(), stop = vi.fn(), request = vi.fn()
  setupTalk({ request, submitText: vi.fn(), showError: vi.fn() })
  const first = events.pointerdown({ preventDefault() {}, pointerId: 1 })
  const second = events.pointerdown({ preventDefault() {}, pointerId: 2 })
  await events.pointerup()
  for (const grant of grants) grant({ cancel, stop, seconds: () => 1 })
  await Promise.all([first, second])
  expect(cancel).toHaveBeenCalledOnce()
  expect(startRecording).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
it('R3 recovers from calendar initialization failure and offers a working retry', async () => {
  const source = readFileSync('public/app.js', 'utf8')
  const code = source.slice(source.indexOf('async function makeCalendar'), source.indexOf('/** Draws the calendar'))
    .replace(/import\(`\.\/calendar\.js\?attempt=\$\{\+\+attempt\}`\)/g, 'loadBryntum()').replaceAll("import('./fallback-calendar.js')", 'loadFallback()')
  const fallback = { render() {}, destroy: vi.fn() }, real = { render() {} }
  const create = vi.fn().mockRejectedValueOnce(new Error('module fetch failed')).mockResolvedValue(real)
  const fallbackCreate = vi.fn(() => fallback), host = { replaceChildren: vi.fn(), prepend: vi.fn(), append: vi.fn() }, elements = []
  const context = vm.createContext({ URLSearchParams, location: { search: '' }, calendarHost: host,
    loadBryntum: async () => ({ bryntumAvailable: async () => true, createCalendar: create }),
    loadFallback: async () => ({ createCalendar: fallbackCreate }),
    document: { createElement: () => { const el = { append() {}, remove() {} }; elements.push(el); return el } } })
  vm.runInContext(code, context)
  const made = await context.makeCalendar({})
  expect(fallbackCreate).toHaveBeenCalledOnce()
  expect(elements.some((el) => el.textContent === 'Retry calendar')).toBe(true)
  expect(made).toBeTruthy()
  made.render({ jobs: [] })
  await elements.find((el) => el.textContent === 'Retry calendar').onclick()
  expect(create).toHaveBeenCalledTimes(2)
  expect(fallback.destroy).toHaveBeenCalledOnce()
})
import { updateWaiting } from '../../src/state/waiting.js'
function fakeElement(tag, elements) {
  const el = { tag, children: [], dataset: {}, textContent: '', setAttribute() {},
    append(...items) { this.children.push(...items) },
    querySelector(s) { return s === 'button' ? (this.button ||= fakeElement('button', elements)) : null },
    querySelectorAll(s) { return s === 'input, select' ? (this.controls ||= ['customerId', 'summary', 'hours', 'free'].map((name) => ({ name }))) : [] } }
  elements.push(el); return el
}
it('R4 edits availability through the waiting form without changing queue identity or order', async () => {
  const ws = workspace(), order = [...ws.waiting], id = order[0], j = ws.jobs.find((j) => j.id === id)
  j.free = 'mornings'
  const elements = [], source = readFileSync('public/app.js', 'utf8')
  const code = source.slice(source.indexOf('function renderWaiting()'), source.indexOf('/** Lists unpaid invoices'))
  const context = vm.createContext({ state: { ws }, document: { createElement: (tag) => fakeElement(tag, elements) },
    screen: fakeElement('screen', elements), esc: (s) => s, busyKeys: new Set(), waitingFields: { customerId: '', summary: '', hours: '1', free: 'any' }, waitingError: '', waitingEditId: null,
    post: async (path, fields) => { expect(path).toBe(`/api/waiting/${id}`); updateWaiting(ws, id, fields); return { state: { ws } } }, setState() {}, render() {}, encodeURIComponent })
  vm.runInContext(code, context); context.renderWaiting()
  const edit = elements.find((e) => e.textContent === 'Edit')
  expect(edit).toBeTruthy()
  edit.onclick(); elements.length = 0; context.renderWaiting()
  const form = elements.find((e) => e.tag === 'form')
  const free = form.querySelectorAll('input, select').find((e) => e.name === 'free')
  expect(free.value).toBe('mornings')
  free.value = 'afternoons'; free.onchange()
  await form.onsubmit({ preventDefault() {} })
  expect(j.free).toBe('afternoons'); expect(ws.waiting).toEqual(order); expect(j.id).toBe(id)
})
import { moveJob } from '../../src/state/schedule.js'
import { acceptOffer } from '../../src/state/holds.js'
it('R5 rejects unavailable offer moves and acceptance before requesting money', async () => {
  const ws = workspace(), j = ws.jobs.find((j) => j.id === 'j5')
  Object.assign(j, { state: 'offered', free: 'mornings', start: '2026-11-10T09:00:00Z', end: '2026-11-10T10:00:00Z' })
  ws.offers.o1 = { id: 'o1', jobId: j.id, draftId: 'd1', start: j.start, end: j.end, reason: 'free Tue mornings' }
  ws.drafts.d1 = { id: 'd1', kind: 'deposit', jobId: j.id }
  expect(moveJob(ws, j.id, '2026-11-11T14:00:00Z', now).ok).toBe(false)
  expect(moveJob(ws, j.id, '2026-11-11T09:00:00Z', now).ok).toBe(true)
  expect(ws.offers.o1.reason).toContain('Wed mornings')
  j.free = 'afternoons'
  const request = vi.fn()
  await expect(acceptOffer(ws, 'o1', { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'AVAILABILITY' })
  expect(request).not.toHaveBeenCalled()
})
import { createTools } from '../../src/agent/tools.js'
it('R6 derives next week from the request rather than model date bounds', async () => {
  const ws = workspace()
  const { tools } = createTools(ws, { now, transcript: 'Book Maria next week' })
  const result = await tools.find_slots({ duration_hours: 1, after: '2026-11-06', before: '2026-11-06' })
  expect(result.slots.length).toBeGreaterThan(0)
  expect(result.slots.every((s) => s.start >= '2026-11-09' && s.end < '2026-11-16')).toBe(true)
})
it('R6 asks for a date when the request is ambiguous', async () => {
  const { tools } = createTools(workspace(), { now, transcript: 'Book Maria sometime soon' })
  const result = await tools.find_slots({ after: '2026-11-06' })
  expect(result.slots).toEqual([])
  expect(result.needsDate).toBe(true)
})
import { proposeInvoiceDraft, sendDraft } from '../../src/flows/send.js'
import { priceLines } from '../../src/pricing/ratecard.js'
it('R7 credits a paid deposit once and rejects stale credit after a refund', async () => {
  const ws = workspace(), j = ws.jobs[0]
  j.depositPaid = true; j.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', kind: 'deposit', jobId: j.id, status: 'PAID', total: '50.00' }
  const priced = priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1 }], ws.settings.rateCard)
  const draft = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  expect(draft.priced.total).toBe((Number(priced.total) - 50).toFixed(2))
  expect(draft.priced.jobTotal).toBe(priced.total)
  expect(draft.priced.depositCredit).toBe('50.00')
  applyStatus(ws, 'DEP', 'REFUNDED', now)
  const request = vi.fn()
  await expect(sendDraft(ws, draft.id, { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'BALANCE_CHANGED' })
  expect(request).not.toHaveBeenCalled()
  ws.invoices.DEP.status = 'PAID'
  ws.invoices.EXISTING = { id: 'EXISTING', kind: 'invoice', jobId: j.id, status: 'SENT' }
  await expect(sendDraft(ws, draft.id, { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'ALREADY_INVOICED' })
})
import { runTurn } from '../../src/agent/loop.js'
import * as sending from '../../src/flows/send.js'
it('R8 requires a confirmed visit and creates an explicitly timed completed visit for new work', async () => {
  const ws = workspace()
  ws.customers.push({ id: 'tom', name: 'Tom Baker', given: 'Tom', surname: 'Baker', email: 'tom@example.com' })
  const replies = [
    { calls: [{ tool: 'find_customer', args: { name: 'Tom' } }, { tool: 'price_lines', args: { lines: [{ kind: 'labour', hours: 1 }] } }] },
    { final: { kind: 'invoice', customer_id: 'tom', line_ids: ['p1', 'p2'], summary: 'Tap repair' } }
  ]
  const result = await runTurn(ws, 'Invoice Tom for one hour of tap repair', { now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }) })
  expect(result.proposal.needsVisit).toBe(true)
  const draft = ws.drafts[result.proposal.draftId]
  const visit = sending.confirmInvoiceVisit(ws, draft.id, { start: '2026-11-05T08:00:00Z', end: '2026-11-05T09:00:00Z' }, now)
  expect(visit.state).toBe('completed')
  expect(draft.jobId).toBe(visit.id)
  expect(visit.customerId).toBe('tom')
  ws.invoices.BILL = { id: 'BILL', kind: 'invoice', jobId: visit.id, status: 'SENT', total: draft.priced.total }; visit.invoiceId = 'BILL'
  applyStatus(ws, 'BILL', 'PAID', now)
  expect(visit.state).toBe('paid')
})
import { paymentState } from '../../public/payment-state.js'
it.each([
  ['REFUNDED', 'Refunded', true], ['CANCELLED', 'Invoice cancelled', true],
  ['PARTIALLY_PAID', 'Part paid, 40.00 left', false], ['PAID_EXTERNAL', 'Paid', true]
])('R1 shares %s labels in payment views and hides closed payment controls', (status, label, closed) => {
  expect(paymentState({ status, due: '40.00' })).toMatchObject({ label, closed })
  const source = readFileSync('public/customer.js', 'utf8').replace(/^import [^\n]*\n/, '').replace(/updateInvoice\(\)\s*setInterval\(updateInvoice, 3000\)/, '')
  const nodes = Object.fromEntries(['#business', '#amount', '#qr', '#shared', '#status', '#payment-help'].map((key) => [key, { dataset: {} }]))
  const context = vm.createContext({ paymentState, URLSearchParams, location: { search: '?inv=BILL' }, document: { querySelector: (s) => nodes[s] }, fetch: async () => ({ ok: true, json: async () => ({ ws: { settings: { business: 'Demo' }, invoices: { BILL: { status, total: '100.00', due: '40.00', hasQr: true, shared: false } } } }) }) })
  vm.runInContext(source, context)
  return context.updateInvoice().then(() => {
    expect(nodes['#status'].textContent).toBe(label)
    expect(nodes['#qr'].hidden).toBe(closed)
    expect(nodes['#payment-help'].hidden).toBe(closed)
  })
})
it('R7 sends only the balance and keeps its deposit reference through retries', async () => {
  const ws = workspace(), j = ws.jobs[0]
  j.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', jobId: j.id, kind: 'deposit', status: 'PAID', total: '50.00' }
  const priced = priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1 }], ws.settings.rateCard)
  const draft = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  let body
  const request = vi.fn(async (call) => {
    if (call.path === '/v2/invoicing/invoices') { body = call.body; return { ok: true, status: 201, json: { id: 'INV2-BALANCE' } } }
    if (call.path.endsWith('/send')) return { ok: true, json: {} }
    if (call.path.endsWith('/generate-qr-code')) return { ok: true, text: '' }
    return { ok: true, json: { id: 'INV2-BALANCE', status: 'SENT', amount: { value: '90.40' }, due_amount: { value: '90.40' } } }
  })
  await sendDraft(ws, draft.id, { api: { request }, env: {}, now })
  expect(body.items).toEqual([{ name: 'Remaining job balance', quantity: '1', unit_amount: { currency_code: priced.currency, value: '90.40' }, unit_of_measure: 'AMOUNT' }])
  expect(body.detail.note).toContain('Job price 140.40. Paid deposit 50.00. Balance 90.40.')
  expect(ws.invoices['INV2-BALANCE']).toMatchObject({ total: '90.40', depositCredit: '50.00', depositInvoiceId: 'DEP', jobId: j.id })
  const calls = request.mock.calls.length
  await sendDraft(ws, draft.id, { api: { request }, env: {}, now })
  expect(request).toHaveBeenCalledTimes(calls)
  const duplicate = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  await expect(sendDraft(ws, duplicate.id, { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'ALREADY_INVOICED' })
  applyStatus(ws, 'INV2-BALANCE', 'CANCELLED', now)
  applyStatus(ws, 'DEP', 'REFUNDED', now)
  const fresh = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  expect(fresh.priced.total).toBe('140.40')
  expect(fresh.priced.depositCredit).toBeUndefined()
})
it('R8 rejects missing, unrelated, future and invalid visits without changing the workspace', async () => {
  const ws = workspace(), priced = priceLines([{ kind: 'callout' }], ws.settings.rateCard)
  const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced, summary: 'Repair' })
  draft.requiresVisit = true
  const before = structuredClone(ws)
  for (const fields of [{ jobId: 'j1' }, { jobId: 'missing' }, { start: 'bad', end: 'bad' }, { start: '2026-11-05T08:00:00Z', end: '2026-11-06T09:00:00Z' }]) {
    expect(() => sending.confirmInvoiceVisit(ws, draft.id, fields, now)).toThrow(expect.objectContaining({ code: 'VISIT' }))
    expect(ws).toEqual(before)
  }
  const request = vi.fn()
  await expect(sendDraft(ws, draft.id, { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'VISIT_REQUIRED' })
  expect(request).not.toHaveBeenCalled()
  const visit = sending.confirmInvoiceVisit(ws, draft.id, { jobId: 'j2' }, now)
  expect(visit.id).toBe('j2')
  expect(draft.jobId).toBe('j2')
  expect(sending.confirmInvoiceVisit(ws, draft.id, { start: 'bad' }, now).id).toBe('j2')
})
it.each(['Book Maria next week Monday', 'Book Maria tomorrow at 3pm', 'Book Maria 2026-02-30', 'Book Maria today or tomorrow'])('R6 asks for a choice rather than ignoring qualifiers in %s', async (transcript) => {
  const { tools } = createTools(workspace(), { now, transcript })
  expect(await tools.find_slots({ after: '2026-11-06' })).toEqual({ slots: [], needsDate: true })
})
it('R6 keeps an explicit date and morning preference in the workspace time zone', async () => {
  const ws = workspace(); ws.tz = -240
  const { tools } = createTools(ws, { now, transcript: 'Book Maria 2026-11-10 in the morning' })
  const { slots } = await tools.find_slots({ after: '2026-11-06', before: '2026-11-06' })
  expect(slots.length).toBeGreaterThan(0)
  expect(slots.every((s) => s.start >= '2026-11-10T12:00:00' && s.end <= '2026-11-10T16:00:00.000Z')).toBe(true)
})
it.each(['REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'PAID_EXTERNAL'])('R1 shows %s in the sheet without fetching QR or offering payment', async (status) => {
  const elements = []
  const element = () => {
    const el = { dataset: {}, children: [], classList: { add() {} }, append(...nodes) { this.children.push(...nodes) }, replaceChildren() { this.children = [] } }
    elements.push(el); return el
  }
  const sheet = element(), request = vi.fn()
  const context = vm.createContext({ paymentState, URL, document: { querySelector: () => sheet, createElement: element, addEventListener() {}, removeEventListener() {}, activeElement: { focus() {} } } })
  const code = readFileSync('public/sheet.js', 'utf8').replace(/^import [^\n]*\n/, '').replaceAll('export ', '')
  vm.runInContext(code, context)
  await context.openInvoiceSheet('BILL', { ws: { settings: { business: 'Demo' }, customers: [], invoices: { BILL: { status, hasQr: true, total: '100.00', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/BILL' } } } }, request)
  expect(sheet.hidden).toBe(false)
  expect(elements.filter((el) => el.className === 'pay-status').at(-1).textContent).toBe(paymentState({ status }).label)
  expect(elements.some((el) => el.className === 'qr-card' || el.className === 'pay-links')).toBe(false)
  expect(request).not.toHaveBeenCalled()
})
import worker from '../../src/worker.js'
import { memoryKV } from './memory-kv.js'
it('R8 confirms an existing visit through the capped server route with no external calls', async () => {
  const ws = workspace(), kv = memoryKV()
  const draft = proposeInvoiceDraft(ws, { customerId: 'c1', priced: priceLines([{ kind: 'callout' }], ws.settings.rateCard), summary: 'Tap' })
  draft.requiresVisit = true
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws))
  const fetch = vi.fn(() => { throw new Error('External calls are forbidden') })
  vi.stubGlobal('fetch', fetch)
  try {
    const res = await worker.fetch(new Request(`https://job-done.test/api/drafts/${draft.id}/visit`, { method: 'POST', headers: { cookie: `jd_ws=${ws.id}`, 'cf-connecting-ip': '203.0.113.77', 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'j2' }) }), { JOBDONE: kv }, { waitUntil() {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ draft: { jobId: 'j2' }, visit: { id: 'j2', customerId: 'c1' } })
    expect(JSON.parse(await kv.get(`ws:${ws.id}`)).drafts[draft.id].jobId).toBe('j2')
    expect(fetch).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
it('R7 prevents two simultaneous drafts from applying the same deposit', async () => {
  const ws = workspace(), j = ws.jobs[0]
  j.depositInvoiceId = 'DEP'
  ws.invoices.DEP = { id: 'DEP', jobId: j.id, kind: 'deposit', status: 'PAID', total: '50.00' }
  const priced = priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1 }], ws.settings.rateCard)
  const first = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  const second = proposeInvoiceDraft(ws, { customerId: j.customerId, jobId: j.id, summary: j.summary, priced })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const request = vi.fn(async () => { await gate; throw new Error('Local test stops before creating money') })
  const attempt = sendDraft(ws, first.id, { api: { request }, env: {}, now }).catch((e) => e.message)
  await expect(sendDraft(ws, second.id, { api: { request }, env: {}, now })).rejects.toMatchObject({ code: 'ALREADY_INVOICED' })
  expect(request).toHaveBeenCalledOnce()
  release(); await attempt
  expect(first.sending).toBeUndefined()
})
it('R2 cancels a recorder granted after pointer cancellation without submitting it', async () => {
  startRecording.mockReset()
  const events = {}, button = { addEventListener: (n, f) => { events[n] = f }, setPointerCapture() {}, classList: { add() {}, remove() {} } }
  vi.stubGlobal('document', { querySelector: (s) => s === '#talk' ? button : {} })
  let grant
  startRecording.mockImplementation(() => new Promise((resolve) => { grant = resolve }))
  const cancel = vi.fn(), request = vi.fn()
  setupTalk({ request, submitText: vi.fn(), showError: vi.fn() })
  const pending = events.pointerdown({ preventDefault() {}, pointerId: 1 })
  events.pointercancel()
  grant({ cancel, seconds: () => 1 })
  await pending
  expect(cancel).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
