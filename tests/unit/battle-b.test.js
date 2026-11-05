import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPayPal } from '../../src/paypal/client.js'
import { getToken, resetTokenCache } from '../../src/paypal/token.js'
import { createInvoice, getInvoice, invoiceQr, recordCash, remindInvoice } from '../../src/paypal/invoices.js'
import { DAILY_NEURONS, MAX_AUDIO_SECONDS } from '../../src/caps.js'
import { createBudget, d1Ledger, memoryCounter, memoryLedger } from '../../src/ai/budget.js'
import { runModel } from '../../src/ai/model.js'
import { readWav, transcribe } from '../../src/ai/whisper.js'
import { proposeInvoiceDraft, sendDraft } from '../../src/flows/send.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import worker from '../../src/worker.js'
import { fakePayPal, ENV } from './fake-paypal.js'
import { memoryKV } from './memory-kv.js'

const DAY = '2026-10-23'
const invoiceBody = { detail: { invoice_number: 'JD-ONE' } }
const baseInvoice = '/v2/invoicing/invoices/INV2-A'

beforeEach(() => resetTokenCache())
afterEach(() => vi.unstubAllGlobals())

function apiFor(script, overrides = {}) {
  const pp = fakePayPal(script)
  return { api: createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {}, ...overrides }), pp }
}

function wav(seconds, { rate = 16000, channels = 1, bits = 16, dataSize } = {}) {
  const dataBytes = dataSize ?? Math.round(seconds * rate * channels * (bits / 8))
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const put = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  put(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * (bits / 8), true)
  view.setUint16(32, channels * (bits / 8), true)
  view.setUint16(34, bits, true)
  put(36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}

function fakeD1(rows = []) {
  let nextId = rows.length + 1
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this },
        async first() {
          if (sql.includes('RETURNING id')) {
            const [app, day, neurons, at, accountLimit, dailyLimit] = this.args
            const accountTotal = rows.filter((row) => row.day === day).reduce((sum, row) => sum + row.neurons, 0)
            const appTotal = rows.filter((row) => row.day === day && row.app === app).reduce((sum, row) => sum + row.neurons, 0)
            if (accountTotal + neurons <= accountLimit && appTotal + neurons <= dailyLimit) {
              const id = nextId++
              rows.push({ id, app, day, neurons, at })
              return { id }
            }
            return null
          }
          const [day, app] = this.args
          return { total: rows.filter((row) => row.day === day && (app === undefined || row.app === app)).reduce((sum, row) => sum + row.neurons, 0) }
        },
        async run() {
          const [app, day, neurons, at, accountLimit, dailyLimit] = this.args
          const accountTotal = rows.filter((row) => row.day === day).reduce((sum, row) => sum + row.neurons, 0)
          const appTotal = rows.filter((row) => row.day === day && row.app === app).reduce((sum, row) => sum + row.neurons, 0)
          if (sql.includes('SELECT ?1') && accountTotal + neurons <= accountLimit && appTotal + neurons <= dailyLimit) {
            rows.push({ app, day, neurons, at })
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
    },
  }
}

