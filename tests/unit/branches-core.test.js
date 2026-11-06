import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, job } from '../../src/state/workspace.js'
import { placeBooking, startHold, sendDeposit, depositPaid, invoiceCancelled, releaseExpired, acceptOffer } from '../../src/state/holds.js'
import { findSlots, clashes, moveJob, slotLabel } from '../../src/state/schedule.js'
import { applyStatus } from '../../src/state/money.js'
import { proposeInvoiceDraft, sendDraft, invoiceNumber } from '../../src/flows/send.js'
import { recordCashTap } from '../../src/flows/cash.js'
import { cleanReminder, sendReminderTap } from '../../src/flows/reminders.js'
import { handleWebhook, invoiceIdOf } from '../../src/paypal/webhooks.js'
import { resetTokenCache, getToken } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { durationHours, numbersIn } from '../../src/pricing/words.js'
import { priceLines, DEMO_RATE_CARD } from '../../src/pricing/ratecard.js'
import { runModel, cleanReply } from '../../src/ai/model.js'
import { transcribe, readWav } from '../../src/ai/whisper.js'
import { createBudget, memoryLedger, memoryCounter } from '../../src/ai/budget.js'
import { loadWs, saveWs, indexInvoice, loadCounter } from '../../src/store.js'
import { invoiceBody, idFromLink, findByNumber, sendInvoice } from '../../src/paypal/invoices.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')

function wsWithInvoice(status = 'SENT') {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  ws.invoices.I1 = { id: 'I1', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '25.00', due: '25.00', status, reminders: 0 }
  return ws
}

function wav({ data = 320, rate = 16000, channels = 1, bits = 16, fmt = true, fmtSize = 16 } = {}) {
  const chunks = []
  const put = (s) => chunks.push(...new TextEncoder().encode(s))
  const u16 = (n) => chunks.push(n & 255, n >> 8 & 255)
  const u32 = (n) => chunks.push(n & 255, n >> 8 & 255, n >> 16 & 255, n >> 24 & 255)
  put('RIFF'); u32(0); put('WAVE')
  if (fmt) { put('fmt '); u32(fmtSize); u16(1); u16(channels); u32(rate); u32(rate * channels * bits / 8); u16(channels * bits / 8); u16(bits) }
  put('data'); u32(data)
  for (let i = 0; i < data; i++) chunks.push(0)
  const out = new Uint8Array(chunks)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}

