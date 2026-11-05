import { beforeEach, expect, it } from 'vitest'
import { seedWorkspace, job } from '../../src/state/workspace.js'
import * as holds from '../../src/state/holds.js'
import { clashes, moveJob, slotLabel } from '../../src/state/schedule.js'
import { applyStatus } from '../../src/state/money.js'
import { createTools } from '../../src/agent/tools.js'
import { createPayPal } from '../../src/paypal/client.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { fakePayPal, ENV } from './fake-paypal.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const slot = { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', label: 'Tue 3 Nov 9:00' }
const workspace = () => seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
const booking = (ws, now = NOW) => holds.placeBooking(ws, { customerId: 'c1', summary: 'Tap', hours: 1, slot, now })
function deposit(ws) {
  const result = booking(ws)
  result.job.state = 'held'
  ws.invoices.DEP = { id: 'DEP', jobId: result.job.id, customerId: 'c1', kind: 'deposit', status: 'SENT', total: '50.00', due: '50.00' }
  holds.startHold(ws, result.job.id, 'DEP', NOW)
  return result
}
function offered(ws) {
  deposit(ws)
  holds.invoiceCancelled(ws, 'DEP', NOW)
  return Object.values(ws.offers)[0]
}
beforeEach(() => resetTokenCache())

it('keeps a demo draft for ten minutes and drops it after thirty minutes', () => {
  const ws = workspace()
  ws.settings.holdMinutes = 2
  const recent = booking(ws, NOW - 10 * 60_000)
  const old = booking(ws, NOW - 31 * 60_000)
  holds.dropStaleDrafts(ws, NOW)
  expect(ws.jobs).toContain(recent.job)
  expect(ws.drafts[recent.draft.id]).toBe(recent.draft)
  expect(ws.jobs).not.toContain(old.job)
  expect(ws.drafts[old.draft.id]).toBeUndefined()
})

it('open_invoices applies a paid read once before the webhook', async () => {
  const ws = workspace()
  ws.invoices.FINAL = { id: 'FINAL', jobId: 'j2', customerId: 'c1', kind: 'invoice', status: 'SENT', total: '100.00', due: '100.00' }
  const pp = fakePayPal({ 'GET /v2/invoicing/invoices/FINAL': [{ status: 200, body: { id: 'FINAL', status: 'PAID', amount: { value: '100.00' }, due_amount: { value: '0.00' }, payments: { paid_amount: { value: '105.00' } }, gratuity: { value: '5.00' } } }] })
  const api = createPayPal(ENV, { fetch: pp.fetch })
  const { tools } = createTools(ws, { transcript: '', now: NOW, api })
  expect((await tools.open_invoices({})).invoices).toEqual([])
  expect(job(ws, 'j2').state).toBe('paid')
  expect(applyStatus(ws, 'FINAL', 'PAID', NOW + 1)).toBe(false)
  expect(ws.notices.filter((n) => n.kind === 'paid' && n.invoiceId === 'FINAL')).toHaveLength(1)
  expect(ws.invoices.FINAL).toMatchObject({ paidBy: 'status poll', paid: '105.00', tip: '5.00' })
})

it('a booking deposit marks the job booked and records the deposit', () => {
  const ws = workspace()
  const { job: j } = deposit(ws)
  applyStatus(ws, 'DEP', 'PAID', NOW)
  expect(j).toMatchObject({ state: 'booked', depositPaid: true, depositInvoiceId: 'DEP' })
})

it('a deposit paid booking becomes paid only after its final invoice is paid', () => {
  const ws = workspace()
  const { job: j } = deposit(ws)
  applyStatus(ws, 'DEP', 'PAID', NOW)
  expect(j.state).toBe('booked')
  expect(moveJob(ws, j.id, '2026-11-03T11:00:00Z', NOW).ok).toBe(true)
  ws.invoices.FINAL = { id: 'FINAL', jobId: j.id, customerId: 'c1', kind: 'invoice', status: 'SENT', total: '100.00' }
  applyStatus(ws, 'FINAL', 'PAID', NOW + 1)
  expect(j.state).toBe('paid')
  expect(j.depositPaid).toBe(true)
})

it('an unsent booking draft does not block its slot', () => {
  const ws = workspace()
  const { job: j } = booking(ws)
  expect(clashes(ws, slot.start, slot.end)).toEqual([])
  expect(j).toMatchObject({ state: 'draft', draftedAt: NOW })
})

it('dropStaleDrafts removes only old unsent booking jobs and their drafts', () => {
  const ws = workspace()
  const old = booking(ws, NOW - 31 * 60000)
  old.draft.invoiceId = 'UNSENT'
  const recent = booking(ws, NOW - 60000)
  const sent = booking(ws, NOW - 31 * 60000)
  sent.draft.sentAt = NOW - 60000
  holds.dropStaleDrafts(ws, NOW)
  expect(ws.jobs).not.toContain(old.job)
  expect(ws.drafts[old.draft.id]).toBeUndefined()
  expect(ws.jobs).toEqual(expect.arrayContaining([recent.job, sent.job]))
  expect(ws.drafts[recent.draft.id]).toBe(recent.draft)
  expect(ws.drafts[sent.draft.id]).toBe(sent.draft)
})

it('sendDeposit refuses a newly occupied slot before creating an invoice', async () => {
  const ws = workspace()
  const { draft } = booking(ws)
  ws.jobs.push({ id: 'taken', state: 'booked', ...slot })
  const pp = fakePayPal()
  const api = createPayPal(ENV, { fetch: pp.fetch })
  await expect(holds.sendDeposit(ws, draft.id, { api, env: ENV, now: NOW })).rejects.toMatchObject({ code: 'CLASH', status: 409, message: 'That slot was taken. Ask for another time.' })
  expect(pp.calls).toEqual([])
})

it('moving an offered job updates its offer and deposit draft together', () => {
  const ws = workspace()
  const offer = offered(ws)
  const start = '2026-11-03T11:00:00.000Z'
  expect(moveJob(ws, offer.jobId, start, NOW).ok).toBe(true)
  const j = job(ws, offer.jobId)
  expect(offer.start).toBe(j.start)
  expect(offer.end).toBe(j.end)
  expect(ws.drafts[offer.draftId].summary).toBe(`Deposit to hold ${slotLabel(ws, start)}`)
  const before = structuredClone(offer)
  ws.jobs.push({ id: 'taken', state: 'booked', start: '2026-11-03T12:00:00Z', end: '2026-11-03T13:00:00Z' })
  expect(moveJob(ws, offer.jobId, '2026-11-03T12:00:00Z', NOW).ok).toBe(false)
  expect(offer).toEqual(before)
})

it('declineOffer returns the job to waiting and offers the slot to the next fitting job', () => {
  const ws = workspace()
  const offer = offered(ws)
  ws.jobs.push({ id: 'next', customerId: 'c2', summary: 'Next tap', hours: 1, state: 'waiting', start: '', end: '' })
  ws.waiting.push('next')
  holds.declineOffer(ws, offer.id, NOW)
  expect(job(ws, offer.jobId)).toMatchObject({ state: 'waiting', start: '', end: '' })
  expect(ws.waiting.at(-1)).toBe(offer.jobId)
  expect(ws.offers[offer.id]).toBeUndefined()
  expect(ws.drafts[offer.draftId]).toBeUndefined()
  expect(Object.values(ws.offers)).toEqual([expect.objectContaining({ jobId: 'next', start: slot.start, end: slot.end })])
  expect(ws.notices.some((n) => n.text === `Priya Nair passed on ${slot.label}.`)).toBe(true)
})
