import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyStatus } from '../../src/state/money.js'
import { seedWorkspace, job, nextId, pushNotice, pushPanel, publicView } from '../../src/state/workspace.js'
import { acceptOffer, releaseExpired } from '../../src/state/holds.js'
import { handleWebhook } from '../../src/paypal/webhooks.js'
import { resetTokenCache, getToken } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { PayPalError, RecipientError, createInvoice, findByNumber, getInvoice, idFromLink, invoiceQr, qrFromMultipart, readInvoice, recordCash, remindInvoice, cancelInvoice, sendInvoice, resolveRecipient } from '../../src/paypal/invoices.js'
import { d1Ledger, kvCounter, memoryLedger, memoryCounter } from '../../src/ai/budget.js'
import { proposeInvoiceDraft, sendDraft } from '../../src/flows/send.js'
import { recordCashTap } from '../../src/flows/cash.js'
import { cleanReminder, sendReminderTap } from '../../src/flows/reminders.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { actualNeurons } from '../../src/caps.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const ENV = { PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', PAYPAL_BUYER_EMAIL: 'persona-buyer@sandbox.test' }
const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tx-coverage',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': '2026-10-28T14:00:00Z',
}

beforeEach(() => resetTokenCache())
afterEach(() => vi.unstubAllGlobals())

function invoiceWs(status = 'SENT') {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  ws.invoices.I1 = { id: 'I1', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '25.00', due: '25.00', status, reminders: 0 }
  return ws
}

describe('invoice money transitions', () => {
  it('pays a non deposit invoice once and ignores repeated paid states', () => {
    const ws = invoiceWs()
    expect(applyStatus(ws, 'I1', 'PAID', 10, { source: 'webhook' })).toBe(true)
    expect(ws.invoices.I1).toMatchObject({ status: 'PAID', due: '0.00', paidAt: 10, paidBy: 'webhook' })
    expect(job(ws, 'j2').state).toBe('paid')
    expect(ws.notices.at(-1).text).toBe('Maria Lopez paid 25.00.')
    expect(applyStatus(ws, 'I1', 'PAID_EXTERNAL', 11)).toBe(false)
    expect(ws.notices).toHaveLength(1)
  })

  it('pays an invoice without a job and uses the fallback customer name', () => {
    const ws = invoiceWs()
    ws.invoices.I1.jobId = undefined
    ws.invoices.I1.customerId = 'missing'
    ws.invoices.I1.cash = true
    expect(applyStatus(ws, 'I1', 'MARKED_AS_PAID', 12)).toBe(true)
    expect(ws.notices.at(-1).text).toBe('A customer paid 25.00 in cash.')
    expect(ws.invoices.I1.paidBy).toBeUndefined()
  })

  it('ends a live deposit hold as paid and does not create a second paid notice', () => {
    const ws = invoiceWs()
    ws.invoices.I1.kind = 'deposit'
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z' })
    expect(applyStatus(ws, 'I1', 'PAID', 20)).toBe(true)
    expect(ws.holds[0].ended).toBe('paid')
    expect(job(ws, 'j2')).toMatchObject({ state: 'booked', depositPaid: true })
    expect(ws.invoices.I1.status).toBe('PAID')
    expect(applyStatus(ws, 'I1', 'PAID', 21)).toBe(false)
    expect(ws.notices).toHaveLength(1)
  })

  it('cancels an invoice and its live hold once', () => {
    const ws = invoiceWs()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z' })
    expect(applyStatus(ws, 'I1', 'CANCELLED', 30)).toBe(true)
    expect(ws.invoices.I1.status).toBe('CANCELLED')
    expect(ws.holds[0].ended).toBe('released')
    expect(job(ws, 'j2').state).toBe('released')
    expect(applyStatus(ws, 'I1', 'CANCELLED', 31)).toBe(false)
  })

  it('cancels without a hold, changes other unpaid statuses, and ignores unknown or unchanged statuses', () => {
    const ws = invoiceWs()
    expect(applyStatus(ws, 'I1', 'CANCELLED', 1)).toBe(true)
    expect(applyStatus(ws, 'I1', 'CANCELLED', 2)).toBe(false)
    ws.invoices.I1.status = 'SENT'
    expect(applyStatus(ws, 'I1', 'PARTIALLY_PAID', 3, { due: '10.00', paid: '15.00' })).toBe(true)
    expect(ws.invoices.I1).toMatchObject({ status: 'PARTIALLY_PAID', due: '10.00' })
    expect(applyStatus(ws, 'missing', 'PAID', 4)).toBe(false)
    expect(applyStatus(ws, 'I1', 'PARTIALLY_PAID', 5)).toBe(false)
    expect(applyStatus(ws, 'I1', '', 6)).toBe(false)
  })

  it('does not replace a paid state with a later non paid status', () => {
    const ws = invoiceWs('PAID')
    expect(applyStatus(ws, 'I1', 'SENT', 9)).toBe(false)
    expect(ws.invoices.I1.status).toBe('PAID')
  })
})