describe('booking holds and offers', () => {
  it('rejects missing jobs and only marks an offer accepted after its deposit sends', async () => {
    const ws = wsWithInvoice()
    expect(() => startHold(ws, 'absent', 'I2', NOW)).toThrow('No such job')
    expect(depositPaid(ws, 'absent', NOW)).toBeUndefined()
    expect(invoiceCancelled(ws, 'absent', NOW)).toBeUndefined()
    ws.drafts.d1 = { id: 'd1', customerId: 'absent', jobId: 'absent' }
    ws.offers.o1 = { id: 'o1', draftId: 'd1' }
    await expect(acceptOffer(ws, 'o1', { api: { request: async () => ({ ok: true, json: { id: 'I2' } }) }, env: {}, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ws.offers.o1.accepted).toBeUndefined()
  })

  it('places a booking and starts a hold when a deposit draft is sent', async () => {
    const ws = wsWithInvoice()
    const slot = { start: '2026-10-30T09:00:00Z', end: '2026-10-30T10:00:00Z', label: 'Fri 30 Oct 9:00' }
    const placed = placeBooking(ws, { customerId: 'c1', summary: 'New tap', hours: 1, slot, now: NOW })
    expect(placed.job).toMatchObject({ state: 'draft', draftedAt: NOW, summary: 'New tap', hours: 1 })
    expect(placed.draft.kind).toBe('deposit')
    const api = { request: async ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/invoices')) return { ok: true, json: { id: 'I2' } }
      if (path.endsWith('/generate-qr-code')) return { ok: false, status: 503 }
      if (path.endsWith('/send')) return { ok: true, json: {} }
      return { ok: true, json: { id: 'I2', status: 'SENT', amount: { value: '50.00', currency_code: 'USD' }, due_amount: { value: '50.00' } } }
    } }
    const sent = await sendDeposit(ws, placed.draft.id, { api, env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, now: NOW })
    expect(sent).toEqual({ invoiceId: 'I2' })
    expect(placed.job).toMatchObject({ state: 'held', depositInvoiceId: 'I2' })
    expect(ws.holds[0]).toMatchObject({ jobId: placed.job.id, invoiceId: 'I2' })
  })

  it('keeps a paid or ended hold from being released twice', async () => {
    const ws = wsWithInvoice()
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: NOW - 1, ended: 'paid' })
    expect(await releaseExpired(ws, { api: { request: async () => { throw Error('must skip ended') } }, now: NOW })).toEqual([])
    expect(job(ws, 'j2').state).toBe('booked')
  })

  it('uses marked as paid status for expired holds and preserves a missing job safely', async () => {
    const ws = wsWithInvoice()
    ws.holds.push({ jobId: 'absent', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    const api = { request: async () => ({ ok: true, json: { id: 'I1', status: 'MARKED_AS_PAID' } }) }
    expect(await releaseExpired(ws, { api, now: NOW })).toEqual(['Deposit paid for Thu 29 Oct 9:00.'])
    expect(ws.holds[0].ended).toBe('paid')
  })

  it('does not offer a slot when no waiting job fits and handles deleted waiting entries', async () => {
    const ws = wsWithInvoice()
    ws.jobs = ws.jobs.filter((j) => j.id !== 'j5')
    ws.waiting = ['missing']
    ws.holds.push({ jobId: 'j2', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    const api = { request: async ({ method }) => method === 'GET' ? { ok: true, json: { id: 'I1', status: 'CANCELLED' } } : { ok: true, json: {} } }
    expect(await releaseExpired(ws, { api, now: NOW })).toEqual(['Hold ran out on Thu 29 Oct 9:00. Slot freed.'])
    expect(ws.waiting).toEqual(['missing'])
  })

  it('does not start a second hold for an ended deposit and updates no deleted job', async () => {
    const ws = wsWithInvoice()
    ws.drafts.d1 = { id: 'd1', customerId: 'c1', jobId: 'absent', invoiceId: 'I2', sentAt: NOW, qr: 'existing' }
    ws.holds.push({ jobId: 'absent', invoiceId: 'I2', start: '2026-10-30T09:00:00Z', end: '2026-10-30T10:00:00Z' })
    const api = { request: async () => ({ ok: true, json: { id: 'I2', status: 'SENT', amount: { value: '50.00' }, due_amount: { value: '50.00' } } }) }
    expect(await sendDeposit(ws, 'd1', { api, env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, now: NOW })).toEqual({ invoiceId: 'I2' })
    expect(ws.holds).toHaveLength(1)
    ws.holds.push({ jobId: 'absent', invoiceId: 'I3', start: '2026-10-30T09:00:00Z', end: '2026-10-30T10:00:00Z' })
    depositPaid(ws, 'I3', NOW)
    expect(ws.holds.at(-1).ended).toBe('paid')
    expect(ws.invoices.I3).toBeUndefined()
  })

  it('uses the next customer fallback when a cancelled slot is offered', async () => {
    const ws = wsWithInvoice()
    ws.customers = ws.customers.filter((c) => c.id !== 'c4')
    ws.holds.push({ jobId: 'absent', invoiceId: 'I1', start: '2026-10-29T09:00:00Z', end: '2026-10-29T10:00:00Z', expiresAt: 0 })
    const api = { request: async () => ({ ok: true, json: { id: 'I1', status: 'CANCELLED' } }) }
    await releaseExpired(ws, { api, now: NOW })
    expect(ws.notices.at(-1).text).toBe('Offered Thu 29 Oct 9:00 to the next customer. This job was first on the waiting list who fits 1 hour and is free then. The deposit waits for your tap.')
  })
})

describe('schedule decisions', () => {
  it('accepts timestamp and text bounds and returns no slots when the window is exhausted', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    expect(findSlots(ws, { durationHours: 1, after: NOW, before: NOW + 1, now: NOW })).toEqual([])
    expect(findSlots(ws, { durationHours: 1, after: '2026-11-02', now: NOW, limit: 1 })).toHaveLength(1)
  })

  it('reports missing jobs and moves into a free slot while ignoring the job itself in clash checks', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    expect(() => moveJob(ws, 'absent', NOW, NOW)).toThrow('No such job')
    expect(clashes(ws, job(ws, 'j2').start, job(ws, 'j2').end, 'j2')).toEqual([])
    const out = moveJob(ws, 'j2', '2026-11-06T09:00:00Z', NOW)
    expect(out.ok).toBe(true)
    expect(job(ws, 'j2').start).toBe('2026-11-06T09:00:00.000Z')
    expect(slotLabel(ws, NOW)).toContain('Wed 28 Oct')
  })

  it('refuses a move that overlaps an unknown customer job and names the fallback customer', () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    job(ws, 'j3').customerId = 'missing'
    const out = moveJob(ws, 'j2', job(ws, 'j3').start, NOW)
    expect(out).toMatchObject({ ok: false, clash: { id: 'j3' }, text: "Kitchen tap clashes with customer's Boiler check." })
    expect(moveJob(ws, 'j2', Date.parse('2026-11-06T09:00:00Z'), NOW).ok).toBe(true)
  })
})

