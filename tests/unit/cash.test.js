import { describe, it, expect, beforeEach } from 'vitest'
import { resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { recordCashTap } from '../../src/flows/cash.js'
import { fakePayPal } from './fake-paypal.js'

const NOW = Date.parse('2026-10-30T15:00:00Z')

function setup(liveDue = '108.00') {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  ws.invoices['INV2-DAVE'] = { id: 'INV2-DAVE', customerId: 'c2', jobId: 'j1', kind: 'invoice', total: '108.00', due: '108.00', status: 'SENT', sentAt: 1, reminders: 0 }
  ws.jobs.find((j) => j.id === 'j1').state = 'sent'
  const pp = fakePayPal({
    'GET /v2/invoicing/invoices/INV2-DAVE': [
      { status: 200, body: { id: 'INV2-DAVE', status: 'SENT', amount: { value: '108.00', currency_code: 'USD' }, due_amount: { value: liveDue, currency_code: 'USD' } } },
      { status: 200, body: { id: 'INV2-DAVE', status: 'MARKED_AS_PAID', amount: { value: '108.00', currency_code: 'USD' }, due_amount: { value: '0.00', currency_code: 'USD' } } },
    ],
    'POST /v2/invoicing/invoices/INV2-DAVE/payments': [{ status: 200, body: { payment_id: 'EXTR-1' } }],
  })
  const api = createPayPal({ PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }, { fetch: pp.fetch, sleep: async () => {} })
  return { ws, pp, api }
}

beforeEach(() => resetTokenCache())

describe('cash', () => {
  it('an amount above the live due amount is refused with no payment call', async () => {
    const { ws, pp, api } = setup()
    await expect(recordCashTap(ws, 'INV2-DAVE', '150.00', { api, now: NOW })).rejects.toMatchObject({ code: 'CASH_TOO_HIGH' })
    expect(pp.calls.some((c) => c.path.endsWith('/payments'))).toBe(false)
  })

  it('an equal amount records CASH with today\'s date, then the job is paid with a cash badge', async () => {
    const { ws, pp, api } = setup()
    await recordCashTap(ws, 'INV2-DAVE', '108.00', { api, now: NOW })
    const call = pp.calls.find((c) => c.path.endsWith('/payments'))
    expect(JSON.parse(call.body)).toMatchObject({ method: 'CASH', payment_date: '2026-10-30', amount: { currency_code: 'USD', value: '108.00' } })
    expect(call.headers.get('paypal-request-id')).toMatch(/^jd-w1-INV2-DAVE-cash/)
    expect(ws.invoices['INV2-DAVE']).toMatchObject({ status: 'MARKED_AS_PAID', due: '0.00', cash: true })
    expect(ws.jobs.find((j) => j.id === 'j1').state).toBe('paid')
    expect(ws.notices.at(-1).text).toBe('Dave Chen paid 108.00 in cash.')
  })

  it('the shared late invoice cannot be paid from one workspace', async () => {
    const { ws, api } = setup()
    ws.invoices['INV2-DAVE'].shared = true
    await expect(recordCashTap(ws, 'INV2-DAVE', '108.00', { api, now: NOW })).rejects.toMatchObject({ code: 'SHARED' })
  })
})