describe('holds when PayPal or the owner repeats an action', () => {
  it('leaves a hold active when reading its invoice fails', async () => {
    const ws = invoiceWs()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    const actions = await releaseExpired(ws, { api: { request: async () => { throw Error('offline') } }, now: 100 })
    expect(actions).toEqual([])
    expect(ws.holds[0].ended).toBeUndefined()
    expect(job(ws, 'j2').state).toBe('booked')
  })

  it('leaves a hold active when PayPal refuses the cancellation', async () => {
    const ws = invoiceWs()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    let calls = 0
    const api = { request: async ({ method }) => method === 'GET' ? { ok: true, json: { id: 'I1', status: 'SENT', amount: { value: '25.00' } } } : (calls++, { ok: false, status: 500 }) }
    const actions = await releaseExpired(ws, { api, now: 100 })
    expect(actions).toEqual([])
    expect(calls).toBe(1)
    expect(ws.holds[0].ended).toBeUndefined()
  })

  it('releases a hold PayPal already cancelled and offers the slot to a fitting waiting job', async () => {
    const ws = invoiceWs()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    const api = { request: async () => ({ ok: true, json: { id: 'I1', status: 'CANCELLED' } }) }
    const actions = await releaseExpired(ws, { api, now: 100 })
    expect(actions).toEqual(['Hold ran out on Thu 29 Oct 9:00. Slot freed.'])
    expect(ws.holds[0].ended).toBe('released')
    expect(job(ws, 'j2').state).toBe('released')
    expect(job(ws, 'j5').state).toBe('offered')
  })

  it('does not send an already accepted offer twice', async () => {
    const ws = invoiceWs()
    ws.drafts.d1 = { id: 'd1', jobId: 'j5' }
    ws.offers.o1 = { id: 'o1', draftId: 'd1', jobId: 'j5', accepted: true }
    let calls = 0
    await acceptOffer(ws, 'o1', { api: { request: async () => calls++ }, env: ENV, now: NOW })
    await acceptOffer(ws, 'missing', { api: { request: async () => calls++ }, env: ENV, now: NOW })
    expect(calls).toBe(0)
  })

  it('skips live holds and ignores offers that failed to send before marking accepted', async () => {
    const ws = invoiceWs()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 200 })
    expect(await releaseExpired(ws, { api: { request: async () => { throw Error('not expired') } }, now: 100 })).toEqual([])
    ws.offers.o1 = { id: 'o1', draftId: 'absent', jobId: 'j5' }
    await expect(acceptOffer(ws, 'o1', { api: { request: async () => { throw Error('not sent') } }, env: ENV, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ws.offers.o1.accepted).toBeUndefined()
  })
})