describe('PayPal response attacks', () => {
  const operations = [
    ['create', 'POST', '/v2/invoicing/invoices'],
    ['read', 'GET', baseInvoice],
    ['send', 'POST', `${baseInvoice}/send`],
    ['QR', 'POST', `${baseInvoice}/generate-qr-code`],
    ['payments', 'POST', `${baseInvoice}/payments`],
    ['remind', 'POST', `${baseInvoice}/remind`],
  ]

  for (const status of [500, 502, 503, 504]) {
    for (const [name, method, path] of operations) {
      it(`${name} handles HTTP ${status}`, async () => {
        const { api } = apiFor({ [`${method} ${path}`]: [{ status, body: { name: 'SERVER_ERROR' } }] })
        if (name === 'QR') {
          const result = await invoiceQr(api, 'INV2-A', 'rid')
          expect(result).toBe(null)
        } else {
          await expect(operationWithApi(name, api)).rejects.toMatchObject({ status })
        }
      })
    }
  }

  it('bounds an outbound request that never answers', async () => {
    let calls = 0
    const api = createPayPal(ENV, { fetch: async (input) => {
      calls++
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 })
      return new Promise(() => {})
    }, timeoutMs: 20 })
    const result = await Promise.race([
      api.request({ method: 'GET', path: baseInvoice }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('request did not time out')), 100)),
    ])
    expect(result).toMatchObject({ status: 0, errorName: 'TIMEOUT' })
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('uses a bounded token request when the token endpoint never answers', async () => {
    await expect(getToken(ENV, { fetch: async () => new Promise(() => {}), timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('bounds a token body that never finishes decoding', async () => {
    const fetch = async () => {
      const response = new Response(null, { status: 200 })
      response.json = () => new Promise(() => {})
      return response
    }
    await expect(getToken(ENV, { fetch, timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('bounds a response body that stops after the HTTP headers arrive', async () => {
    const fetch = async (input) => {
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 })
      const response = new Response(null, { status: 200 })
      response.text = () => new Promise(() => {})
      return response
    }
    const api = createPayPal(ENV, { fetch, timeoutMs: 20 })
    expect(await api.request({ method: 'GET', path: baseInvoice })).toMatchObject({ status: 0, errorName: 'TIMEOUT' })
  })

  it('does not retry server failures or a thrown network error forever', async () => {
    const { api, pp } = apiFor({ [`GET ${baseInvoice}`]: [{ status: 503, body: {} }] })
    const response = await api.request({ method: 'GET', path: baseInvoice })
    expect(response.status).toBe(503)
    expect(pp.calls.filter((call) => call.path === baseInvoice).length).toBe(1)
    let attempts = 0
    const thrown = createPayPal(ENV, { fetch: async (input) => {
      attempts++
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 't', expires_in: 3600 })
      throw new Error('offline')
    }, sleep: async () => {} })
    expect(await thrown.request({ method: 'GET', path: baseInvoice })).toMatchObject({ status: 0, errorName: 'NO_CONNECTION' })
    expect(attempts).toBe(4)
  })

  it('bounds a long Retry After response instead of sleeping an hour', async () => {
    const waits = []
    const { api } = apiFor({ [`GET ${baseInvoice}`]: [{ status: 429, headers: { 'retry-after': '3600' }, body: {} }] }, { sleep: async (ms) => waits.push(ms) })
    const response = await api.request({ method: 'GET', path: baseInvoice })
    expect(response.status).toBe(429)
    expect(Math.max(...waits)).toBeLessThanOrEqual(5000)
  })

  it('honours a short Retry After value and uses backoff when it is absent', async () => {
    const waits = []
    const { api } = apiFor({ [`GET ${baseInvoice}`]: [
      { status: 429, headers: { 'retry-after': '2' }, body: {} },
      { status: 429, body: {} },
      { status: 200, body: { id: 'INV2-A', status: 'DRAFT' } },
    ] }, { sleep: async (ms) => waits.push(ms) })
    expect((await api.request({ method: 'GET', path: baseInvoice })).status).toBe(200)
    expect(waits[0]).toBe(2000)
    expect(waits[1]).toBeGreaterThan(0)
  })

  it('parses an HTTP date in Retry After and falls back for a malformed value', async () => {
    const now = Date.parse('2026-10-23T12:00:00Z')
    const waits = []
    const { api } = apiFor({ [`GET ${baseInvoice}`]: [
      { status: 429, headers: { 'retry-after': 'Fri, 23 Oct 2026 12:00:02 GMT' }, body: {} },
      { status: 429, headers: { 'retry-after': 'later' }, body: {} },
      { status: 200, body: { id: 'INV2-A', status: 'DRAFT' } },
    ] }, { now: () => now, sleep: async (ms) => waits.push(ms) })
    expect((await api.request({ method: 'GET', path: baseInvoice })).status).toBe(200)
    expect(waits).toEqual([2000, 800])
  })

  it('does not loop when two consecutive API replies are unauthorized', async () => {
    const { api, pp } = apiFor({ [`GET ${baseInvoice}`]: [{ status: 401, body: {} }] })
    expect((await api.request({ method: 'GET', path: baseInvoice })).status).toBe(401)
    expect(pp.tokenFetches()).toBe(2)
    expect(pp.calls.filter((call) => call.path === baseInvoice).length).toBe(2)
  })

  it('rejects missing token fields and a token with zero lifetime', async () => {
    const missing = fakePayPal({ 'POST /v1/oauth2/token': [{ status: 200, body: { expires_in: 3600 } }] })
    await expect(getToken(ENV, { fetch: missing.fetch })).rejects.toThrow()
    resetTokenCache()
    const emptyLifetime = fakePayPal({ 'POST /v1/oauth2/token': [{ status: 200, body: { access_token: 'stale', expires_in: 0 } }] })
    await expect(getToken(ENV, { fetch: emptyLifetime.fetch })).rejects.toThrow(/invalid/)
    expect(emptyLifetime.tokenFetches()).toBe(1)
  })

  it('survives a non JSON response body', async () => {
    const fetch = async (input) => String(input).includes('/oauth2/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : new Response('<html>oops</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    const api = createPayPal(ENV, { fetch })
    expect(await api.request({ method: 'GET', path: baseInvoice })).toMatchObject({ status: 502, json: null, text: '<html>oops</html>' })
  })

  it('turns a successful non JSON invoice body into a PayPal error instead of a crash', async () => {
    const { api } = apiFor({ [`GET ${baseInvoice}`]: [{ status: 200, body: '<html>not an invoice</html>', headers: { 'content-type': 'text/html' } }] })
    await expect(getInvoice(api, 'INV2-A')).rejects.toMatchObject({ code: 'PAYPAL', status: 502, errorName: 'INVALID_RESPONSE' })
  })

  it('does not accept an empty create response without an invoice href', async () => {
    const { api } = apiFor({ 'POST /v2/invoicing/invoices': [{ status: 201 }] })
    await expect(createInvoice(api, invoiceBody, 'rid')).rejects.toMatchObject({ status: 201 })
  })

  it('refuses a create href pointing to a different host', async () => {
    const { api } = apiFor({ 'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://evil.example/v2/invoicing/invoices/INV2-EVIL' } }] })
    await expect(createInvoice(api, invoiceBody, 'rid')).rejects.toMatchObject({ status: 201 })
  })

  it('accepts the create link host PayPal really sends, api.sandbox.paypal.com (read from a sandbox search, 23 Oct 2026)', async () => {
    const { api } = apiFor({ 'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-REAL', rel: 'self', method: 'GET' } }] })
    expect(await createInvoice(api, invoiceBody, 'rid')).toBe('INV2-REAL')
  })

  it('treats a QR answer that is not multipart as unavailable', async () => {
    const { api } = apiFor({ [`POST ${baseInvoice}/generate-qr-code`]: [{ status: 200, body: 'iVBORw0KGgo=' }] })
    expect(await invoiceQr(api, 'INV2-A', 'rid')).toBe(null)
  })

  it('does not search on an unrelated 422 and does not lose a duplicate when search finds nothing', async () => {
    const unrelated = apiFor({
      'POST /v2/invoicing/invoices': [{ status: 422, body: { details: [{ issue: 'INVALID_FIELD' }] } }],
      'POST /v2/invoicing/search-invoices': [{ status: 200, body: { items: [] } }],
    })
    await expect(createInvoice(unrelated.api, invoiceBody, 'rid')).rejects.toMatchObject({ status: 422 })
    expect(unrelated.pp.calls.some((call) => call.path.includes('search-invoices'))).toBe(false)
    const duplicate = apiFor({
      'POST /v2/invoicing/invoices': [{ status: 422, body: { details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] } }],
      'POST /v2/invoicing/search-invoices': [{ status: 200, body: { items: [] } }],
    })
    await expect(createInvoice(duplicate.api, invoiceBody, 'rid')).rejects.toMatchObject({ status: 422 })
  })
})

