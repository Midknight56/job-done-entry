import { describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { handleWebhook } from '../../src/paypal/webhooks.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { memoryKV } from './memory-kv.js'

const headers = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tx',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': '2026-10-23T12:00:00Z',
}

function event(id, type = 'INVOICING.INVOICE.PAID', resource = { id: 'INV1', status: 'PAID' }) {
  return JSON.stringify({ id, event_type: type, resource })
}

function memoryStorage() {
  const values = new Map()
  return {
    async get(key) { return values.get(key) ?? null },
    async put(key, value) { values.set(key, value) },
    async delete(key) { return values.delete(key) },
    async deleteAll() { values.clear() },
    async setAlarm(value) { this.alarmAt = value },
    values,
  }
}

async function setup({ verify = 'SUCCESS', durable = false } = {}) {
  const kv = memoryKV()
  const ws = seedWorkspace({ id: 'w1', now: 1, tzOffsetMinutes: 0 })
  ws.invoices.INV1 = { id: 'INV1', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '10.00', due: '10.00', status: 'SENT', reminders: 0 }
  await kv.put('ws:w1', JSON.stringify(ws))
  await kv.put('inv:INV1', 'w1')
  const stores = new Map()
  let WorkspaceDO
  if (durable) ({ WorkspaceDO } = await import('../../src/state/workspace-do.js'))
  const WORKSPACE = durable ? {
    idFromName: (id) => id,
    get(id) {
      if (!stores.has(id)) {
        const storage = memoryStorage()
        stores.set(id, { storage, instance: new WorkspaceDO({ storage, id: { name: id } }, { JOBDONE: kv }) })
      }
      return { fetch: (request) => stores.get(id).instance.fetch(request) }
    },
  } : null
  const fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
    if (url.pathname === '/v1/notifications/verify-webhook-signature') {
      if (verify === 'HTTP 500') return Response.json({ message: 'unavailable' }, { status: 500 })
      return Response.json({ verification_status: verify })
    }
    return Response.json({}, { status: 404 })
  }
  vi.stubGlobal('fetch', fetch)
  const env = { JOBDONE: kv, WORKSPACE, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH' }
  const waits = []
  const ctx = { waitUntil: (promise) => waits.push(promise) }
  const deliver = (body, h = headers) => handleWebhook(new Request('https://app.test/webhooks/paypal', { method: 'POST', headers: h, body }), env, ctx, { fetch })
  return { kv, env, stores, deliver, waits, settle: () => Promise.all(waits) }
}

async function ws(s) { return JSON.parse(await s.kv.get('ws:w1')) }