describe('PayPal webhooks', () => {
  function webhookSetup(verification = 'SUCCESS') {
    const kv = memoryKV()
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: verification } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH1' }
    const waits = []
    const ctx = { waitUntil: (promise) => waits.push(promise) }
    return { kv, pp, env, ctx, settle: () => Promise.all(waits) }
  }

  const request = (body, headers = HEADERS) => new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body })

  it('rejects malformed JSON and missing webhook configuration before verification', async () => {
    const malformed = webhookSetup()
    expect((await handleWebhook(request('{'), malformed.env, malformed.ctx, { fetch: malformed.pp.fetch })).status).toBe(400)
    const noId = webhookSetup()
    delete noId.env.PAYPAL_WEBHOOK_ID
    expect((await handleWebhook(request('{}'), noId.env, noId.ctx, { fetch: noId.pp.fetch })).status).toBe(503)
    expect(noId.pp.calls).toHaveLength(0)
  })

  it('records a failed signature check for an indexed invoice', async () => {
    const s = webhookSetup('FAILURE')
    await s.kv.put('inv:I1', 'w1')
    await s.kv.put('ws:w1', JSON.stringify(invoiceWs()))
    const body = JSON.stringify({ id: 'evt1', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'I1' } })
    expect((await handleWebhook(request(body), s.env, s.ctx, { fetch: s.pp.fetch })).status).toBe(400)
    await s.settle()
    const after = JSON.parse(await s.kv.get('ws:w1'))
    expect(after.invoices.I1.status).toBe('SENT')
    expect(after.panel.at(-1).kind).toBe('guard')
  })

  it('applies REFUNDED resource status after verifying an indexed event', async () => {
    const s = webhookSetup()
    await s.kv.put('inv:I1', 'w1')
    await s.kv.put('ws:w1', JSON.stringify(invoiceWs()))
    const body = JSON.stringify({ id: 'evt2', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { id: 'I1', status: 'REFUNDED' } })
    expect((await handleWebhook(request(body), s.env, s.ctx, { fetch: s.pp.fetch, now: () => 42 })).status).toBe(200)
    await s.settle()
    expect(JSON.parse(await s.kv.get('ws:w1')).invoices.I1.status).toBe('REFUNDED')
  })

  it('uses resource status when the event type has no mapping', async () => {
    const s = webhookSetup()
    await s.kv.put('inv:I1', 'w1')
    await s.kv.put('ws:w1', JSON.stringify(invoiceWs()))
    const body = JSON.stringify({ id: 'evt3', event_type: 'INVOICING.INVOICE.UPDATED', resource: { id: 'I1', status: 'SENT' } })
    await handleWebhook(request(body), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    expect(JSON.parse(await s.kv.get('ws:w1')).invoices.I1.status).toBe('SENT')
  })

  it('verifies and drops another app invoice without recording an event', async () => {
    const s = webhookSetup('FAILURE')
    const body = JSON.stringify({ id: 'evt-other', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'OTHER' } })
    expect((await handleWebhook(request(body), s.env, s.ctx, { fetch: s.pp.fetch })).status).toBe(400)
    await s.settle()
    expect(await s.kv.get('evt:evt-other')).toBeNull()
    expect([...s.kv.keys()].some((key) => key.startsWith('ws:'))).toBe(false)
  })

  it('does not change an invoice for an unmapped event with no resource status', async () => {
    const s = webhookSetup()
    await s.kv.put('inv:I1', 'w1')
    await s.kv.put('ws:w1', JSON.stringify(invoiceWs()))
    const body = JSON.stringify({ id: 'evt-empty-status', event_type: 'INVOICING.INVOICE.UPDATED', resource: { id: 'I1' } })
    await handleWebhook(request(body), s.env, s.ctx, { fetch: s.pp.fetch })
    await s.settle()
    expect(JSON.parse(await s.kv.get('ws:w1')).invoices.I1.status).toBe('SENT')
  })
})