async function operationWithApi(name, api) {
  if (name === 'create') return createInvoice(api, invoiceBody, 'rid')
  if (name === 'read') return getInvoice(api, 'INV2-A')
  if (name === 'send') return import('../../src/paypal/invoices.js').then(({ sendInvoice }) => sendInvoice(api, 'INV2-A', 'rid'))
  if (name === 'payments') return recordCash(api, 'INV2-A', { amount: '1.00', currency: 'USD', date: DAY }, 'rid')
  if (name === 'remind') return remindInvoice(api, 'INV2-A', { subject: 'Due', note: 'Please pay' }, 'rid')
}

describe('invoice recovery attacks', () => {
  it('recovers a create timeout by invoice number and does not send the recovered invoice twice', async () => {
    let createAttempts = 0
    let invoiceExists = false
    let status = 'DRAFT'
    let sends = 0
    const fetch = async (input, init = {}) => {
      const url = new URL(input)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname === '/v2/invoicing/invoices' && init.method === 'POST') {
        createAttempts++
        if (!invoiceExists) {
          invoiceExists = true
          throw new Error('connection lost after create')
        }
        return Response.json({ details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] }, { status: 422 })
      }
      if (url.pathname.endsWith('/search-invoices')) return Response.json({ items: [{ id: 'INV2-RECOVERED' }] })
      if (url.pathname === `${baseInvoice}`.replace('INV2-A', 'INV2-RECOVERED') && init.method === 'GET') return Response.json({ id: 'INV2-RECOVERED', status, amount: { currency_code: 'USD', value: '10.00' }, due_amount: { value: '10.00' } })
      if (url.pathname.endsWith('/send')) {
        sends++
        status = 'SENT'
        throw new Error('connection lost after send')
      }
      if (url.pathname.endsWith('/generate-qr-code')) return new Response('--b1\r\nContent-Type: image/png\r\n\r\niVBORw0KGgo=\r\n--b1--', { status: 200, headers: { 'content-type': 'multipart/form-data; boundary=b1' } })
      return Response.json({ id: 'INV2-RECOVERED', status, amount: { currency_code: 'USD', value: '10.00' }, due_amount: { value: '10.00' } })
    }
    const env = { ...ENV, PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }
    const ws = seedWorkspace({ id: 'workshop1', now: 0, tzOffsetMinutes: 0 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', summary: 'Repair', priced: { currency: 'USD', taxPercent: 0, total: '10.00', lines: [{ name: 'Repair', quantity: '1', unitAmount: '10.00', uom: 'HOUR' }] } })
    const api = createPayPal(env, { fetch, sleep: async () => {} })
    await expect(sendDraft(ws, draft.id, { api, env, now: 1 })).rejects.toMatchObject({ status: 0 })
    expect(draft.invoiceId).toBeUndefined()
    await sendDraft(ws, draft.id, { api, env, now: 2 })
    await sendDraft(ws, draft.id, { api, env, now: 3 })
    expect(createAttempts).toBe(2)
    expect(sends).toBe(1)
    expect(Object.keys(ws.invoices)).toEqual(['INV2-RECOVERED'])
  })

  it('uses the fixed invoice number after a create timeout and never creates a second invoice', async () => {
    let creates = 0
    let searches = 0
    const fetch = async (input, init = {}) => {
      const url = new URL(input)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname === '/v2/invoicing/invoices' && init.method === 'POST') {
        creates++
        if (creates === 1) return new Response(JSON.stringify({ name: 'DUPLICATE', details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] }), { status: 422, headers: { 'content-type': 'application/json' } })
        return new Response(null, { status: 201 })
      }
      if (url.pathname.includes('search-invoices')) {
        searches++
        return Response.json({ items: [{ id: 'INV2-EXISTING' }] })
      }
      return Response.json({})
    }
    const api = createPayPal(ENV, { fetch, sleep: async () => {} })
    expect(await createInvoice(api, invoiceBody, 'same-create-id')).toBe('INV2-EXISTING')
    expect(creates).toBe(1)
    expect(searches).toBe(1)
  })

  it('does not count a lost send response as permission to send a draft twice', async () => {
    let sends = 0
    const api = { request: async ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/send')) {
        sends++
        return { status: 0, ok: false, json: null, text: '', contentType: '', ms: 1 }
      }
      if (method === 'GET') return { ok: true, json: { id: 'INV2-A', status: 'SENT' } }
    } }
    const { sendInvoice } = await import('../../src/paypal/invoices.js')
    await sendInvoice(api, 'INV2-A', 'same-send-id')
    expect(sends).toBe(1)
  })
})