describe('invoice and reminder taps', () => {
  it('reuses a completed draft and rejects missing draft or customer records', async () => {
    const ws = wsWithInvoice()
    ws.drafts.done = { id: 'done', invoiceId: 'I1', sentAt: NOW, customerId: 'c1' }
    expect(await sendDraft(ws, 'done', {})).toEqual({ invoiceId: 'I1' })
    await expect(sendDraft(ws, 'missing', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    ws.drafts.bad = { id: 'bad', customerId: 'missing' }
    await expect(sendDraft(ws, 'bad', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(invoiceNumber('long-workspace-identifier', 'a very long draft id')).toHaveLength(25)
  })

  it('resumes a created invoice and a sent invoice after partial failures', async () => {
    for (const draft of [
      { id: 'd1', customerId: 'c1', priced: { total: '25.00' }, summary: 'repair', invoiceId: 'I2' },
      { id: 'd2', customerId: 'c1', priced: {}, summary: 'repair', invoiceId: 'I3', sentAt: NOW },
    ]) {
      const ws = wsWithInvoice()
      const shouldSend = draft.sentAt === undefined
      ws.drafts[draft.id] = draft
      const calls = []
      const api = { request: async ({ path }) => {
        calls.push(path)
        if (path.endsWith('/send')) return { ok: true, json: {} }
        if (path.endsWith('/generate-qr-code')) return { ok: true, text: 'plainbase64==' }
        return { ok: true, json: { id: draft.invoiceId, status: 'SENT', amount: { value: '25.00', currency_code: 'USD' }, detail: { metadata: {} } } }
      } }
      await sendDraft(ws, draft.id, { api, env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, now: NOW })
      expect(ws.invoices[draft.invoiceId].qr).toBe('plainbase64==')
      expect(calls.some((p) => p.endsWith('/send'))).toBe(shouldSend)
    }
  })

  it('reconciles cash from a complete partial payment readback', async () => {
    const ws = wsWithInvoice()
    const reads = [{ id: 'I1', status: 'SENT', amount: { value: '25.00', currency_code: 'USD' }, due_amount: { value: '25.00' } }, { id: 'I1', status: 'PARTIALLY_PAID', amount: { value: '25.00', currency_code: 'USD' }, due_amount: { value: '10.00' }, payments: { paid_amount: { value: '15.00' } } }]
    const api = { request: async ({ method }) => method === 'GET' ? { ok: true, json: reads.shift() } : { ok: true, json: {} } }
    expect(await recordCashTap(ws, 'I1', '5.00', { api, now: NOW })).toEqual({ status: 'PARTIALLY_PAID', due: '10.00' })
    expect(ws.invoices.I1).toMatchObject({ cash: true, due: '10.00' })
  })

  it('keeps accepted due after an inconclusive cash readback', async () => {
    const ws = wsWithInvoice()
    const reads = [{ id: 'I1', status: 'SENT', amount: { value: '25.00', currency_code: 'USD' }, due_amount: { value: '25.00' } }, { id: 'I1', status: 'SENT', amount: { value: '25.00', currency_code: 'USD' }, due_amount: { value: '20.00' } }]
    const api = { request: async ({ method }) => method === 'GET' ? { ok: true, json: reads.shift() } : { ok: true, json: {} } }
    expect(await recordCashTap(ws, 'I1', '5.00', { api, now: NOW })).toEqual({ status: 'SENT', due: '25.00' })
    expect(ws.invoices.I1.due).toBe('25.00')
  })

  it('uses singular fallback wording and standard delivery for the third reminder', async () => {
    const ws = wsWithInvoice()
    ws.invoices.I1.customerId = 'absent'
    ws.invoices.I1.reminders = 2
    const sent = []
    await sendReminderTap(ws, 'I1', 'Just a quick reminder about 25.00', { api: { request: async (p) => (sent.push(p), { ok: true, json: {} }) }, now: NOW })
    expect(sent[0].body).toEqual({ send_to_recipient: true })
    expect(ws.notices.at(-1).text).toBe('Reminder sent to the customer.')
    expect(cleanReminder('', ws.invoices.I1, NOW)).toBe('')
  })

  it('refuses to record cash against a shared late invoice', async () => {
    const ws = wsWithInvoice()
    ws.invoices.I1.shared = true
    await expect(recordCashTap(ws, 'I1', '1', { api: {}, now: NOW })).rejects.toMatchObject({ code: 'SHARED' })
  })
})

describe('webhook event parsing', () => {
  it('reads nested, flat, and absent invoice ids', () => {
    expect(invoiceIdOf({ resource: { invoice: { id: 'I1' }, id: 'I2' } })).toBe('I1')
    expect(invoiceIdOf({ resource: { id: 'I2' } })).toBe('I2')
    expect(invoiceIdOf({})).toBeNull()
  })

  it('rejects missing signature headers and handles duplicate events and missing workspaces', async () => {
    const kv = memoryKV()
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH1' }
    const ctx = { waitUntil: (p) => p }
    const req = (body, headers = {}) => new Request('https://x.test', { method: 'POST', body, headers })
    expect((await handleWebhook(req('{}'), env, ctx, { fetch: pp.fetch })).status).toBe(400)
    const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://x.test/cert', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'now' }
    const body = JSON.stringify({ id: 'evt1', event_type: 'OTHER', resource: { invoice: { id: 'I1' } } })
    await kv.put('inv:I1', 'missing-ws')
    expect((await handleWebhook(req(body, headers), env, ctx, { fetch: pp.fetch })).status).toBe(200)
    expect(await kv.get('evt:evt1')).toBeNull()
    expect((await handleWebhook(req(body, headers), env, ctx, { fetch: pp.fetch })).status).toBe(200)
  })

  it('verifies a valid event without an invoice id and writes no workspace index lookup', async () => {
    resetTokenCache()
    const kv = memoryKV()
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'SUCCESS' } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH1' }
    const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'no-invoice', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'n' }
    const response = await handleWebhook(new Request('https://x.test', { method: 'POST', headers, body: JSON.stringify({ id: 'event-without-invoice' }) }), env, { waitUntil() {} }, { fetch: pp.fetch })
    expect(response.status).toBe(200)
    expect(pp.calls.some((call) => call.path === '/v1/oauth2/token')).toBe(true)
  })

  it('reports an HTTP verification result and safely ignores an absent workspace during refusal', async () => {
    const kv = memoryKV()
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 503, body: { name: 'DOWN' } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH1' }
    const waits = []
    const ctx = { waitUntil: (p) => waits.push(p) }
    const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 't2', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'n' }
    await kv.put('inv:I1', 'missing-ws')
    const response = await handleWebhook(new Request('https://x.test', { method: 'POST', headers, body: JSON.stringify({ id: 'e', event_type: 'OTHER', resource: { id: 'I1' } }) }), env, ctx, { fetch: pp.fetch })
    // PayPal retries a delivery that gets a non 2xx answer, so a verify outage loses no payment.
    expect(response.status).toBe(503)
    await Promise.all(waits)
  })

  it('uses empty event type text when recording a refused signature', async () => {
    const kv = memoryKV()
    const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [{ status: 200, body: { verification_status: 'FAILURE' } }] })
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH1' }
    const waits = []
    const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'empty-type', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'n' }
    const ws = wsWithInvoice()
    await kv.put('inv:I1', 'w1')
    await saveWs(env, ws)
    await handleWebhook(new Request('https://x.test', { method: 'POST', headers, body: JSON.stringify({ id: 'e', resource: { id: 'I1' } }) }), env, { waitUntil: (p) => waits.push(p) }, { fetch: pp.fetch })
    await Promise.all(waits)
    expect((await loadWs(env, 'w1')).panel.at(-1).text).toContain('Webhook  refused: signature FAILURE')
  })
})