describe('PayPal client responses and token minting', () => {
  it('returns no connection after four dropped requests and backs off', async () => {
    const delays = []
    const entries = []
    const api = createPayPal(ENV, { fetch: async (input) => {
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 4000 })
      throw Error('disconnected')
    }, sleep: async (ms) => delays.push(ms), now: () => 100, log: (entry) => entries.push(entry) })
    const out = await api.request({ method: 'GET', path: '/disconnected', label: 'offline check' })
    expect(out).toMatchObject({ status: 0, ok: false, errorName: 'NO_CONNECTION' })
    expect(delays).toEqual([400, 800, 1600])
    expect(entries.at(-1)).toMatchObject({ path: 'offline check', status: 0, errorName: 'NO_CONNECTION' })
  })

  it('returns a dropped connection without logging when no logger was supplied', async () => {
    const api = createPayPal(ENV, { fetch: async (input) => {
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 4000 })
      throw Error('offline')
    }, sleep: async () => {} })
    expect(await api.request({ method: 'GET', path: '/offline' })).toMatchObject({ status: 0, errorName: 'NO_CONNECTION' })
  })

  it('reads empty, plain text, and PayPal debug header responses', async () => {
    const replies = [new Response(null, { status: 204 }), new Response('plain response', { status: 200, headers: { 'content-type': 'text/plain' } }), new Response('oops', { status: 502, headers: { 'content-type': 'text/plain', 'paypal-debug-id': 'dbg-header' } })]
    const api = createPayPal(ENV, { fetch: async (input) => String(input).includes('/oauth2/token') ? Response.json({ access_token: 'tok', expires_in: 4000 }) : replies.shift(), sleep: async () => {} })
    expect(await api.request({ method: 'POST', path: '/empty' })).toMatchObject({ status: 204, ok: true, text: '', json: null })
    expect(await api.request({ method: 'GET', path: '/plain' })).toMatchObject({ status: 200, text: 'plain response', json: null })
    expect(await api.request({ method: 'GET', path: '/bad' })).toMatchObject({ status: 502, debugId: 'dbg-header', json: null })
  })

  it('uses the default fetch and backoff when a request is rate limited', async () => {
    let apiCalls = 0
    vi.stubGlobal('fetch', async (input) => {
      if (String(input).includes('/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 4000 })
      apiCalls++
      return apiCalls === 1 ? new Response(null, { status: 429 }) : Response.json({ status: 'ok' })
    })
    const api = createPayPal(ENV)
    expect(await api.request({ method: 'GET', path: '/retry' })).toMatchObject({ status: 200, json: { status: 'ok' } })
    expect(apiCalls).toBe(2)
  })

  it('shares one in flight token mint and rejects missing credentials', async () => {
    let release
    let calls = 0
    const fetch = async () => { calls++; await new Promise((resolve) => { release = resolve }); return Response.json({ access_token: 'shared', expires_in: 4000 }) }
    const first = getToken(ENV, { fetch })
    const second = getToken(ENV, { fetch })
    await Promise.resolve()
    release()
    expect(await Promise.all([first, second])).toEqual(['shared', 'shared'])
    expect(calls).toBe(1)
    resetTokenCache()
    await expect(getToken({ PAYPAL_CLIENT_ID: 'id' }, { fetch })).rejects.toThrow('PayPal keys are not set')
  })
})