describe('budget and model attacks', () => {
  it('admits only one of two simultaneous charges that together exceed the daily cap', async () => {
    const ledger = memoryLedger()
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    const outcomes = await Promise.all([
      budget.charge({ ipKey: 'ipA', day: DAY, neurons: 60 }),
      budget.charge({ ipKey: 'ipB', day: DAY, neurons: 60 }),
    ])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(60)
  })

  it('allows a charge exactly at the configured daily cap', async () => {
    const ledger = memoryLedger()
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    expect((await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 100 })).ok).toBe(true)
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(100)
  })

  it('reserves the shared daily cap atomically across separate budget instances', async () => {
    const db = fakeD1()
    const makeBudget = () => createBudget({ ledger: d1Ledger(db), perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    const outcomes = await Promise.all([
      makeBudget().charge({ ipKey: 'ipA', day: DAY, neurons: 60 }),
      makeBudget().charge({ ipKey: 'ipB', day: DAY, neurons: 60 }),
    ])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(await d1Ledger(db).dayTotal(DAY, 'job-done')).toBe(60)
  })

  it('reserves the account cap atomically when two workers race', async () => {
    const db = fakeD1([{ app: 'another-app', day: DAY, neurons: 9480 }])
    const makeBudget = () => createBudget({ ledger: d1Ledger(db), perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    const outcomes = await Promise.all([
      makeBudget().charge({ ipKey: 'ipA', day: DAY, neurons: 15 }),
      makeBudget().charge({ ipKey: 'ipB', day: DAY, neurons: 15 }),
    ])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.ok)).toEqual({ ok: false, reason: 'account' })
  })

  it('returns account and day reasons when an atomic reserve is denied', async () => {
    const dailyDb = fakeD1([{ app: 'job-done', day: DAY, neurons: 90 }])
    const daily = createBudget({ ledger: d1Ledger(dailyDb), perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    expect(await daily.charge({ ipKey: 'ipA', day: DAY, neurons: 20 })).toEqual({ ok: false, reason: 'day' })
    const accountDb = fakeD1([{ app: 'other', day: DAY, neurons: 9490 }])
    const account = createBudget({ ledger: d1Ledger(accountDb), perIp: memoryCounter(), app: 'job-done', dailyLimit: 100, ipLimit: 100 })
    expect(await account.charge({ ipKey: 'ipA', day: DAY, neurons: 20 })).toEqual({ ok: false, reason: 'account' })
  })

  it('refuses invalid neuron values without recording them or calling the model', async () => {
    for (const neurons of [-1, NaN, Infinity]) {
      const ledger = memoryLedger()
      const budget = {
        charge: async () => ({ ok: true }),
      }
      let called = false
      await expect(runModel({
        ai: { run: async () => { called = true; return { response: 'ok', usage: { prompt_tokens: neurons, completion_tokens: 0 } } } },
        budget,
        ipKey: 'ipA',
        day: DAY,
        messages: [{ role: 'user', content: 'hi' }],
      })).resolves.toMatchObject({ actual: null })
      expect(called).toBe(true)
      expect(await ledger.dayTotal(DAY)).toBe(0)
    }
  })

  it('rejects negative and NaN budget charges', async () => {
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
    expect(await budget.charge({ ipKey: 'ipA', day: DAY, neurons: -1 })).toEqual({ ok: false, reason: 'account' })
    expect(await budget.charge({ ipKey: 'ipA', day: DAY, neurons: NaN })).toEqual({ ok: false, reason: 'account' })
  })

  it('continues admitting calls after a ledger read rejects once', async () => {
    let reads = 0
    const ledger = { dayTotal: async () => { if (reads++ === 0) throw new Error('read failed'); return 0 }, add: async () => {} }
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    expect(await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 1 })).toEqual({ ok: false, reason: 'ledger' })
    expect((await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 1 })).ok).toBe(true)
  })

  it('recovers the serialized queue after an invalid caller input', async () => {
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
    await expect(budget.charge(null)).rejects.toThrow()
    expect((await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 1 })).ok).toBe(true)
  })

  it('returns a clear ledger refusal when a write fails before the model runs', async () => {
    let called = false
    const budget = createBudget({ ledger: { dayTotal: async () => 0, add: async () => { throw new Error('ledger unavailable') } }, perIp: memoryCounter(), app: 'job-done' })
    await expect(runModel({ ai: { run: async () => { called = true; return { response: 'ok' } } }, budget, ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'BUDGET', reason: 'ledger' })
    expect(called).toBe(false)
  })

  it('ignores malformed EXTRA_NEURONS instead of opening the full daily cap', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const rows = [{ app: 'job-done', day: today, neurons: DAILY_NEURONS }]
    let aiCalls = 0
    const kv = memoryKV()
    const env = {
      JOBDONE: kv,
      IP_SALT: 'salt',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      EXTRA_NEURONS: `${today}:many`,
      LEDGER: fakeD1(rows),
      AI: { run: async () => { aiCalls++; return { text: 'ok' } } },
    }
    vi.stubGlobal('fetch', fakePayPal({}).fetch)
    const ctx = { waitUntil: () => {} }
    const created = await worker.fetch(new Request('https://job-done.test/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env, ctx)
    const cookie = created.headers.get('set-cookie').split(';')[0]
    const response = await worker.fetch(new Request('https://job-done.test/api/voice', {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/wav', 'cf-connecting-ip': '198.51.100.8' },
      body: wav(1),
    }), env, ctx)
    expect(response.status).toBe(429)
    expect(aiCalls).toBe(0)
  })
})