describe('pricing and model edge behavior', () => {
  it('handles number phrases with skipped words and ignores non numeric input', () => {
    expect(numbersIn('zero dollars and forty five cents')).toContain(45)
    expect(durationHours('there is half an hour wait', 15)).toBe(0.5)
    expect(durationHours('no duration here', 15)).toBeNull()
    expect(priceLines([{ kind: 'callout' }, { kind: 'part', description: 'washer', cost: '0.00' }], DEMO_RATE_CARD).lines[1].source).toBe('you said 0')
    expect(numbersIn('one thousand')).toContain(1000)
    expect(numbersIn('thousand')).toContain(1000)
    expect(durationHours('0 hours', 15)).toBeNull()
  })

  it('cleans non text model output and omits the no think suffix without a user message', async () => {
    expect(cleanReply({ ok: true })).toBe('{"ok":true}')
    expect(cleanReply(4)).toBe('')
    const seen = []
    const out = await runModel({ ai: { run: async (_model, input) => (seen.push(input), { response: '  done  ' }) }, budget: { charge: async () => ({ ok: true }) }, ipKey: 'i', day: 'd', messages: [{ role: 'system', content: 'system' }] })
    expect(out.text).toBe('done')
    expect(seen[0].messages[0].content).toBe('system')
    expect(out.usage).toBeNull()
    expect(cleanReply('old thought</think> final')).toBe('final')
  })

  it('reads Granite chat choices and accounts for its token usage', async () => {
    const content = '{"ok":true}'
    const usage = { prompt_tokens: 1145, completion_tokens: 68, neurons: 2.4559 }
    const out = await runModel({
      ai: { run: async () => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }) },
      budget: { charge: async () => ({ ok: true }) }, ipKey: 'i', day: 'd', messages: [{ role: 'user', content: 'hi' }]
    })
    expect(out.text).toBe(content)
    expect(out.actual).toBe(1145 * 1542 / 1e6 + 68 * 10158 / 1e6)
    expect(out.usage).toEqual(usage)
  })

  it('returns the configured failed budget reason without calling the model', async () => {
    let called = false
    await expect(runModel({ ai: { run: async () => (called = true, {}) }, budget: { charge: async () => ({ ok: false, reason: 'day' }) }, ipKey: 'i', day: 'd', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ reason: 'day' })
    expect(called).toBe(false)
  })
})

