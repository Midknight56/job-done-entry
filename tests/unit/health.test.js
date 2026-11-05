import { describe, it, expect } from 'vitest'
import worker from '../../src/worker.js'

describe('health', () => {
  it('answers 200 with a build id', async () => {
    const res = await worker.fetch(new Request('https://x/health'), {}, /** @type {any} */ ({}))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

describe('deep health', () => {
  it('reads the shared late invoice through PayPal', async () => {
    const { vi } = await import('vitest')
    const { fakePayPal } = await import('./fake-paypal.js')
    const { memoryKV } = await import('./memory-kv.js')
    const kv = memoryKV()
    await kv.put('seed:late-invoice', 'INV2-SAM')
    vi.stubGlobal('fetch', fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [{ status: 200, body: { id: 'INV2-SAM', status: 'SENT', amount: { value: '340.00' } } }] }).fetch)
    const res = await worker.fetch(new Request('https://x/health?deep=1'), { JOBDONE: kv, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }, /** @type {any} */ ({}))
    expect(await res.json()).toMatchObject({ ok: true, paypal: 'ok', lateInvoice: 'SENT' })
    vi.unstubAllGlobals()
  })
})