describe('audio header attacks', () => {
  const run = (bytes, ai = { run: async () => ({ text: 'ok' }) }) => transcribe({ ai, budget: createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' }), ipKey: 'ipA', day: DAY, bytes })

  it('ignores a WAV data size smaller than the bytes actually sent', async () => {
    const bytes = wav(31)
    new DataView(bytes.buffer).setUint32(40, 32000, true)
    await expect(run(bytes)).rejects.toMatchObject({ status: 413 })
  })

  it('rejects zero sample rate, 8 bit samples, and stereo audio', async () => {
    await expect(run(wav(1, { rate: 0 }))).rejects.toMatchObject({ status: 415 })
    await expect(run(wav(1, { bits: 8 }))).rejects.toMatchObject({ status: 415 })
    await expect(run(wav(1, { channels: 2 }))).rejects.toMatchObject({ status: 415 })
  })

  it('rejects a WAV claiming more data than the actual body contains', async () => {
    const bytes = wav(1)
    new DataView(bytes.buffer).setUint32(40, 32000 * 60, true)
    expect(readWav(bytes).seconds).toBeLessThanOrEqual(MAX_AUDIO_SECONDS)
    await expect(run(bytes)).rejects.toMatchObject({ status: 415 })
  })

  it('rejects a real 60 second clip even when the request is under the byte cap', async () => {
    await expect(run(wav(60))).rejects.toMatchObject({ status: 413 })
  })
})