describe('audio and AI budget limits', () => {
  it('refuses WAV files with missing format or invalid audio duration before calling AI', async () => {
    expect(() => readWav(wav({ fmt: false }))).toThrow()
    expect(() => readWav(wav({ fmtSize: 8 }))).toThrow()
    expect(() => readWav(wav({ fmtSize: 100 }))).toThrow()
    const budget = { charge: async () => ({ ok: true }) }
    await expect(transcribe({ ai: { run: vi.fn() }, budget, ipKey: 'i', day: 'd', bytes: wav({ data: 16000 * 2 * 31 }) })).rejects.toMatchObject({ status: 413 })
    await expect(transcribe({ ai: { run: vi.fn() }, budget, ipKey: 'i', day: 'd', bytes: wav({ rate: 8000 }) })).rejects.toMatchObject({ status: 415 })
    const silent = await transcribe({ ai: { run: async () => ({}) }, budget, ipKey: 'i', day: 'd', bytes: wav() })
    expect(silent.text).toBe('')
  })

  it('allows a silent model result and stops budget calls at each limit', async () => {
    const ai = { run: async () => ({}) }
    const noBudget = { charge: async () => ({ ok: false, reason: 'ip' }) }
    const bytes = wav({ data: 320 })
    await expect(transcribe({ ai, budget: noBudget, ipKey: 'i', day: 'd', bytes })).rejects.toMatchObject({ reason: 'ip' })
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'app', dailyLimit: 0, ipLimit: 0 })
    expect(await budget.charge({ ipKey: 'i', day: 'd', neurons: 1 })).toEqual({ ok: false, reason: 'day' })
    const account = createBudget({ ledger: { dayTotal: async () => 9500, add: async () => {} }, perIp: memoryCounter(), app: 'app' })
    expect(await account.charge({ ipKey: 'i', day: 'd', neurons: 1 })).toEqual({ ok: false, reason: 'account' })
  })

  it('uses existing workspace timezone options and keeps Monday job on the same Monday', () => {
    const monday = seedWorkspace({ id: 'mon', now: Date.parse('2026-10-26T12:00:00Z'), tzOffsetMinutes: 0, demoHold: false })
    expect(monday.settings.holdMinutes).toBe(1440)
    expect(monday.jobs[0].start).toContain('2026-10-26')
  })
})

