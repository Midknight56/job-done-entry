import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { placeBooking } from '../../src/state/holds.js'
import { fakePayPal } from './fake-paypal.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { memoryKV } from './memory-kv.js'

function memoryStorage() {
  const values = new Map()
  let alarm = null
  return {
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { return values.delete(key) },
    async deleteAll() { values.clear() },
    async setAlarm(value) { alarm = value },
    values,
    alarm: () => alarm,
  }
}

async function setup({ durable = true, payFetch } = {}) {
  const kv = memoryKV()
  const ws = seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
  ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '282.42', due: '282.42', status: 'SENT', sentAt: Date.now(), reminders: 0 }
  await kv.put('ws:w1', JSON.stringify(ws))
  await kv.put('inv:INV2-MARIA', 'w1')

  const objects = new Map()
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-OURS' }
  let WorkspaceDO
  if (durable) ({ WorkspaceDO } = await import('../../src/state/workspace-do.js'))
  const namespace = durable ? {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) {
        const storage = memoryStorage()
        objects.set(id, { storage, instance: new WorkspaceDO({ storage, id: { name: id } }, env) })
      }
      return { fetch: (request) => objects.get(id).instance.fetch(request) }
    },
  } : null

  vi.stubGlobal('fetch', payFetch || (async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
    if (url.pathname === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: 'SUCCESS' })
    if (url.pathname.endsWith('/remind')) return new Response(null, { status: 204 })
    return Response.json({ name: 'NOT_SCRIPTED' }, { status: 404 })
  }))
  if (namespace) env.WORKSPACE = namespace
  const waits = []
  const ctx = { waitUntil: (promise) => waits.push(promise) }
  const call = (path, { method = 'GET', body, host = 'job-done.test' } = {}) => worker.fetch(new Request(`https://${host}${path}`, {
    method,
    headers: { cookie: 'jd_ws=w1', 'cf-connecting-ip': '203.0.113.1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx)
  return { kv, env, ctx, call, waits, objects }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

async function saved(kv) {
  return JSON.parse(await kv.get('ws:w1'))
}

function savedObject(s) {
  return JSON.parse(s.objects.get('w1').storage.values.get('ws'))
}

describe('workspace Durable Object', () => {
  it('keeps both overlapping changes while the KV path loses one', async () => {
    const slow = deferred()
    const entered = deferred()
    const payFetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname.endsWith('/remind')) { entered.resolve(); await slow.promise; return new Response(null, { status: 204 }) }
      return Response.json({ name: 'NOT_SCRIPTED' }, { status: 404 })
    }

    const kvPath = await setup({ durable: false, payFetch })
    const kvSlow = kvPath.call('/api/invoices/INV2-MARIA/remind', { method: 'POST', body: { text: 'Please pay this invoice.' } })
    await entered.promise
    const kvFast = kvPath.call('/api/settings', { method: 'POST', body: { holdMinutes: 1440 } })
    await kvFast
    slow.resolve()
    await kvSlow
    const lost = await saved(kvPath.kv)
    expect(lost.settings.holdMinutes).toBe(2)
    expect(lost.invoices['INV2-MARIA'].reminders).toBe(1)

    const slow2 = deferred()
    const entered2 = deferred()
    const doPayFetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname.endsWith('/remind')) { entered2.resolve(); await slow2.promise; return new Response(null, { status: 204 }) }
      return Response.json({ name: 'NOT_SCRIPTED' }, { status: 404 })
    }
    const objectPath = await setup({ payFetch: doPayFetch })
    const doSlow = objectPath.call('/api/invoices/INV2-MARIA/remind', { method: 'POST', body: { text: 'Please pay this invoice.' } })
    await entered2.promise
    const doFast = objectPath.call('/api/settings', { method: 'POST', body: { holdMinutes: 1440 } })
    slow2.resolve()
    await Promise.all([doSlow, doFast])
    const kept = savedObject(objectPath)
    expect(kept.settings.holdMinutes).toBe(1440)
    expect(kept.invoices['INV2-MARIA'].reminders).toBe(1)
  })

  it('keeps a paid webhook that arrives during a slow tap', async () => {
    const slow = deferred()
    const entered = deferred()
    const verified = deferred()
    const payFetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname.endsWith('/remind')) { entered.resolve(); await slow.promise; return new Response(null, { status: 204 }) }
      if (url.pathname === '/v1/notifications/verify-webhook-signature') { verified.resolve(); return Response.json({ verification_status: 'SUCCESS' }) }
      return Response.json({ name: 'NOT_SCRIPTED' }, { status: 404 })
    }
    const s = await setup({ payFetch })
    const tap = s.call('/api/invoices/INV2-MARIA/remind', { method: 'POST', body: { text: 'Please pay this invoice.' } })
    await entered.promise
    const sample = JSON.stringify({ id: 'event-1', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-MARIA', status: 'PAID' } })
    const webhook = worker.fetch(new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers: {
      'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'tx-1',
      'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-29T15:00:00Z',
    }, body: sample }), s.env, s.ctx)
    await verified.promise
    // The webhook answers only after its save, and the save waits for the tap that holds the workspace.
    slow.resolve()
    expect((await webhook).status).toBe(200)
    await tap
    await Promise.all(s.waits)
    expect(savedObject(s).invoices['INV2-MARIA'].status).toBe('PAID')
  })

  it('copies an existing KV document into empty storage only once', async () => {
    const s = await setup()
    const object = s.env.WORKSPACE.get('w1')
    const request = () => new Request('https://job-done.test/api/state', { headers: { cookie: 'jd_ws=w1' } })
    await object.fetch(request())
    const record = s.objects.get('w1')
    expect(record.storage.values.get('ws')).toBe(await s.kv.get('ws:w1'))
    await s.kv.put('ws:w1', JSON.stringify({ id: 'w1', newer: true }))
    await object.fetch(request())
    expect(JSON.parse(record.storage.values.get('ws')).newer).toBeUndefined()
  })

  it('deletes all storage when its alarm fires', async () => {
    const s = await setup()
    const object = s.env.WORKSPACE.get('w1')
    await object.fetch(new Request('https://job-done.test/api/state', { headers: { cookie: 'jd_ws=w1' } }))
    const instance = s.objects.get('w1').instance
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 86_400_000 + 1)
    await instance.alarm()
    expect(s.objects.get('w1').storage.values.size).toBe(0)
    expect(await s.kv.get('expired:w1')).toBe('1')
    vi.restoreAllMocks()
  })

  it('creates new workspace documents through their Durable Object', async () => {
    const s = await setup()
    const response = await s.call('/api/workspace', { method: 'POST', body: { tz: 60 } })
    expect(response.status).toBe(200)
    const wid = /jd_ws=([a-f0-9]+)/.exec(response.headers.get('set-cookie'))[1]
    expect(JSON.parse(s.objects.get(wid).storage.values.get('ws'))).toMatchObject({ id: wid, tz: 60 })
  })

  it('sends a refused webhook note through the workspace object', async () => {
    const payFetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      if (url.pathname === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: 'FAILURE' })
      return Response.json({ name: 'NOT_SCRIPTED' }, { status: 404 })
    }
    const s = await setup({ payFetch })
    const response = await worker.fetch(new Request('https://job-done.test/webhooks/paypal', {
      method: 'POST',
      headers: {
        'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'tx-refused',
        'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-29T15:00:00Z',
      },
      body: JSON.stringify({ id: 'event-refused', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-MARIA' } }),
    }), s.env, s.ctx)
    expect(response.status).toBe(400)
    await Promise.all(s.waits)
    expect(savedObject(s).panel.at(-1)).toMatchObject({ kind: 'guard', status: 400 })
  })

  it('refuses internal operations addressed through an outside host', async () => {
    const s = await setup()
    const object = s.env.WORKSPACE.get('w1')
    const response = await object.fetch(new Request('https://outside.test/internal/webhook', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(404)
    expect((await object.fetch(new Request('https://do.internal/internal/unknown'))).status).toBe(404)
    expect((await object.fetch(new Request('https://do.internal/internal/webhook', { method: 'POST', body: '{' }))).status).toBe(404)
    expect((await object.fetch(new Request('https://do.internal/internal/workspace', { method: 'PUT', body: JSON.stringify({ id: 'w1' }) }))).status).toBe(200)

    const storage = s.objects.get('w1').storage
    const setAlarm = storage.setAlarm
    storage.setAlarm = async () => { throw new Error('alarm failed') }
    await expect(object.fetch(new Request('https://do.internal/internal/workspace', { method: 'PUT', body: JSON.stringify({ id: 'w1' }) }))).rejects.toThrow('alarm failed')
    storage.setAlarm = setAlarm
    expect((await object.fetch(new Request('https://do.internal/internal/unknown'))).status).toBe(404)
  })
})