describe('PayPal invoice helpers', () => {
  const apiWith = (reply) => ({ request: async () => typeof reply === 'function' ? reply() : reply })

  it('extracts invoice ids and QR images from multipart and plain body forms', () => {
    expect(idFromLink(null)).toBeNull()
    expect(idFromLink({ id: 'I1' })).toBe('I1')
    expect(idFromLink({ href: 'https://api.test/v2/invoicing/invoices/I2-3' })).toBe('I2-3')
    expect(idFromLink({ href: 'https://api.test/not-an-invoice' })).toBeNull()
    expect(qrFromMultipart('iVBORplain==\n')).toBe('iVBORplain==')
    expect(qrFromMultipart('--boundary without headers')).toBeNull()
    expect(qrFromMultipart('prefix\r\n\r\niVBORbase64\r\n--boundary--')).toBe('iVBORbase64')
    expect(qrFromMultipart('prefix\r\n\r\nnot png\r\n--boundary--')).toBeNull()
  })

  it('reports invoice errors and returns null for optional or missing PayPal data', async () => {
    const failed = { ok: false, status: 500, json: { name: 'BAD', details: [] }, debugId: 'dbg', errorName: 'BAD' }
    expect(() => resolveRecipient('persona:buyer', {})).toThrow(RecipientError)
    expect(resolveRecipient('a@example.com', {})).toBe('a@example.com')
    expect(() => resolveRecipient('a@outside.test', {})).toThrow(RecipientError)
    expect(readInvoice({ id: 'I', amount: { value: '8.00', currency_code: 'USD' } })).toMatchObject({ due: '8.00', total: '8.00', currency: 'USD' })
    await expect(createInvoice(apiWith(failed), {}, 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(createInvoice(apiWith(failed), { detail: { invoice_number: 'JD-1' } }, 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(getInvoice(apiWith(failed), 'I')).rejects.toMatchObject({ code: 'PAYPAL', status: 500 })
    await expect(recordCash(apiWith(failed), 'I', { amount: '1', currency: 'USD', date: '2026-01-01' }, 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(remindInvoice(apiWith(failed), 'I', { subject: 's', note: 'n' }, 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(cancelInvoice(apiWith(failed), 'I', 'note', 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(invoiceQr(apiWith(failed), 'I', 'r')).resolves.toBeNull()
    await expect(sendInvoice(apiWith(failed), 'I', 'r')).rejects.toBeInstanceOf(PayPalError)
    await expect(findByNumber(apiWith(failed), 'JD-1')).resolves.toBeNull()
  })

  it('accepts a failed send only when a follow up read shows it left draft', async () => {
    let calls = 0
    const api = { request: async () => (++calls === 1 ? { ok: false, status: 422, json: {} } : { ok: true, json: { id: 'I', status: 'SENT' } }) }
    await expect(sendInvoice(api, 'I', 'r')).resolves.toBeUndefined()
    const stillDraft = { request: async () => ({ ok: false, status: 422, json: {} }) }
    await expect(sendInvoice(stillDraft, 'I', 'r')).rejects.toBeInstanceOf(PayPalError)
  })
})

describe('ledger adapters and store behavior', () => {
  it('queries D1 totals by day or app and inserts a timestamped usage row', async () => {
    const calls = []
    const db = { prepare: (sql) => ({ bind: (...args) => ({ first: async () => (calls.push({ sql, args }), sql.includes('RETURNING id') ? { id: 7 } : { total: '4.5' }), run: async () => calls.push({ sql, args }) }) }) }
    const ledger = d1Ledger(db)
    expect(await ledger.dayTotal('day')).toBe(4.5)
    expect(await ledger.dayTotal('day', 'app')).toBe(4.5)
    await ledger.add('day', 'app', 2)
    await ledger.settle(7, 1.5)
    expect(calls[0].args).toEqual(['day'])
    expect(calls[1].args).toEqual(['day', 'app'])
    expect(calls[2].args.slice(0, 3)).toEqual(['app', 'day', 2])
    expect(calls[2].args[3]).toEqual(expect.any(Number))
    expect(calls[3]).toEqual({ sql: 'UPDATE ai_calls SET neurons = ?2 WHERE id = ?1', args: [7, 1.5] })
    expect(await memoryLedger().dayTotal('empty')).toBe(0)
    expect(await memoryCounter().get('empty')).toBe(0)
  })

  it('covers the KV and PayPal test adapters', async () => {
    const kv = memoryKV()
    await kv.put('value', '{"ok":true}')
    expect(await kv.get('value', 'json')).toEqual({ ok: true })
    expect(await kv.get('missing')).toBeNull()
    expect([...kv.keys()]).toEqual(['value'])
    expect(kv.writes()).toBe(1)
    await kv.delete('value')
    expect([...kv.keys()]).toEqual([])

    const fake = fakePayPal({ 'GET /resource': [{ status: 200, body: 'ok' }] })
    expect((await fake.fetch('https://paypal.test/resource')).status).toBe(200)
    expect((await fake.fetch(new Request('https://paypal.test/resource'))).status).toBe(200)
    expect((await fake.fetch('https://paypal.test/unlisted')).status).toBe(404)
    expect(fake.calls).toHaveLength(3)
  })

  it('reads and increments KV counters with TTL and invalid value handling', async () => {
    const kv = memoryKV()
    const counter = kvCounter(kv, 99)
    expect(await counter.get('n')).toBe(0)
    expect(await counter.add('n', 2.5)).toBe(2.5)
    expect(await counter.get('n')).toBe(2.5)
    await kv.put('bad', 'not a number')
    expect(await counter.get('bad')).toBe(0)
    expect(await counter.add('bad', 3)).toBe(3)
    expect(actualNeurons({ prompt_tokens: 100, completion_tokens: 20 })).toBeGreaterThan(0)
    expect(actualNeurons({ prompt_tokens: 100 })).toBeNull()
  })

  it('rejects invalid workspace ids and only flushes changed counters', async () => {
    const store = await import('../../src/store.js')
    const kv = memoryKV()
    const env = { JOBDONE: kv }
    expect(await store.loadWs(env, '')).toBeNull()
    expect(await store.loadWs(env, 'Bad_ID')).toBeNull()
    expect(await store.loadWs(env, 'absent')).toBeNull()
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    await store.saveWs(env, ws)
    await store.indexInvoice(env, 'I1', 'w1')
    expect(await store.loadWs(env, 'w1')).toEqual(ws)
    expect(await kv.get('inv:I1')).toBe('w1')
    const counter = await store.loadCounter(env, 'count')
    expect(counter.get('missing')).toBe(0)
    await counter.flush(7)
    expect(await kv.get('count')).toBeNull()
    counter.add('sent', 2)
    await counter.flush(7)
    expect(counter.value).toEqual({ sent: 2 })
    expect((await store.loadCounter(env, 'count')).get('sent')).toBe(2)
  })

  it('increments ids and bounds notice and panel history', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    expect(nextId(ws, 'x')).toBe('x11')
    for (let i = 0; i < 35; i++) pushNotice(ws, { at: i, text: String(i) })
    for (let i = 0; i < 65; i++) pushPanel(ws, { kind: 'test', at: i })
    expect(ws.notices).toHaveLength(30)
    expect(ws.notices[0].text).toBe('5')
    expect(ws.panel).toHaveLength(60)
    expect(ws.panel[0].n).toBe(41)
    expect(publicView(ws).customers[0].email).toBe('PayPal sandbox buyer')
  })
})

describe('draft recovery', () => {
  it('requires an existing draft and customer without making a PayPal request', async () => {
    const ws = invoiceWs()
    const api = { request: async () => { throw Error('should not request') } }
    await expect(sendDraft(ws, 'missing', { api, env: ENV, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    const draft = proposeInvoiceDraft(ws, { customerId: 'missing', priced: {}, summary: 'Missing customer' })
    await expect(sendDraft(ws, draft.id, { api, env: ENV, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('resumes after sending failed and stores a deposit invoice without changing the job state', async () => {
    const ws = invoiceWs()
    const draft = proposeInvoiceDraft(ws, { customerId: 'c1', jobId: 'j2', kind: 'deposit', priced: { currency: 'USD', taxPercent: '0', total: '10.00', lines: [] }, summary: 'Deposit' })
    const calls = []
    let firstRead = true
    const api = { request: async ({ path }) => {
      calls.push(path)
      if (path === '/v2/invoicing/invoices') return { ok: true, json: { id: 'I2' } }
      if (path.endsWith('/send')) return { ok: false, status: 500, json: { name: 'NO' } }
      if (path.endsWith('/I2')) return { ok: true, json: { id: 'I2', status: firstRead ? 'DRAFT' : 'SENT', amount: { value: '10.00' }, due_amount: { value: '10.00' } } }
      return { ok: true, text: 'iVBOR==', json: null }
    } }
    await expect(sendDraft(ws, draft.id, { api, env: ENV, now: NOW })).rejects.toBeInstanceOf(PayPalError)
    expect(draft.invoiceId).toBe('I2')
    expect(draft.sentAt).toBeUndefined()
    firstRead = false
    api.request = async ({ path }) => {
      calls.push(path)
      if (path.endsWith('/send')) return { ok: true }
      if (path.endsWith('/generate-qr-code')) return { ok: true, text: 'iVBOR==', json: null }
      return { ok: true, json: { id: 'I2', status: 'SENT', amount: { value: '10.00' }, due_amount: { value: '10.00' } } }
    }
    await sendDraft(ws, draft.id, { api, env: ENV, now: NOW + 1 })
    expect(calls.filter((path) => path === '/v2/invoicing/invoices')).toHaveLength(1)
    expect(job(ws, 'j2').depositInvoiceId).toBe('I2')
    expect(job(ws, 'j2').state).toBe('booked')
  })
})

describe('cash and reminder safeguards', () => {
  function cashWorkspace() {
    const ws = invoiceWs()
    ws.invoices.I1.due = '25.00'
    return ws
  }

  it('refuses missing invoices and invalid cash amounts before writing payment state', async () => {
    const ws = cashWorkspace()
    const api = { request: async () => ({ ok: true, json: { id: 'I1', status: 'SENT', due_amount: { value: '25.00' }, amount: { value: '25.00' } } }) }
    await expect(recordCashTap(ws, 'absent', '1', { api, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    await expect(recordCashTap(ws, 'I1', 'not a number', { api, now: NOW })).rejects.toMatchObject({ code: 'CASH_BAD' })
    expect(ws.invoices.I1).toMatchObject({ status: 'SENT', due: '25.00' })
  })

  it('keeps the invoice unchanged when recording cash fails and uses a later invoice date when paying succeeds', async () => {
    const ws = cashWorkspace()
    const live = { id: 'I1', status: 'SENT', due_amount: { value: '25.00' }, amount: { value: '25.00' }, detail: { invoice_date: '2026-11-01' } }
    const failed = { request: async ({ method }) => method === 'GET' ? { ok: true, json: live } : { ok: false, status: 500, json: {} } }
    await expect(recordCashTap(ws, 'I1', '10', { api: failed, now: NOW })).rejects.toMatchObject({ code: 'PAYPAL' })
    expect(ws.invoices.I1).toMatchObject({ status: 'SENT', due: '25.00' })
    let payment
    let reads = 0
    const succeeded = { request: async ({ method, body }) => {
      if (method !== 'GET') { payment = body; return { ok: true } }
      reads++
      return { ok: true, json: reads === 1 ? live : { ...live, status: 'MARKED_AS_PAID', due_amount: { value: '0.00' } } }
    } }
    await recordCashTap(ws, 'I1', '10', { api: succeeded, now: NOW })
    expect(payment.payment_date).toBe('2026-11-01')
    expect(ws.invoices.I1).toMatchObject({ status: 'MARKED_AS_PAID', due: '0.00', cash: true })
  })

  it('counts zero reminder age without a sent date and reports missing or failed reminder sends', async () => {
    expect(cleanReminder('Please pay 25.00', { due: '25.00' }, NOW)).toContain('25.00')
    const ws = invoiceWs()
    await expect(sendReminderTap(ws, 'absent', 'Hello', { api: {}, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    ws.invoices.I1.reminders = 2
    const failed = { request: async () => ({ ok: false, status: 500, json: {} }) }
    await expect(sendReminderTap(ws, 'I1', 'Hello, 25.00 is due.', { api: failed, now: NOW })).rejects.toMatchObject({ code: 'PAYPAL' })
    expect(ws.invoices.I1.reminders).toBe(2)
  })
})