describe('workspace storage defaults', () => {
  it('returns null for invalid or missing workspaces and flushes only changed counters', async () => {
    const kv = memoryKV()
    const env = { JOBDONE: kv }
    expect(await loadWs(env, '')).toBeNull()
    expect(await loadWs(env, 'bad id')).toBeNull()
    expect(await loadWs(env, 'w1')).toBeNull()
    const ws = wsWithInvoice()
    await saveWs(env, ws)
    await indexInvoice(env, 'I1', 'w1')
    expect(await kv.get('inv:I1')).toBe('w1')
    expect((await loadWs(env, 'w1')).id).toBe('w1')
    const counter = await loadCounter(env, 'count')
    expect(counter.get('x')).toBe(0)
    await counter.flush(60)
    counter.add('x', 2)
    expect(counter.get('x')).toBe(2)
    await counter.flush(60)
    expect(JSON.parse(await kv.get('count'))).toEqual({ x: 2 })
  })
})

describe('PayPal invoice fallbacks', () => {
  it('builds a tax free invoice with the default note and tolerates empty PayPal search results', async () => {
    expect(idFromLink({})).toBeNull()
    const body = invoiceBody({ business: 'Shop', given: 'A', surname: 'B', email: 'a@example.com', priced: { currency: 'USD', taxPercent: '0', lines: [{ name: 'Work', quantity: '1', unitAmount: '2.00', uom: 'AMOUNT' }] }, reference: 'ref' })
    expect(body.detail).toMatchObject({ note: 'Thank you.', reference: 'ref' })
    expect(body.items[0].tax).toBeUndefined()
    expect(await findByNumber({ request: async () => ({ ok: true, json: { items: [] } }) }, 'JD-1')).toBeNull()
    await expect(sendInvoice({ request: async () => ({ ok: false, status: 422 }) }, 'I1', 'r')).rejects.toMatchObject({ code: 'PAYPAL' })
    await expect(sendInvoice({ request: async () => ({ ok: true }) }, 'I1', 'r', 'Please pay soon')).resolves.toBeUndefined()
    const duplicate = { request: async ({ path }) => path.includes('search-invoices') ? ({ ok: true, json: { items: [] } }) : ({ ok: false, status: 422, json: { details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] } }) }
    await expect(import('../../src/paypal/invoices.js').then(({ createInvoice }) => createInvoice(duplicate, { detail: { invoice_number: 'JD-1' } }, 'r'))).rejects.toMatchObject({ code: 'PAYPAL' })
  })
})

describe('PayPal client and token retries', () => {
  beforeEach(() => resetTokenCache())
  afterEach(() => vi.unstubAllGlobals())

  it('uses the global fetch fallback, refreshes a forced token, and logs the request path', async () => {
    const globalFetch = vi.fn(async () => Response.json({ access_token: 'global-token', expires_in: 4000 }))
    vi.stubGlobal('fetch', globalFetch)
    const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }
    expect(await getToken(env, { force: true })).toBe('global-token')
    expect(await getToken(env)).toBe('global-token')
    expect(globalFetch).toHaveBeenCalledTimes(1)

    const entries = []
    const api = createPayPal(env, { fetch: async (input) => String(input).includes('/oauth2/token') ? Response.json({ access_token: 't', expires_in: 4000 }) : Promise.reject(Error('offline')), sleep: async () => {}, log: (e) => entries.push(e) })
    await api.request({ method: 'GET', path: '/offline' })
    expect(entries.at(-1).path).toBe('/offline')
  })
})
