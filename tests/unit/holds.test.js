import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { seedWorkspace, job } from '../../src/state/workspace.js'
import { findSlots, clashes, moveJob } from '../../src/state/schedule.js'
import { placeBooking, sendDeposit, releaseExpired, depositPaid, invoiceCancelled, acceptOffer } from '../../src/state/holds.js'
import { fakePayPal } from './fake-paypal.js'

const ENV = { PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', PAYPAL_BUYER_EMAIL: 'persona-buyer@sandbox.test' }
// Wednesday 28 Oct 2026, 14:00 UTC; the workspace runs on UTC so the hours read plainly.
const NOW = Date.parse('2026-10-28T14:00:00Z')
const MIN = 60_000
const qr = `--b\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgo=\r\n--b--`

/** A sandbox where each new invoice gets the next id from the list and reads back with the given status. */
function sandbox(ids, status = {}) {
  const created = [...ids]
  const s = {
    'POST /v2/invoicing/invoices': created.map((id) => ({ status: 201, body: { href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}` } })),
  }
  for (const id of ids) {
    s[`POST /v2/invoicing/invoices/${id}/send`] = [{ status: 200, body: {} }]
    s[`POST /v2/invoicing/invoices/${id}/generate-qr-code`] = [{ status: 200, body: qr, headers: { 'content-type': 'multipart/form-data; boundary=b' } }]
    s[`POST /v2/invoicing/invoices/${id}/cancel`] = [{ status: 204 }]
    s[`GET /v2/invoicing/invoices/${id}`] = [{ status: 200, body: { id, status: status[id] || 'SENT', amount: { currency_code: 'USD', value: '50.00' }, due_amount: { currency_code: 'USD', value: '50.00' }, detail: { metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } } } }]
  }
  const pp = fakePayPal(s)
  return { pp, api: createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} }), path: (m, p) => pp.calls.filter((c) => c.method === m && c.path === p).length }
}

beforeEach(() => resetTokenCache())

describe('waiting availability when a hold runs out', () => {
  const morning = () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const start = '2026-11-03T09:00:00.000Z'
    const end = '2026-11-03T11:00:00.000Z'
    ws.holds.push({ jobId: 'j1', invoiceId: 'INV2-HOLD', start, end, expiresAt: NOW })
    ws.jobs.push({ id: 'dave', customerId: 'c2', summary: 'Shower job', state: 'waiting', hours: 1, free: 'afternoons', start: '', end: '' })
    Object.assign(job(ws, 'j5'), { free: 'mornings' })
    ws.waiting = ['dave', 'j5']
    return ws
  }
  it('offers the first available fitting job and explains the first skipped customer without sending', async () => {
    const ws = morning()
    const sb = sandbox(['INV2-HOLD'])
    const hold = ws.holds[0]
    hold.expiresAt = NOW - 1
    await releaseExpired(ws, { api: sb.api, now: NOW })
    const offer = Object.values(ws.offers)[0]
    expect(offer.jobId).toBe('j5')
    expect(offer.reason).toBe('Priya was first on the waiting list who fits 1 hour and is free Tue mornings. Dave is not free then.')
    expect(ws.waiting).toEqual(['dave'])
    expect(ws.drafts[offer.draftId].sentAt).toBeUndefined()
    expect(sb.path('POST', '/v2/invoicing/invoices')).toBe(0)
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-HOLD/cancel')).toBe(1)
  })
  it('makes no offer and names the slot when nobody is eligible', () => {
    const ws = morning()
    Object.assign(job(ws, 'j5'), { hours: 3 })
    invoiceCancelled(ws, 'INV2-HOLD', NOW)
    expect(Object.values(ws.offers)).toEqual([])
    expect(Object.values(ws.drafts)).toEqual([])
    expect(ws.waiting).toEqual(['dave', 'j5'])
    expect(ws.notices.at(-1).text).toBe('No one on the waiting list fits Tue 3 Nov 9:00.')
  })
  it('checks the offered job length rather than the whole freed slot', () => {
    const ws = morning()
    ws.waiting = ['j5']
    ws.holds[0].start = '2026-11-03T11:00:00.000Z'
    ws.holds[0].end = '2026-11-03T14:00:00.000Z'
    invoiceCancelled(ws, 'INV2-HOLD', NOW)
    expect(Object.values(ws.offers)[0].reason).toContain('is free Tue mornings.')
    expect(job(ws, 'j5').end).toBe('2026-11-03T12:00:00.000Z')
  })
})

describe('the schedule', () => {
  it('finds free hour slots in working hours, after now, around booked jobs', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const slots = findSlots(ws, { durationHours: 1, after: '2026-10-29T00:00:00Z', before: '2026-10-29T23:59:00Z', now: NOW })
    expect(slots[0]).toMatchObject({ id: 's1', start: '2026-10-29T08:00:00.000Z', end: '2026-10-29T09:00:00.000Z' })
    expect(slots[1]).toMatchObject({ id: 's2', start: '2026-10-29T09:00:00.000Z' })
    // Sam's boiler check holds 10:00 to 12:00 on Thursday.
    expect(slots.some((s) => s.start === '2026-10-29T10:00:00.000Z' || s.start === '2026-10-29T11:00:00.000Z')).toBe(false)
    expect(slots.every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true)
  })

  it('skips the weekend and the past', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const slots = findSlots(ws, { durationHours: 1, after: '2026-10-31T00:00:00Z', now: NOW })
    expect(slots[0].start).toBe('2026-11-02T08:00:00.000Z')
    const today = findSlots(ws, { durationHours: 1, after: '2026-10-28T00:00:00Z', before: '2026-10-28T23:00:00Z', now: NOW })
    expect(today.every((s) => Date.parse(s.start) >= NOW)).toBe(true)
  })

  it('a move into a booked time reports the clash and changes nothing', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const before = job(ws, 'j4').start
    expect(clashes(ws, '2026-10-29T10:30:00Z', '2026-10-29T11:30:00Z').map((j) => j.id)).toEqual(['j3'])
    const r = moveJob(ws, 'j4', '2026-10-29T10:30:00Z', NOW)
    expect(r.ok).toBe(false)
    expect(r.clash.id).toBe('j3')
    expect(job(ws, 'j4').start).toBe(before)
    const ok = moveJob(ws, 'j4', '2026-10-29T14:00:00Z', NOW)
    expect(ok.ok).toBe(true)
    expect(job(ws, 'j4').start).toBe('2026-10-29T14:00:00.000Z')
    expect(job(ws, 'j4').end).toBe('2026-10-29T16:00:00.000Z')
  })
})

describe('holds: the calendar that acts on money', () => {
  async function heldBathroom(sb) {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const slot = findSlots(ws, { durationHours: 1, after: '2026-11-03T00:00:00Z', now: NOW })[1] // Tue 3 Nov 9:00
    const { job: j, draft } = placeBooking(ws, { customerId: 'c1', summary: 'Bathroom tap', hours: 1, slot, now: NOW })
    expect(j.state).toBe('draft')
    expect(draft.kind).toBe('deposit')
    expect(draft.priced.total).toBe('50.00')
    await sendDeposit(ws, draft.id, { api: sb.api, env: ENV, now: NOW })
    return { ws, j, slot }
  }

  it('placing a booking makes a draft for the slot with a 50.00 deposit draft; sending it starts the hold', async () => {
    const sb = sandbox(['INV2-DEP1'])
    const { ws, j } = await heldBathroom(sb)
    expect(ws.holds).toHaveLength(1)
    expect(ws.holds[0]).toMatchObject({ jobId: j.id, invoiceId: 'INV2-DEP1', expiresAt: NOW + 2 * MIN })
    expect(j.depositInvoiceId).toBe('INV2-DEP1')
  })

  it('an expired unpaid hold checks the invoice, cancels it once, frees the slot, moves the first fitting waiting job in and makes an offer', async () => {
    const sb = sandbox(['INV2-DEP1'])
    const { ws, j, slot } = await heldBathroom(sb)
    await releaseExpired(ws, { api: sb.api, now: NOW + 1 * MIN })
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(0)
    const actions = await releaseExpired(ws, { api: sb.api, now: NOW + 3 * MIN })
    expect(actions.length).toBeGreaterThan(0)
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(1)
    expect(j.state).toBe('released')
    const priya = job(ws, 'j5')
    expect(priya).toMatchObject({ state: 'offered', start: slot.start })
    expect(ws.waiting).not.toContain('j5')
    const offers = Object.values(ws.offers)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ jobId: 'j5' })
    expect(offers[0].reason).toBe('Priya was first on the waiting list who fits 1 hour and is free then.')
    expect(ws.notices.some((notice) => notice.text.includes(offers[0].reason))).toBe(true)
    expect(ws.drafts[offers[0].draftId]).toMatchObject({ kind: 'deposit', customerId: 'c4', jobId: 'j5' })
    // Nothing is sent to Priya until the tradesperson taps.
    expect(sb.pp.calls.filter((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices').length).toBe(1)
    // A second check does nothing more.
    await releaseExpired(ws, { api: sb.api, now: NOW + 4 * MIN })
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(1)
    expect(Object.values(ws.offers)).toHaveLength(1)
  })

  it('a deposit PayPal already shows as paid books the job at expiry instead of cancelling', async () => {
    const sb = sandbox(['INV2-DEP1'], { 'INV2-DEP1': 'PAID' })
    const { ws, j } = await heldBathroom(sb)
    await releaseExpired(ws, { api: sb.api, now: NOW + 3 * MIN })
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(0)
    expect(j.state).toBe('booked')
    expect(job(ws, 'j5').state).toBe('waiting')
  })

  it('a paid deposit (webhook) ends the hold', async () => {
    const sb = sandbox(['INV2-DEP1'])
    const { ws, j } = await heldBathroom(sb)
    depositPaid(ws, 'INV2-DEP1', NOW + MIN)
    expect(j.state).toBe('booked')
    expect(ws.holds[0].ended).toBe('paid')
    await releaseExpired(ws, { api: sb.api, now: NOW + 10 * MIN })
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(0)
  })

  it('a CANCELLED webhook releases the same way, with no cancel call', async () => {
    const sb = sandbox(['INV2-DEP1'])
    const { ws, j } = await heldBathroom(sb)
    invoiceCancelled(ws, 'INV2-DEP1', NOW + MIN)
    expect(j.state).toBe('released')
    expect(job(ws, 'j5').state).toBe('offered')
    expect(sb.path('POST', '/v2/invoicing/invoices/INV2-DEP1/cancel')).toBe(0)
  })

  it('accepting the offer sends Priya her deposit and starts a new hold', async () => {
    const sb = sandbox(['INV2-DEP1', 'INV2-DEP2'])
    const { ws } = await heldBathroom(sb)
    await releaseExpired(ws, { api: sb.api, now: NOW + 3 * MIN })
    const offer = Object.values(ws.offers)[0]
    await acceptOffer(ws, offer.id, { api: sb.api, env: ENV, now: NOW + 4 * MIN })
    expect(job(ws, 'j5')).toMatchObject({ state: 'held', depositInvoiceId: 'INV2-DEP2' })
    expect(ws.holds.find((h) => h.invoiceId === 'INV2-DEP2')).toMatchObject({ expiresAt: NOW + 4 * MIN + 2 * MIN })
    expect(ws.offers[offer.id].accepted).toBe(true)
  })

  it('no waiting job fits: the slot stays free and no offer is made', async () => {
    const sb = sandbox(['INV2-DEP1'])
    const { ws } = await heldBathroom(sb)
    job(ws, 'j5').hours = 3
    await releaseExpired(ws, { api: sb.api, now: NOW + 3 * MIN })
    expect(Object.values(ws.offers)).toHaveLength(0)
    expect(job(ws, 'j5').state).toBe('waiting')
  })
})
