import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { fakePayPal } from './fake-paypal.js'

/** @returns {{ get: (key: string, type?: string) => Promise<any>, put: (key: string, value: string, options?: any) => Promise<void>, list: (options?: any) => Promise<{ keys: Array<{ name: string }> }>, values: Map<string, string>, puts: Array<{ key: string, options: any }> }} */
function historyKV() {
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
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }
    },
  }
}

const envFor = (JOBDONE) => ({ JOBDONE, PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y' })
const ctx = /** @type {any} */ ({ waitUntil: () => {} })
const invoice = { status: 200, body: { id: 'INV2-SAM', status: 'SENT', amount: { value: '340.00' } } }
const successfulPayPal = () => fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [invoice] })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetTokenCache()
})

describe('scheduled health history', () => {
  it('stores a successful check on 3 December with a 40 day TTL', async () => {
    const kv = historyKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    const paypal = successfulPayPal()
    vi.stubGlobal('fetch', paypal.fetch)
    const scheduledTime = Date.parse('2026-12-03T12:17:00.000Z')

    await worker.scheduled({ scheduledTime }, envFor(kv), ctx)

    const saved = JSON.parse(kv.values.get('health:2026-12-03'))
    expect(saved).toMatchObject({ ok: true, paypal: 'ok', lateInvoice: 'SENT' })
    expect(saved.checkedAt).toBeTruthy()
    expect(kv.puts.find(({ key }) => key === 'health:2026-12-03')).toEqual({ key: 'health:2026-12-03', options: { expirationTtl: 40 * 86_400 } })
  })

  it('does not store a check on 20 November', async () => {
    const kv = historyKV()
    const paypal = successfulPayPal()
    vi.stubGlobal('fetch', paypal.fetch)

    await worker.scheduled({ scheduledTime: Date.parse('2026-11-20T12:17:00.000Z') }, envFor(kv), ctx)

    expect(kv.puts).toHaveLength(0)
    expect(paypal.calls).toHaveLength(0)
  })

  it('stores PayPal failures without throwing or leaking credentials', async () => {
    const kv = historyKV()
    const paypal = fakePayPal({ 'POST /v1/oauth2/token': [{ status: 401, body: { error: 'invalid_client', error_description: 'secret-y was rejected' } }] })
    vi.stubGlobal('fetch', paypal.fetch)

    await expect(worker.scheduled({ scheduledTime: Date.parse('2026-12-04T12:17:00.000Z') }, envFor(kv), ctx)).resolves.toBeUndefined()

    const saved = JSON.parse(kv.values.get('health:2026-12-04'))
    expect(saved.ok).toBe(false)
    expect(saved.paypal.length).toBeLessThanOrEqual(120)
    expect(saved.paypal).not.toContain('secret-y')
  })
})

describe('GET /health/history', () => {
  it('lists stored checks newest first', async () => {
    const kv = historyKV()
    await kv.put('health:2026-12-01', JSON.stringify({ ok: true, paypal: 'ok', lateInvoice: 'SENT', checkedAt: '2026-12-01T12:17:00.000Z' }))
    await kv.put('health:2026-12-03', JSON.stringify({ ok: false, paypal: 'failed', lateInvoice: 'none', checkedAt: '2026-12-03T12:17:00.000Z' }))
    await kv.put('other:key', 'ignore')

    const response = await worker.fetch(new Request('https://x/health/history'), envFor(kv), ctx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { day: '2026-12-03', ok: false, paypal: 'failed', lateInvoice: 'none', checkedAt: '2026-12-03T12:17:00.000Z' },
      { day: '2026-12-01', ok: true, paypal: 'ok', lateInvoice: 'SENT', checkedAt: '2026-12-01T12:17:00.000Z' },
    ])
  })
})