describe('battle d webhook attacks', () => {
  it('counts the same event id once', async () => {
    const s = await setup()
    expect((await s.deliver(event('same'))).status).toBe(200)
    expect((await s.deliver(event('same'))).status).toBe(200)
    await s.settle()
    expect((await ws(s)).notices.filter((n) => n.kind === 'paid')).toHaveLength(1)
  })

  it('counts one payment from different event ids once', async () => {
    const s = await setup()
    await s.deliver(event('one'))
    await s.deliver(event('two'))
    await s.settle()
    expect((await ws(s)).notices.filter((n) => n.kind === 'paid')).toHaveLength(1)
  })

  it('does not move a paid invoice back to sent', async () => {
    const s = await setup()
    await s.deliver(event('paid'))
    await s.deliver(event('sent', 'INVOICING.INVOICE.SENT', { id: 'INV1', status: 'SENT' }))
    await s.settle()
    expect((await ws(s)).invoices.INV1.status).toBe('PAID')
  })

  it('does not cancel a payment that is already paid', async () => {
    const s = await setup()
    await s.deliver(event('paid'))
    await s.deliver(event('cancel', 'INVOICING.INVOICE.CANCELLED', { id: 'INV1', status: 'CANCELLED' }))
    await s.settle()
    expect((await ws(s)).invoices.INV1.status).toBe('PAID')
  })

  it('rejects a bad signature without changing money', async () => {
    const s = await setup({ verify: 'FAILURE' })
    expect((await s.deliver(event('bad'))).status).toBe(400)
    await s.settle()
    expect((await ws(s)).invoices.INV1.status).toBe('SENT')
  })

  it('treats a successful verification response without a verdict as invalid', async () => {
    const s = await setup()
    const fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
      return new Response(null, { status: 204 })
    }
    expect((await handleWebhook(new Request('https://app.test/webhooks/paypal', { method: 'POST', headers, body: event('no-verdict') }), s.env, s.ctx, { fetch })).status).toBe(400)
  })

  it('rejects missing PayPal headers', async () => {
    const s = await setup()
    expect((await s.deliver(event('noheaders'), {})).status).toBe(400)
  })

  it.each(['', '{', 'not json'])('rejects body %j', async (body) => {
    const s = await setup()
    expect((await s.deliver(body)).status).toBe(400)
  })

  it('rejects an oversized body', async () => {
    const s = await setup()
    expect((await s.deliver(' '.repeat(1_000_001))).status).toBe(413)
  })

  it('rejects an oversized declared body before reading it', async () => {
    const s = await setup()
    expect((await s.deliver(event('large-header'), { ...headers, 'content-length': '1000001' })).status).toBe(413)
  })

  it('rejects events without an id', async () => {
    const s = await setup()
    expect((await s.deliver(JSON.stringify({ event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV1' } }))).status).toBe(400)
  })

  it('rejects a top level array', async () => {
    const s = await setup()
    expect((await s.deliver('[]')).status).toBe(400)
  })

  it('drops another apps invoice after successful verification and spends no KV write on it', async () => {
    const s = await setup()
    expect((await s.deliver(event('other', 'INVOICING.INVOICE.PAID', { id: 'OTHER' }))).status).toBe(200)
    expect(await s.kv.get('evt:other')).toBeNull()
  })

  it('requests a retry when an indexed invoice workspace is gone', async () => {
    const s = await setup()
    await s.kv.delete('ws:w1')
    expect((await s.deliver(event('gone'))).status).toBe(503)
    expect(await s.kv.get('ws:w1')).toBeNull()
  })

  it('ignores an unknown event type', async () => {
    const s = await setup()
    expect((await s.deliver(event('unknown', 'SOMETHING.NEW'))).status).toBe(200)
    await s.settle()
    expect((await ws(s)).invoices.INV1.status).toBe('SENT')
  })

  it('does not guess when the two invoice ids disagree', async () => {
    const s = await setup()
    expect((await s.deliver(event('mismatch', 'INVOICING.INVOICE.PAID', { id: 'OTHER', invoice: { id: 'INV1' } }))).status).toBe(200)
    await s.settle()
    expect((await ws(s)).invoices.INV1.status).toBe('SENT')
  })

  it('asks PayPal to retry when verification service returns an error', async () => {
    const s = await setup({ verify: 'HTTP 500' })
    expect((await s.deliver(event('verifyerror'))).status).toBe(503)
    expect(await s.kv.get('evt:verifyerror')).toBeNull()
  })

  it('asks PayPal to retry when verification times out', async () => {
    const s = await setup()
    const waiting = () => new Promise(() => {})
    const response = await handleWebhook(new Request('https://app.test/webhooks/paypal', { method: 'POST', headers, body: event('timeout') }), s.env, s.ctx, {
      fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url)
        if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'token', expires_in: 3600 })
        return waiting()
      },
      verifyTimeoutMs: 1,
    })
    expect(response.status).toBe(503)
    expect(await s.kv.get('evt:timeout')).toBeNull()
  })

  it('does not mark an event seen before its workspace write succeeds', async () => {
    const s = await setup()
    const object = s.env.WORKSPACE
    s.env.WORKSPACE = { ...object, get(id) { const target = object.get(id); return { fetch: async () => new Response('failed', { status: 500 }) } } }
    expect((await s.deliver(event('writefail'))).status).toBe(503)
    expect(await s.kv.get('evt:writefail')).toBeNull()
  })

  it('retries an event after storage rejects the update', async () => {
    const s = await setup({ durable: true })
    const storage = s.stores.get('w1')?.storage || (s.env.WORKSPACE.get('w1'), s.stores.get('w1').storage)
    const put = storage.put
    let fail = true
    storage.put = async (key, value) => { if (fail) throw new Error('storage unavailable'); return put.call(storage, key, value) }
    expect((await s.deliver(event('storagefail'))).status).toBe(503)
    expect(await s.kv.get('evt:storagefail')).toBeNull()
    fail = false
    expect((await s.deliver(event('storagefail'))).status).toBe(200)
    expect(JSON.parse(storage.values.get('ws')).invoices.INV1.status).toBe('PAID')
  })
})

