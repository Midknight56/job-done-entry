import { afterEach, describe, expect, it, vi } from 'vitest'
import samples from '../../samples/replay.json'
import worker from '../../src/worker.js'
import { devStubModel } from '../../src/agent/devstub.js'
import { matchReplayTurn, normalize, replayLines, replayModel, remapInvoices } from '../../src/agent/replay.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { fakePayPal } from './fake-paypal.js'

function kvWith(values = new Map()) {
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, String(value)) },
    async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) } },
  }
}

const ctx = /** @type {any} */ ({ waitUntil: () => {} })
const envFor = (JOBDONE, extra = {}) => ({ JOBDONE, PAYPAL_CLIENT_ID: 'id-secret', PAYPAL_CLIENT_SECRET: 'secret-value', ...extra })
const sentInvoice = (status = 'SENT') => ({ status: 200, body: { id: 'INV2-SAM', status, amount: { value: '340.00' } } })
const callHealth = (env) => worker.fetch(new Request('https://x/health?deep=1'), env, ctx)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetTokenCache()
})

describe('battle g scheduled attacks', () => {
  it('does not duplicate a same day reminder', async () => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()], 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    vi.stubGlobal('fetch', pp.fetch)
    const scheduled = { scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }
    await worker.scheduled(scheduled, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    await worker.scheduled(scheduled, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls.filter(({ path }) => path.endsWith('/remind'))).toHaveLength(1)
  })

  it('retries a failed listed reminder later that day and records it once', async () => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()], 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 503 }, { status: 204 }] })
    vi.stubGlobal('fetch', pp.fetch)
    const scheduled = { scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }
    await worker.scheduled(scheduled, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    await worker.scheduled(scheduled, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls.filter(({ path }) => path.endsWith('/remind'))).toHaveLength(2)
    expect(kv.values.get('seed:late-reminders')).toBe('1')
  })

  it.each([' 2026-10-27 ', '2026-10-27,,2026-10-31', 'bad-date,2026-10-27'])('accepts valid date among configured values %s', async (days) => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()], 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, { LATE_REMINDER_DAYS: days }), ctx)
    expect(pp.calls.some(({ path }) => path.endsWith('/remind'))).toBe(true)
  })

  it('does not call PayPal for an empty reminder date list', async () => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({})
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, { LATE_REMINDER_DAYS: ', ,' }), ctx)
    expect(pp.calls).toHaveLength(0)
  })

  it('does not send a reminder when the shared invoice id is missing', async () => {
    const pp = fakePayPal({})
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kvWith(), { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls).toHaveLength(0)
  })

  it.each(['PAID', 'CANCELLED'])('does not remind a %s shared invoice', async (status) => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({
      'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice(status)],
      'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }],
    })
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls.some(({ path }) => path.endsWith('/remind'))).toBe(false)
  })

  it('uses the UTC calendar day near local midnight', async () => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()], 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T00:05:00.000Z') }, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls.some(({ path }) => path.endsWith('/remind'))).toBe(true)
  })

  it('does not record a sent reminder when KV put fails', async () => {
    const values = new Map([['seed:late-invoice', 'INV2-SAM']])
    const kv = kvWith(values)
    kv.put = async (key, value) => {
      if (key.startsWith('remind-done:')) throw new Error('kv offline')
      values.set(key, String(value))
    }
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()], 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }] })
    vi.stubGlobal('fetch', pp.fetch)
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-27T12:17:00.000Z') }, envFor(kv, { LATE_REMINDER_DAYS: '2026-10-27' }), ctx)
    expect(pp.calls.filter(({ path }) => path.endsWith('/remind'))).toHaveLength(1)
  })
})

