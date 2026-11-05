import { describe, it, expect } from 'vitest'
import { seedWorkspace, job } from '../../src/state/workspace.js'
import { findSlots, moveJob } from '../../src/state/schedule.js'
import { releaseExpired, acceptOffer, depositPaid } from '../../src/state/holds.js'
import { sendReminderTap } from '../../src/flows/reminders.js'
import { createPayPal } from '../../src/paypal/client.js'
import { fakePayPal } from './fake-paypal.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const ENV = { PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }

function workspace() {
  return seedWorkspace({ id: 'battle', now: NOW, tzOffsetMinutes: 0 })
}

function holdCase(status = 'SENT') {
  const ws = workspace()
  const held = { id: 'held', customerId: 'c1', summary: 'Held repair', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', state: 'held', hours: 1, depositInvoiceId: 'INV1' }
  ws.jobs.push(held)
  ws.invoices.INV1 = { id: 'INV1', customerId: 'c1', jobId: held.id, kind: 'deposit', total: '50.00', due: '50.00', status, reminders: 0 }
  ws.holds.push({ jobId: held.id, invoiceId: 'INV1', start: held.start, end: held.end, expiresAt: NOW })
  return { ws, held }
}

function apiFor(statuses, beforeRead) {
  const pp = fakePayPal({})
  return {
    pp,
    api: { request: async ({ method, path }) => {
      if (method === 'GET') {
        if (beforeRead) await beforeRead()
        const id = path.split('/').at(-1)
        return { ok: true, json: { id, status: statuses[id] || 'SENT', amount: { value: '50.00', currency_code: 'USD' }, due_amount: { value: '50.00' } } }
      }
      return { ok: true, json: {} }
    } },
  }
}

describe('battle c hold attacks', () => {
  it('keeps the slot when the deposit is paid exactly at expiry', async () => {
    const { ws, held } = holdCase()
    await releaseExpired(ws, { api: apiFor({ INV1: 'PAID' }).api, now: NOW })
    expect(held.state).toBe('booked')
    expect(ws.holds[0].ended).toBe('paid')
  })

  it('uses the local PayPal fixture to read an invoice status', async () => {
    const { ws, held } = holdCase()
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV1': [{ status: 200, body: { id: 'INV1', status: 'PAID', amount: { value: '50.00', currency_code: 'USD' } } }] })
    await releaseExpired(ws, { api: createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} }), now: NOW })
    expect(held.state).toBe('booked')
    expect(pp.calls.some((call) => call.path === '/v2/invoicing/invoices/INV1')).toBe(true)
  })

  it('keeps the slot when PayPal reads paid before a late webhook', async () => {
    const { ws, held } = holdCase()
    await releaseExpired(ws, { api: apiFor({ INV1: 'PAID' }).api, now: NOW })
    depositPaid(ws, 'INV1', NOW + 1)
    expect(held.state).toBe('booked')
  })

  it('keeps the slot when the invoice read errors', async () => {
    const { ws, held } = holdCase()
    const api = { request: async () => { throw new Error('offline') } }
    await releaseExpired(ws, { api, now: NOW })
    expect(held.state).toBe('held')
    expect(ws.holds[0].ended).toBeUndefined()
  })

  it('does not offer a slot while its earlier offer remains open', async () => {
    const { ws } = holdCase()
    ws.waiting = ['j5']
    ws.offers.old = { id: 'old', jobId: 'j5', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }
    await releaseExpired(ws, { api: apiFor({ INV1: 'SENT' }).api, now: NOW })
    expect(Object.values(ws.offers).filter((o) => !o.accepted)).toHaveLength(1)
  })

  it('checks an expiring hold only once during overlapping release calls', async () => {
    const { ws } = holdCase()
    let releaseRead
    const gate = new Promise((resolve) => { releaseRead = resolve })
    let reads = 0
    const api = { request: async ({ method }) => {
      if (method === 'GET') { reads++; await gate; return { ok: true, json: { id: 'INV1', status: 'SENT', amount: { value: '50.00', currency_code: 'USD' } } } }
      return { ok: true, json: {} }
    } }
    const first = releaseExpired(ws, { api, now: NOW })
    await Promise.resolve()
    const second = releaseExpired(ws, { api, now: NOW })
    releaseRead()
    await Promise.all([first, second])
    expect(reads).toBe(1)
    expect(Object.values(ws.offers)).toHaveLength(1)
  })

  it('does not accept the same offer twice concurrently', async () => {
    const ws = workspace()
    ws.drafts.d1 = { id: 'd1', customerId: 'c1', jobId: 'j5', kind: 'deposit', summary: 'deposit', priced: { total: '50.00', currency: 'USD', lines: [] } }
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let creates = 0
    const api = { request: async ({ path }) => {
      if (path === '/v2/invoicing/invoices') return { ok: true, status: 201, json: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/NEW1' } }
      if (path.endsWith('/NEW1')) return { ok: true, json: { id: 'NEW1', status: 'SENT', amount: { value: '50.00', currency_code: 'USD' }, due_amount: { value: '50.00' } } }
      if (path.endsWith('/send')) { creates++; await gate; return { ok: true, json: {} } }
      if (path.endsWith('/generate-qr-code')) return { ok: true, text: 'iVBORw0KGgo=' }
      return { ok: true, json: {} }
    } }
    const a = acceptOffer(ws, 'o1', { api, env: ENV, now: NOW })
    const b = acceptOffer(ws, 'o1', { api, env: ENV, now: NOW })
    await Promise.resolve()
    release()
    await Promise.all([a, b])
    expect(creates).toBe(1)
  })

  it('keeps a paid offered deposit from losing its slot on a second expiry', async () => {
    const { ws } = holdCase()
    ws.jobs.find((j) => j.id === 'j5').state = 'offered'
    ws.holds.push({ jobId: 'j5', invoiceId: 'INV2', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', expiresAt: NOW })
    ws.invoices.INV2 = { id: 'INV2', customerId: 'c4', jobId: 'j5', kind: 'deposit', total: '50.00', due: '50.00', status: 'SENT' }
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED', INV2: 'PAID' }).api, now: NOW })
    expect(job(ws, 'j5').state).toBe('booked')
  })

  it('assigns a slot to only one of two simultaneous expired holds', async () => {
    const { ws } = holdCase()
    ws.jobs.push({ id: 'held2', customerId: 'c2', summary: 'Other repair', start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T10:00:00.000Z', state: 'held', hours: 1 })
    ws.holds.push({ jobId: 'held2', invoiceId: 'INV2', start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T10:00:00.000Z', expiresAt: NOW })
    ws.waiting = ['j5']
    const api = apiFor({ INV1: 'SENT', INV2: 'SENT' }).api
    await releaseExpired(ws, { api, now: NOW })
    expect(Object.values(ws.offers)).toHaveLength(1)
  })

  it('does not revive a job that was deleted before its hold expires', async () => {
    const { ws } = holdCase()
    ws.jobs = ws.jobs.filter((j) => j.id !== 'held')
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED' }).api, now: NOW })
    expect(ws.jobs.some((j) => j.id === 'held')).toBe(false)
  })

  it('keeps a moved held job in its new slot when the old invoice expires', async () => {
    const { ws, held } = holdCase()
    expect(moveJob(ws, held.id, '2026-11-05T09:00:00Z', NOW).ok).toBe(true)
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED' }).api, now: NOW })
    expect(held.state).toBe('released')
    expect(ws.jobs.find((j) => j.id === 'j5').start).toBe('2026-11-05T09:00:00.000Z')
  })
})

describe('battle c schedule attacks', () => {
  it('refuses a move onto another job', () => {
    const ws = workspace()
    const out = moveJob(ws, 'j2', job(ws, 'j3').start, NOW)
    expect(out.ok).toBe(false)
  })

  it('refuses a move onto a held slot', () => {
    const { ws } = holdCase()
    expect(moveJob(ws, 'j2', '2026-11-03T09:00:00Z', NOW).ok).toBe(false)
  })

  it('refuses a move into the past', () => {
    const ws = workspace()
    expect(moveJob(ws, 'j2', '2026-10-20T09:00:00Z', NOW).ok).toBe(false)
  })

  it('refuses a move that crosses midnight', () => {
    const ws = workspace()
    expect(moveJob(ws, 'j2', '2026-11-05T23:30:00Z', NOW).ok).toBe(false)
  })

  it('uses the workspace offset consistently when crossing a daylight saving date', () => {
    const ws = workspace()
    ws.tz = -240
    const slots = findSlots(ws, { durationHours: 1, after: '2026-11-02T00:00:00Z', before: '2026-11-04T00:00:00Z', now: NOW, limit: 2 })
    expect(slots.every((s) => new Date(Date.parse(s.start) - ws.tz * 60_000).getUTCHours() >= 8)).toBe(true)
  })

  it('refuses a move outside working hours', () => {
    const ws = workspace()
    expect(moveJob(ws, 'j2', '2026-11-06T18:00:00Z', NOW).ok).toBe(false)
  })

  it('refuses a zero length job move', () => {
    const ws = workspace()
    job(ws, 'j2').end = job(ws, 'j2').start
    expect(moveJob(ws, 'j2', '2026-11-06T09:00:00Z', NOW).ok).toBe(false)
  })

  it('refuses a negative length job move', () => {
    const ws = workspace()
    job(ws, 'j2').end = '2026-10-28T12:00:00.000Z'
    expect(moveJob(ws, 'j2', '2026-11-06T09:00:00Z', NOW).ok).toBe(false)
  })

  it('returns no slots for a job longer than the work day', () => {
    const ws = workspace()
    expect(findSlots(ws, { durationHours: 10, after: NOW, now: NOW })).toEqual([])
  })

  it('returns no slots for an invalid start date', () => {
    const ws = workspace()
    expect(findSlots(ws, { durationHours: 1, after: 'not-a-date', now: NOW })).toEqual([])
  })

  it('returns no slots when there is no free hour', () => {
    const ws = workspace()
    ws.jobs.push({ id: 'block', customerId: 'c1', summary: 'All day', start: '2026-10-29T08:00:00Z', end: '2026-11-30T17:00:00Z', state: 'booked' })
    expect(findSlots(ws, { durationHours: 1, after: '2026-10-29T00:00:00Z', before: '2026-11-30T23:00:00Z', now: NOW })).toEqual([])
  })

  it('keeps slots inside a plus fourteen offset workday', () => {
    const ws = seedWorkspace({ id: 'plus', now: NOW, tzOffsetMinutes: 840 })
    const slots = findSlots(ws, { durationHours: 1, after: NOW, now: NOW, limit: 3 })
    expect(slots.every((s) => { const h = new Date(Date.parse(s.start) + 840 * 60_000).getUTCHours(); return h >= 8 && h < 17 })).toBe(true)
  })

  it('keeps slots inside a minus twelve offset workday', () => {
    const ws = seedWorkspace({ id: 'minus', now: NOW, tzOffsetMinutes: -720 })
    const slots = findSlots(ws, { durationHours: 1, after: NOW, now: NOW, limit: 3 })
    expect(slots.every((s) => { const h = new Date(Date.parse(s.start) - 720 * 60_000).getUTCHours(); return h >= 8 && h < 17 })).toBe(true)
  })
})

describe('battle c waiting list and reminder attacks', () => {
  it('leaves an empty waiting list without an offer', async () => {
    const { ws } = holdCase()
    ws.waiting = []
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED' }).api, now: NOW })
    expect(Object.values(ws.offers)).toHaveLength(0)
  })

  it('skips a waiting job that does not fit and offers the next one that does', async () => {
    const { ws } = holdCase()
    job(ws, 'j5').hours = 3
    ws.jobs.push({ id: 'j6', customerId: 'c2', summary: 'Small repair', start: '', end: '', state: 'waiting', hours: 1 })
    ws.waiting = ['j5', 'j6']
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED' }).api, now: NOW })
    expect(Object.values(ws.offers)[0]?.jobId).toBe('j6')
  })

  it('preserves the current fallback offer when its customer was removed', async () => {
    const { ws } = holdCase()
    ws.customers = ws.customers.filter((c) => c.id !== 'c4')
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED' }).api, now: NOW })
    const offer = Object.values(ws.offers)[0]
    expect(offer.jobId).toBe('j5')
    expect(ws.drafts[offer.draftId].customerId).toBe('c4')
  })

  it('does not offer the same waiting job twice', async () => {
    const { ws } = holdCase()
    ws.waiting = ['j5', 'j5']
    ws.jobs.push({ id: 'held2', customerId: 'c2', summary: 'Other repair', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z', state: 'held', hours: 1 })
    ws.holds.push({ jobId: 'held2', invoiceId: 'INV2', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z', expiresAt: NOW })
    await releaseExpired(ws, { api: apiFor({ INV1: 'CANCELLED', INV2: 'CANCELLED' }).api, now: NOW })
    expect(Object.values(ws.offers).filter((o) => o.jobId === 'j5')).toHaveLength(1)
  })

  it('does not send a deposit for an offer whose job is already booked', async () => {
    const ws = workspace()
    ws.drafts.d1 = { id: 'd1', customerId: 'c4', jobId: 'j5', kind: 'deposit', summary: 'deposit', priced: { total: '50.00', currency: 'USD', lines: [] } }
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }
    job(ws, 'j5').state = 'booked'
    const calls = []
    await acceptOffer(ws, 'o1', { api: { request: async (r) => (calls.push(r.path), { ok: true, json: {} }) }, env: ENV, now: NOW })
    expect(calls).toEqual([])
    expect(ws.offers.o1.accepted).toBeUndefined()
  })

  it('does not accept an offer after its slot was taken by a move', async () => {
    const ws = workspace()
    const slot = '2026-11-03T09:00:00.000Z'
    ws.drafts.d1 = { id: 'd1', customerId: 'c4', jobId: 'j5', kind: 'deposit', summary: 'deposit', priced: { total: '50.00', currency: 'USD', lines: [] } }
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start: slot, end: '2026-11-03T10:00:00.000Z' }
    job(ws, 'j5').state = 'offered'
    ws.jobs.push({ id: 'mover', customerId: 'c1', summary: 'Moved work', start: slot, end: '2026-11-03T10:00:00.000Z', state: 'booked', hours: 1 })
    await expect(acceptOffer(ws, 'o1', { api: {}, env: ENV, now: NOW })).resolves.toBeUndefined()
    expect(ws.holds).toHaveLength(0)
  })

  it('does not send a reminder for a paid invoice', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'PAID', due: '0.00', reminders: 0 }
    await expect(sendReminderTap(ws, 'I1', 'Thanks', { api: { request: async () => ({ ok: true, json: {} }) }, now: NOW })).rejects.toBeDefined()
  })

  it('does not send a reminder for a cancelled invoice', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'CANCELLED', due: '50.00', reminders: 0 }
    await expect(sendReminderTap(ws, 'I1', 'Please pay', { api: { request: async () => ({ ok: true, json: {} }) }, now: NOW })).rejects.toBeDefined()
  })

  it('sends a reminder on the shared late invoice, which is the demo scene "Remind Sam about his invoice"', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'SENT', due: '50.00', reminders: 0, shared: true }
    const calls = []
    await sendReminderTap(ws, 'I1', 'Please pay', { api: { request: async ({ path }) => (calls.push(path), { ok: true, json: {} }) }, now: NOW })
    expect(calls.some((path) => path.endsWith('/remind'))).toBe(true)
    expect(ws.invoices.I1.reminders).toBe(1)
  })

  it('uses standard delivery for every reminder', async () => {
    const ws = workspace()
    const subjects = []
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'SENT', due: '50.00', reminders: 0 }
    const api = { request: async ({ body }) => (subjects.push(body), { ok: true, json: {} }) }
    for (let i = 0; i < 6; i++) await sendReminderTap(ws, 'I1', 'Please pay', { api, now: NOW })
    expect(subjects).toEqual(Array.from({ length: 6 }, () => ({ send_to_recipient: true })))
  })

  it('never sends invented draft figures to the provider', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'SENT', due: '50.00', reminders: 0, sentAt: NOW - 2 * 86400000 }
    let sent = null
    await sendReminderTap(ws, 'I1', 'Please pay 75.00 after 10 days', { api: { request: async ({ body }) => (sent = body, { ok: true, json: {} }) }, now: NOW })
    expect(sent).toEqual({ send_to_recipient: true })
  })
})