describe('errors inside the workspace object', () => {
  it('a PayPal error thrown inside the object comes back as its own 502 answer, not a thrown error that loses its code', async () => {
    const { env } = await setup()
    const object = env.WORKSPACE.get(env.WORKSPACE.idFromName('w1'))
    const request = new Request('https://job-done.test/api/invoices/INV2-MARIA/cash', {
      method: 'POST',
      headers: { cookie: 'jd_ws=w1', 'cf-connecting-ip': '203.0.113.1', 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10.00' }),
    })
    const response = await object.fetch(request)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'paypal' })
  })
})

describe('workspace hold alarms', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTokenCache() })

  async function held(status = 'SENT') {
    resetTokenCache()
    let now = Date.parse('2026-11-05T14:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const invoice = { id: 'DEP', status, amount: { value: '50.00' }, due_amount: { value: '50.00' } }
    const pp = fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { id: 'DEP' } }],
      'GET /v2/invoicing/invoices/DEP': [{ status: 200, body: invoice }],
      'POST /v2/invoicing/invoices/DEP/send': [{ status: 202 }],
      'POST /v2/invoicing/invoices/DEP/cancel': [{ status: 204 }],
    })
    const s = await setup({ payFetch: pp.fetch })
    const ws = await saved(s.kv)
    ws.customers.find((c) => c.id === 'c1').email = 'test@example.com'
    const booking = placeBooking(ws, { customerId: 'c1', summary: 'Tap', hours: 1, now,
      slot: { start: '2026-11-06T09:00:00Z', end: '2026-11-06T10:00:00Z', label: 'Friday' } })
    await s.kv.put('ws:w1', JSON.stringify(ws))
    expect((await s.call(`/api/drafts/${booking.draft.id}/send`, { method: 'POST', body: {} })).status).toBe(200)
    const record = s.objects.get('w1')
    return { ...s, ...record, pp, invoice, advance: (ms) => { now += ms } }
  }

  it('releases an unpaid hold and drafts a replacement with no state poll', async () => {
    const s = await held()
    s.advance(120_001)
    await s.instance.alarm()
    const ws = savedObject(s)
    expect(ws.holds[0].ended).toBe('released')
    expect(s.pp.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(1)
    expect(Object.values(ws.offers)).toHaveLength(1)
    expect(s.pp.calls.filter((c) => c.path.endsWith('/send'))).toHaveLength(1)
  })

  it('lets payment win at expiry without cancelling the invoice', async () => {
    const s = await held()
    s.invoice.status = 'PAID'
    s.advance(120_001)
    await s.instance.alarm()
    const ws = savedObject(s)
    expect(ws.holds[0].ended).toBe('paid')
    expect(ws.jobs.find((j) => j.id === ws.holds[0].jobId)).toMatchObject({ state: 'booked', depositPaid: true })
    expect(s.pp.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false)
  })

  it('schedules the earliest hold and keeps a delete deadline on each write', async () => {
    const s = await held()
    expect(s.storage.alarm()).toBe(savedObject(s).holds[0].expiresAt)
    expect(s.storage.values.get('deleteAt')).toBe(Date.now() + 30 * 86_400_000)
    const ws = savedObject(s)
    ws.holds[0].ended = 'paid'
    await s.instance.store.put('ws', JSON.stringify(ws))
    expect(s.storage.alarm()).toBe(Date.now() + 30 * 86_400_000)
  })

  it('stops after ten failed alarm attempts and resumes after a state poll', async () => {
    const s = await held()
    const failed = fakePayPal({ 'GET /v2/invoicing/invoices/DEP': [{ status: 503 }] })
    vi.stubGlobal('fetch', failed.fetch)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    s.advance(120_001)
    for (let i = 1; i <= 10; i++) {
      await s.instance.alarm()
      expect(savedObject(s).holds[0].tries).toBe(i)
      if (i < 10) expect(s.storage.alarm()).toBe(Date.now() + 60_000)
      s.advance(60_000)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(s.storage.alarm()).toBe(s.storage.values.get('deleteAt'))
    await s.instance.alarm()
    expect(failed.calls.filter((c) => c.path.endsWith('/DEP'))).toHaveLength(10)
    expect((await s.call('/api/state')).status).toBe(200)
    expect(s.storage.alarm()).toBe(Date.now() + 60_000)
    s.advance(60_000)
    await s.instance.alarm()
    expect(failed.calls.filter((c) => c.path.endsWith('/DEP'))).toHaveLength(12)
  })
})