describe('battle g health attacks', () => {
  it('caches one hundred deep health requests for one minute', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-03T12:00:00.000Z'))
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM': [sentInvoice()] })
    vi.stubGlobal('fetch', pp.fetch)
    for (let i = 0; i < 100; i++) await callHealth(envFor(kv))
    expect(pp.calls.filter(({ path }) => path.includes('/invoices/INV2-SAM'))).toHaveLength(1)
  })

  it.each([500, 401])('returns a safe health result for PayPal HTTP %i', async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-04T12:00:00.000Z'))
    const kv = kvWith()
    const pp = fakePayPal({ 'POST /v1/oauth2/token': [{ status, body: { error_description: 'secret-value token=tok-secret' } }] })
    vi.stubGlobal('fetch', pp.fetch)
    const result = await (await callHealth(envFor(kv))).json()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/secret-value|tok-secret|id-secret/)
  })

  it('returns a safe health result on a PayPal timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-05T12:00:00.000Z'))
    vi.stubGlobal('fetch', async () => { throw new Error('timeout secret-value internal stack') })
    const result = await (await callHealth(envFor(kvWith()))).json()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/secret-value|internal stack/)
  })

  it('does not expose a shared invoice id in deep health output', async () => {
    const kv = kvWith(new Map([['seed:late-invoice', 'INV2-SAM-PRIVATE']]))
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-SAM-PRIVATE': [sentInvoice()] })
    vi.stubGlobal('fetch', pp.fetch)
    expect(JSON.stringify(await (await callHealth(envFor(kv))).json())).not.toContain('INV2-SAM-PRIVATE')
  })

  it('returns an empty list for health history with no entries', async () => {
    expect(await (await worker.fetch(new Request('https://x/health/history'), envFor(kvWith()), ctx)).json()).toEqual([])
  })

  it('skips parsed history values that are arrays or null', async () => {
    const values = new Map([['health:2026-10-20', '[]'], ['health:2026-10-21', 'null']])
    const result = await (await worker.fetch(new Request('https://x/health/history'), envFor(kvWith(values)), ctx)).json()
    expect(result).toEqual([])
  })

  it('skips malformed health history records and returns the newest fifteen from fifteen days', async () => {
    const values = new Map([['health:2026-10-01', '{bad']])
    for (let i = 1; i <= 15; i++) values.set(`health:2026-10-${String(i).padStart(2, '0')}`, JSON.stringify({ ok: true, paypal: 'ok', lateInvoice: 'SENT', checkedAt: `2026-10-${String(i).padStart(2, '0')}T12:00:00Z` }))
    const result = await (await worker.fetch(new Request('https://x/health/history'), envFor(kvWith(values)), ctx)).json()
    expect(result).toHaveLength(15)
    expect(result[0].day).toBe('2026-10-15')
  })

  it('does not echo untrusted fields from valid but malformed health history JSON', async () => {
    const values = new Map([['health:2026-10-20', JSON.stringify({ ok: true, paypal: 'token-secret', lateInvoice: 'INV2-PRIVATE', checkedAt: 'internal stack secret-value' })]])
    const result = await (await worker.fetch(new Request('https://x/health/history'), envFor(kvWith(values)), ctx)).json()
    expect(JSON.stringify(result)).not.toMatch(/token-secret|INV2-PRIVATE|internal stack|secret-value/)
  })
})

