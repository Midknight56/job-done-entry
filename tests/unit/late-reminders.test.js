import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { fakePayPal } from './fake-paypal.js'

/** @returns {{ get: (key: string, type?: string) => Promise<any>, put: (key: string, value: string, options?: any) => Promise<void>, values: Map<string, string>, puts: Array<{ key: string, options: any }> }} */
function reminderKV() {
  const values = new Map()
  const puts = []
  return {
    values,
    puts,
    async get(key, type) {
      const value = values.get(key)
      if (value === undefined) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key, value, options = {}) {
      puts.push({ key, options })
      values.set(key, String(value))
    },
  }
}

const ctx = /** @type {any} */ ({ waitUntil: () => {} })
const envFor = (JOBDONE, LATE_REMINDER_DAYS) => ({ JOBDONE, LATE_REMINDER_DAYS, PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y' })
const okReply = { status: 204 }

afterEach(() => {
  vi.unstubAllGlobals()
  resetTokenCache()
})

describe('scheduled late invoice reminders', () => {
  it('sends one reminder and records the count and date key', async () => {
    const kv = reminderKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    await kv.put('seed:late-reminders', '0')
    const paypal = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-SAM/remind': [okReply] })
    vi.stubGlobal('fetch', paypal.fetch)

    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, '2026-10-27,2026-10-31'), ctx)

    const call = paypal.calls.find(({ path }) => path.endsWith('/remind'))
    expect(call).toBeTruthy()
    expect(JSON.parse(call.body)).toEqual({ send_to_recipient: true })
    expect(call.headers.get('paypal-request-id')).toBe('jd-late-remind-2026-10-27')
    expect(kv.values.get('seed:late-reminders')).toBe('1')
    expect(kv.values.get('remind-done:2026-10-27')).toBe('1')
    expect(kv.puts.find(({ key }) => key === 'remind-done:2026-10-27')).toEqual({ key: 'remind-done:2026-10-27', options: { expirationTtl: 60 * 86_400 } })
  })

  it('does not send a second reminder on the same date', async () => {
    const kv = reminderKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    const paypal = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-SAM/remind': [okReply] })
    vi.stubGlobal('fetch', paypal.fetch)
    const scheduled = { scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }

    await worker.scheduled(scheduled, envFor(kv, '2026-10-27'), ctx)
    await worker.scheduled(scheduled, envFor(kv, '2026-10-27'), ctx)

    expect(paypal.calls.filter(({ path }) => path.endsWith('/remind'))).toHaveLength(1)
    expect(kv.values.get('seed:late-reminders')).toBe('1')
  })

  it('does nothing on an unlisted date', async () => {
    const kv = reminderKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    const paypal = fakePayPal({})
    vi.stubGlobal('fetch', paypal.fetch)

    await worker.scheduled({ scheduledTime: Date.parse('2026-10-28T12:17:00.000Z') }, envFor(kv, '2026-10-27,2026-10-31'), ctx)

    expect(paypal.calls).toHaveLength(0)
    expect(kv.values.has('seed:late-reminders')).toBe(false)
  })

  it('leaves the count unchanged and does not throw when PayPal rejects the reminder', async () => {
    const kv = reminderKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    await kv.put('seed:late-reminders', '4')
    const paypal = fakePayPal({ 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 400, body: { name: 'INVALID_REQUEST' } }] })
    vi.stubGlobal('fetch', paypal.fetch)

    await expect(worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, '2026-10-27'), ctx)).resolves.toBeUndefined()

    expect(kv.values.get('seed:late-reminders')).toBe('4')
    expect(kv.values.has('remind-done:2026-10-27')).toBe(false)
  })
})
