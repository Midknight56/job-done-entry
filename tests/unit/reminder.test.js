import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { toneFor } from '../../src/agent/tools.js'
import { cleanReminder, sendReminderTap } from '../../src/flows/reminders.js'
import { fakePayPal } from './fake-paypal.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-08T15:00:00Z')

beforeEach(() => resetTokenCache())

describe('reminders', () => {
  it('the tone follows how many were sent: the third one is firm', () => {
    expect(toneFor(0)).toBe('friendly')
    expect(toneFor(1)).toBe('polite')
    expect(toneFor(2)).toBe('firm')
  })

  it('any figure other than the due amount and the days late is removed', () => {
    const inv = { due: '340.00', sentAt: NOW - 15 * DAY }
    const out = cleanReminder('Hi Sam. The 340.00 for the boiler is now 15 days late. I can take 300 if you pay today. Please pay this week.', inv, NOW)
    expect(out).toBe('Hi Sam. The 340.00 for the boiler is now 15 days late. Please pay this week.')
  })

  it('a tap sends a standard reminder, counts it and leaves a notice', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW - 15 * DAY, reminders: 2 }
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    const api = createPayPal({ PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }, { fetch: pp.fetch, sleep: async () => {} })
    await sendReminderTap(ws, 'INV2-SAM', 'Hi Sam. 340.00 is still open. Pay 999 now.', { api, now: NOW })
    const call = pp.calls.find((c) => c.path.endsWith('/remind'))
    expect(JSON.parse(call.body)).toEqual({ send_to_recipient: true })
    expect(ws.invoices['INV2-SAM'].reminders).toBe(3)
    expect(ws.notices.at(-1).text).toBe('Reminder sent to Sam Okafor.')
  })

  it('a standard reminder needs no custom text', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW - 15 * DAY, reminders: 0 }
    const pp = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    const api = createPayPal({ PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }, { fetch: pp.fetch, sleep: async () => {} })
    await sendReminderTap(ws, 'INV2-SAM', '', { api, now: NOW })
    expect(ws.invoices['INV2-SAM'].reminders).toBe(1)
  })
})
