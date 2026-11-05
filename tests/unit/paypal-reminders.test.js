// Reminders PayPal runs by itself. PayPal keeps them per account, not per invoice (setup-reminders made one BEFORE_DUE
// and one AFTER_DUE setting on 28 Oct 2026; the AFTER_DUE one was set to every 3 days, 3 times, and resumed to ACTIVE).
// The app shows each open invoice's planned reminders on the calendar and can stop them for one invoice
// (cancel-reminders answered 204 the same day).
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { stopPayPalReminders } from '../../src/flows/reminders.js'
import { reminderPlan } from '../../src/paypal/invoices.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { plannedReminders } from '../../public/reminder-plan.js'
import { fakePayPal } from './fake-paypal.js'

const DAY = 86_400_000
const plan = { everyDays: 3, times: 3, since: '2026-10-28T21:00:00Z' }
const sent = Date.parse('2026-10-28T22:00:00Z')
const data = (invoices, now = sent + 60_000) => ({ invoices, reminders: plan, now, tz: -180 })
const maria = (o = {}) => ({ id: 'INV2-MARIA', customerId: 'c1', kind: 'invoice', status: 'SENT', sentAt: sent, total: '282.42', due: '282.42', ...o })

beforeEach(() => resetTokenCache())

describe('the reminder plan from the Worker settings', () => {
  it('reads every, times and since, and is off when any is missing or not a positive whole number', () => {
    expect(reminderPlan({ PAYPAL_REMINDER_EVERY_DAYS: '3', PAYPAL_REMINDER_TIMES: '3', PAYPAL_REMINDERS_SINCE: '2026-10-28T21:00:00Z' })).toEqual(plan)
    expect(reminderPlan({})).toBeNull()
    expect(reminderPlan({ PAYPAL_REMINDER_EVERY_DAYS: '0', PAYPAL_REMINDER_TIMES: '3', PAYPAL_REMINDERS_SINCE: '2026-10-28T21:00:00Z' })).toBeNull()
    expect(reminderPlan({ PAYPAL_REMINDER_EVERY_DAYS: '3', PAYPAL_REMINDER_TIMES: 'x', PAYPAL_REMINDERS_SINCE: '2026-10-28T21:00:00Z' })).toBeNull()
    expect(reminderPlan({ PAYPAL_REMINDER_EVERY_DAYS: '3', PAYPAL_REMINDER_TIMES: '3', PAYPAL_REMINDERS_SINCE: 'soon' })).toBeNull()
  })
})

describe('planned reminders on the calendar', () => {
  it('an open invoice gets one all day event every 3 days, 3 times, on local days', () => {
    const events = plannedReminders(data({ 'INV2-MARIA': maria() }))
    expect(events.map((e) => e.id)).toEqual(['rem-INV2-MARIA-1', 'rem-INV2-MARIA-2', 'rem-INV2-MARIA-3'])
    // Sent 28 Oct 19:00 local (UTC-3): reminders on 31 Oct, 3 Nov and 6 Nov, local midnight being 03:00 UTC.
    expect(events.map((e) => new Date(e.start).toISOString())).toEqual(['2026-10-31T03:00:00.000Z', '2026-11-03T03:00:00.000Z', '2026-11-06T03:00:00.000Z'])
    expect(events.every((e) => e.end - e.start === DAY && e.invoiceId === 'INV2-MARIA' && e.customerId === 'c1')).toBe(true)
  })

  it('a part paid invoice still has them; past ones are not shown', () => {
    expect(plannedReminders(data({ 'INV2-MARIA': maria({ status: 'PARTIALLY_PAID' }) })).length).toBe(3)
    // On the morning of the first one's day it still shows; the day after, it is gone.
    expect(plannedReminders(data({ 'INV2-MARIA': maria() }, Date.parse('2026-10-31T13:00:00Z'))).length).toBe(3)
    expect(plannedReminders(data({ 'INV2-MARIA': maria() }, sent + 4 * DAY)).map((e) => e.id)).toEqual(['rem-INV2-MARIA-2', 'rem-INV2-MARIA-3'])
  })

  it('paid, cancelled, stopped, deposit, sent before the plan began, or no plan: none', () => {
    for (const o of [{ status: 'PAID' }, { status: 'MARKED_AS_PAID' }, { status: 'CANCELLED' }, { remindersStopped: true }, { kind: 'deposit' }, { sentAt: Date.parse('2026-10-24T12:00:00Z') }]) {
      expect(plannedReminders(data({ 'INV2-MARIA': maria(o) }))).toEqual([])
    }
    expect(plannedReminders({ invoices: { 'INV2-MARIA': maria() }, reminders: null, now: sent, tz: 0 })).toEqual([])
  })
})

describe('stopping PayPal reminders for one invoice', () => {
  const script = () => fakePayPal({ 'POST /v2/invoicing/invoices/INV2-MARIA/cancel-reminders': [{ status: 204 }] })
  const ENV = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' }

  it('asks PayPal to cancel them and marks the invoice', async () => {
    const ws = seedWorkspace({ id: 'w1', now: sent, tzOffsetMinutes: -180 })
    ws.invoices['INV2-MARIA'] = maria()
    const pp = script()
    await stopPayPalReminders(ws, 'INV2-MARIA', { api: createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} }), now: sent })
    const call = pp.calls.find((c) => c.path.endsWith('/cancel-reminders'))
    expect(call.method).toBe('POST')
    expect(call.headers.get('paypal-request-id')).toBe('jd-w1-INV2-MARIA-stop-reminders')
    expect(ws.invoices['INV2-MARIA'].remindersStopped).toBe(true)
  })

  it('refuses an unknown or closed invoice without calling PayPal', async () => {
    const ws = seedWorkspace({ id: 'w1', now: sent, tzOffsetMinutes: -180 })
    ws.invoices['INV2-MARIA'] = maria({ status: 'PAID' })
    const pp = script()
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    await expect(stopPayPalReminders(ws, 'INV2-NONE', { api, now: sent })).rejects.toMatchObject({ status: 404 })
    await expect(stopPayPalReminders(ws, 'INV2-MARIA', { api, now: sent })).rejects.toMatchObject({ status: 409 })
    expect(pp.calls.filter((c) => c.path.includes('/v2/'))).toEqual([])
  })

  it('a PayPal failure leaves the invoice unmarked', async () => {
    const ws = seedWorkspace({ id: 'w1', now: sent, tzOffsetMinutes: -180 })
    ws.invoices['INV2-MARIA'] = maria()
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-MARIA/cancel-reminders': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'd1' } }] })
    await expect(stopPayPalReminders(ws, 'INV2-MARIA', { api: createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} }), now: sent })).rejects.toMatchObject({ code: 'PAYPAL' })
    expect(ws.invoices['INV2-MARIA'].remindersStopped).toBeUndefined()
  })
})