describe('battle d object attacks', () => {
  it('serializes two webhooks and a tap into the same invoice document', async () => {
    const s = await setup({ durable: true })
    const obj = s.env.WORKSPACE.get('w1')
    const r = await obj.fetch(new Request('https://app.test/api/state', { headers: { cookie: 'jd_ws=w1' } }))
    expect(r.status).toBe(200)
    const tap = obj.fetch(new Request('https://app.test/api/settings', { method: 'POST', headers: { cookie: 'jd_ws=w1', 'content-type': 'application/json' }, body: JSON.stringify({ holdMinutes: 1440 }) }))
    await Promise.all([s.deliver(event('parallel')), s.deliver(event('parallel')), tap])
    const saved = JSON.parse(s.stores.get('w1').storage.values.get('ws'))
    expect(saved.invoices.INV1.status).toBe('PAID')
    expect(saved.settings.holdMinutes).toBe(1440)
    expect(saved.notices.filter((n) => n.kind === 'paid')).toHaveLength(1)
  })

  it('refuses a cookie for another workspace at this object', async () => {
    const s = await setup({ durable: true })
    const r = await s.env.WORKSPACE.get('w1').fetch(new Request('https://app.test/api/state', { headers: { cookie: 'jd_ws=w2' } }))
    expect(r.status).toBe(404)
    expect(s.stores.get('w1')?.storage.values.has('ws')).toBe(false)
  })

  it.each(['jd_ws=bad!; jd_ws=w1', `jd_ws=${'a'.repeat(41)}`])('rejects malformed workspace cookie %s', async (cookie) => {
    const s = await setup({ durable: true })
    const response = await s.env.WORKSPACE.get('w1').fetch(new Request('https://app.test/api/state', { headers: { cookie } }))
    expect(response.status).toBe(404)
  })

  it('refuses an internal path from an outside URL even with an internal Host header', async () => {
    const s = await setup({ durable: true })
    const req = new Request('https://outside.test/internal/workspace', { method: 'PUT', headers: { host: 'do.internal' }, body: JSON.stringify({ id: 'w1' }) })
    expect((await s.env.WORKSPACE.get('w1').fetch(req)).status).toBe(404)
  })

  it('does not let a normalized internal traversal reach the internal handler', async () => {
    const s = await setup({ durable: true })
    const req = new Request('https://do.internal/internal/../api/state', { headers: { cookie: 'jd_ws=w1' } })
    expect((await s.env.WORKSPACE.get('w1').fetch(req)).status).toBe(404)
  })

  it('does not restore a deleted workspace from stale KV after its alarm', async () => {
    const s = await setup({ durable: true })
    const object = s.env.WORKSPACE.get('w1')
    await object.fetch(new Request('https://app.test/api/state', { headers: { cookie: 'jd_ws=w1' } }))
    await s.stores.get('w1').storage.put('deleteAt', Date.now() - 1)
    await s.stores.get('w1').instance.alarm()
    const response = await object.fetch(new Request('https://app.test/api/state', { headers: { cookie: 'jd_ws=w1' } }))
    expect(response.status).toBe(404)
    expect(s.stores.get('w1').storage.values.has('ws')).toBe(false)
  })

  it('rejects an internal workspace document with a different id', async () => {
    const s = await setup({ durable: true })
    const object = s.env.WORKSPACE.get('w1')
    expect((await object.fetch(new Request('https://do.internal/internal/workspace', { method: 'PUT', body: JSON.stringify({ id: 'w2' }) }))).status).toBe(400)
  })

  it('reports a storage write failure instead of acknowledging a failed tap', async () => {
    const s = await setup({ durable: true })
    const object = s.env.WORKSPACE.get('w1')
    const storage = s.stores.get('w1').storage
    storage.put = async () => { throw new Error('write failed') }
    const response = await object.fetch(new Request('https://app.test/api/settings', { method: 'POST', headers: { cookie: 'jd_ws=w1', 'content-type': 'application/json' }, body: JSON.stringify({ holdMinutes: 1440 }) }))
    expect(response.status).toBe(500)
  })
})

describe('an invoice update event', () => {
  it('applies the status inside an UPDATED event, which is one of the four types this app listens for', async () => {
    const s = await setup()
    expect((await s.deliver(event('upd', 'INVOICING.INVOICE.UPDATED', { invoice: { id: 'INV1', status: 'PARTIALLY_PAID', due_amount: { value: '60.00' }, payments: { paid_amount: { value: '40.00' } } } }))).status).toBe(200)
    expect(JSON.parse(await s.kv.get('ws:w1')).invoices.INV1.status).toBe('PARTIALLY_PAID')
  })

  it('ignores an event type this app does not listen for, with no write', async () => {
    const s = await setup()
    expect((await s.deliver(event('odd', 'INVOICING.INVOICE.CREATED', { id: 'INV1', status: 'PAID' }))).status).toBe(200)
    expect(JSON.parse(await s.kv.get('ws:w1')).invoices.INV1.status).toBe('SENT')
    expect(await s.kv.get('evt:odd')).toBeNull()
  })
})