describe('battle g demo seeding attacks', () => {
  it.each(['create', 'qr', 'shared invoice read'])(
    'opens a demo and stores money consistently when PayPal fails at %s', async (failure) => {
      const values = new Map([['seed:late-invoice', 'INV2-SAM']])
      const kv = kvWith(values)
      const script = {
        'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-R1' } }],
        'GET /v2/invoicing/invoices/INV2-R1': [{ status: 200, body: { id: 'INV2-R1', status: 'SENT', amount: { value: '108.00' }, due_amount: { value: '108.00' } } }],
        'POST /v2/invoicing/invoices/INV2-R1/send': [{ status: 200, body: {} }],
        'POST /v2/invoicing/invoices/INV2-R1/generate-qr-code': [{ status: 500, body: { name: 'INTERNAL_ERROR' } }],
        'GET /v2/invoicing/invoices/INV2-SAM': [{ status: 500, body: { name: 'INTERNAL_ERROR' } }],
      }
      if (failure === 'create') script['POST /v2/invoicing/invoices'] = [{ status: 500, body: { name: 'INTERNAL_ERROR' } }]
      if (failure === 'qr') script['POST /v2/invoicing/invoices/INV2-R1/generate-qr-code'] = [{ status: 500, body: { name: 'INTERNAL_ERROR' } }]
      const pp = fakePayPal(script)
      vi.stubGlobal('fetch', pp.fetch)
      const result = await worker.fetch(new Request('https://x/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.5' }, body: JSON.stringify({ tz: 0 }) }), envFor(kv, { PAYPAL_BUYER_EMAIL: 'buyer@example.com' }), ctx)
      expect(result.status).toBe(200)
      const body = await result.json()
      const ws = body.ws
      expect(ws.notices.length).toBeGreaterThan(0)
      expect(ws.notices.every(({ text }) => typeof text === 'string' && text.length < 140)).toBe(true)
      expect(Object.keys(ws.invoices).some((id) => id === 'INV2-R1')).toBe(failure !== 'create')
      if (failure !== 'create') expect(ws.invoices['INV2-R1']).toMatchObject({ total: '108.00', due: '108.00', status: 'SENT' })
      expect(Object.keys(ws.invoices).some((id) => id === 'INV2-SAM')).toBe(false)
    },
  )
})

describe('battle g replay attacks', () => {
  const recorded = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.'

  it.each([
    'kitchen tap for maria at 14 elm hour and a half the tap was 89 she wants the bathroom one done next week',
    '  KITCHEN TAP for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week!!!  ',
  ])('matches harmless transcript variation: %s', (text) => {
    expect(replayModel(text)).toBeTruthy()
  })

  it('never matches a line one word away, which could name another customer', () => {
    expect(replayModel('Kitchen tap for Maria at 14 Elm hour and a half the tap was 89 she wants the bathroom one done next week please')).toBeNull()
    expect(matchReplayTurn('sam paid cash 108', { 'dave paid cash 108': { outputs: ['x'] } })).toBeNull()
  })

  it('does not match an unrecorded phrase', () => {
    expect(replayModel('Please fit a roof rack tomorrow')).toBeNull()
  })


  it('rejects a recorded turn with missing outputs', () => {
    expect(matchReplayTurn('hi', { hi: {} })).toEqual({})
    expect(replayModel('a line with no matching sample')).toBeNull()
  })

  it('does not leave a recorded invoice id when this workspace has no matching invoice', () => {
    const recordedId = 'INV2-79BF-MDPZ-X4MN-DP6F'
    const results = [{ tool: 'find_customer', result: { matches: [{ id: 'c2' }] } }, { tool: 'open_invoices', result: { invoices: [] } }]
    const out = remapInvoices(`{"final":{"kind":"cash","invoice_id":"${recordedId}","amount":"108.00"}}`, [{ content: `Tool results: ${JSON.stringify(results)}\nNow reply` }])
    expect(out).not.toContain(recordedId)
  })

  it('returns no replay lines and no model for malformed sample shape', () => {
    expect(Array.isArray(replayLines())).toBe(true)
    expect(Object.keys(samples.turns || {}).length).toBeGreaterThan(0)
    expect(normalize('  Hi, THERE!!  ')).toBe('hi there')
  })

  it('development stub routes unmatched input through its generic invoice branch', async () => {
    const model = devStubModel('zzz qqq nothing actionable')
    const first = await model([{ content: 'Transcript' }])
    expect(JSON.parse(first.text).calls[0].tool).toBe('find_customer')
  })

  it('development stub gives a consistent answer for overlapping cash and reminder words', async () => {
    const model = devStubModel('remind Dave about cash paid')
    const first = await model([{ content: 'Transcript' }])
    expect(JSON.parse(first.text).calls.map((call) => call.tool)).toEqual(['find_customer', 'open_invoices'])
  })
})
