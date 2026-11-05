import { afterEach, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { proposeInvoiceDraft } from '../../src/flows/send.js'
import { priceLines } from '../../src/pricing/ratecard.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { CapsDO } from '../../src/state/caps-do.js'

afterEach(() => { vi.unstubAllGlobals(); resetTokenCache() })
const dayKey = () => `cap:day:${new Date().toISOString().slice(0, 10)}`
const digest = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')

function namespace() {
  const records = new Map()
  const calls = []
  const record = (key) => {
    if (!records.has(key)) {
      const values = new Map()
      let alarm = null
      records.set(key, { values, storage: { get: async (k) => structuredClone(values.get(k)), put: async (k, v) => { values.set(k, structuredClone(v)) }, getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at }, deleteAll: async () => { values.clear() } } })
    }
    return records.get(key)
  }
  return { calls, record, idFromName: (key) => key, get(key) {
    return { async fetch(request) {
      calls.push({ key, path: new URL(request.url).pathname })
      const r = record(key)
      r.ready ||= import('../../src/state/caps-do.js').then(({ CapsDO }) => new CapsDO({ storage: r.storage }, {}))
      return (await r.ready).fetch(request)
    } }
  } }
}

it('sets one cleanup alarm three days after the first reserve and clears storage on alarm', async () => {
  const ns = namespace()
  const storage = ns.record('cleanup').storage
  const setAlarm = vi.spyOn(storage, 'setAlarm')
  const object = new CapsDO({ storage }, {})
  const reserve = () => object.fetch(new Request('https://do.internal/reserve', { method: 'POST', body: JSON.stringify({ items: [{ field: 'actions', n: 1, limit: 10 }] }) }))
  const before = Date.now()
  await reserve()
  const at = await storage.getAlarm()
  expect(at).toBeGreaterThanOrEqual(before + 3 * 86400000)
  expect(at).toBeLessThanOrEqual(Date.now() + 3 * 86400000)
  await reserve()
  expect(await storage.getAlarm()).toBe(at)
  expect(setAlarm).toHaveBeenCalledTimes(1)
  await object.alarm()
  expect(ns.record('cleanup').values.size).toBe(0)
})

async function setup() {
  const env = { JOBDONE: memoryKV(), CAPS: namespace(), PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', MAINTAINER_TOKEN: 'm'.repeat(32) }
  for (const id of ['w1', 'w2']) await env.JOBDONE.put(`ws:${id}`, JSON.stringify(seedWorkspace({ id, now: Date.now(), tzOffsetMinutes: 0 })))
  const { WorkspaceDO } = await import('../../src/state/workspace-do.js')
  const objects = new Map()
  env.WORKSPACE = { idFromName: (id) => id, get(id) {
    if (!objects.has(id)) {
      const values = new Map()
      const storage = { get: async (key) => values.get(key), put: async (key, value) => { values.set(key, value) }, setAlarm: async () => {} }
      objects.set(id, new WorkspaceDO({ storage, id: { name: id } }, env))
    }
    return objects.get(id)
  } }
  const call = (wid, path = '/api/settings', maint = false, method = 'POST') => worker.fetch(new Request(`https://job-done.test${path}`, {
    method, headers: { cookie: `jd_ws=${wid}${maint ? `; jd_maint=${env.MAINTAINER_TOKEN}` : ''}`, 'cf-connecting-ip': '203.0.113.1', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  }), env, { waitUntil() {} })
  return { env, call }
}

it('allows exactly one of two workspaces to reserve the last daily action', async () => {
  const { env, call } = await setup()
  env.CAPS.record(dayKey()).values.set('values', { actions: 249 })
  await env.JOBDONE.put(dayKey(), JSON.stringify({ actions: 249 }))
  const get = env.JOBDONE.get
  let reads = 0
  let resume
  const bothRead = new Promise((resolve) => { resume = resolve })
  env.JOBDONE.get = async (key, type) => {
    const value = await get(key, type)
    if (key === dayKey() && reads < 2) {
      if (++reads === 2) resume()
      await bothRead
    }
    return value
  }
  const replies = await Promise.all([call('w1'), call('w2')])
  expect(replies.map((r) => r.status).sort()).toEqual([200, 429])
  expect(env.CAPS.record(dayKey()).values.get('values').actions).toBe(250)
})

it('reserves the last customer action before saving in either workspace', async () => {
  const { env } = await setup()
  env.CAPS.record(dayKey()).values.set('values', { actions: 249 })
  const call = (id) => worker.fetch(new Request('https://job-done.test/api/customers', {
    method: 'POST', headers: { cookie: `jd_ws=${id}`, 'cf-connecting-ip': '203.0.113.1', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Tom Baker', address: '', email: 'tom@example.com' }),
  }), env, { waitUntil() {} })
  expect((await Promise.all([call('w1'), call('w2')])).map((r) => r.status).sort()).toEqual([200, 429])
  const workspaces = await Promise.all(['w1', 'w2'].map(async (id) => (await (await worker.fetch(new Request('https://job-done.test/api/state', { headers: { cookie: `jd_ws=${id}` } }), env, { waitUntil() {} })).json()).ws))
  expect(workspaces.reduce((n, ws) => n + ws.customers.length, 0)).toBe(9)
  expect(env.CAPS.record(dayKey()).values.get('values').actions).toBe(250)
})

it('returns invoice and action reservations when PayPal refuses creation', async () => {
  const { env, call } = await setup()
  const ws = JSON.parse(await env.JOBDONE.get('ws:w1'))
  ws.customers.find((c) => c.id === 'c1').email = 'test@example.com'
  const draft = proposeInvoiceDraft(ws, { customerId: 'c1', summary: 'Tap', priced: priceLines([{ kind: 'callout' }], ws.settings.rateCard) })
  await env.JOBDONE.put('ws:w1', JSON.stringify(ws))
  vi.stubGlobal('fetch', fakePayPal({ 'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'REFUSED' } }] }).fetch)
  expect((await call('w1', `/api/drafts/${draft.id}/send`)).status).toBe(502)
  expect(env.CAPS.record(dayKey()).values.get('values')).toMatchObject({ invoices: 0, actions: 0 })
  const ip = `cap:ip:${await digest('203.0.113.1')}:${new Date().toISOString().slice(0, 10)}`
  expect(env.CAPS.record(ip).values.get('values')).toMatchObject({ invoices: 0, actions: 0 })
})

it('adds neither item when the second reservation item exceeds its limit', async () => {
  const ns = namespace()
  const request = (path, items) => ns.get('counter').fetch(new Request(`https://do.internal/${path}`, { method: 'POST', body: JSON.stringify({ items }) }))
  const items = [{ field: 'actions', n: 1, limit: 250 }, { field: 'invoices', n: 1, limit: 0 }]
  expect(await (await request('reserve', items)).json()).toEqual({ ok: false, values: {} })
  expect(await (await ns.get('counter').fetch(new Request('https://do.internal/read'))).json()).toEqual({})
})

it('lifts maintainer ip limits while keeping the daily limit', async () => {
  const { env, call } = await setup()
  const ip = `cap:ip:${await digest('203.0.113.1')}:${new Date().toISOString().slice(0, 10)}`
  env.CAPS.record(ip).values.set('values', { actions: 40 })
  env.CAPS.record(dayKey()).values.set('values', { actions: 249 })
  expect((await call('w1', '/api/settings', true)).status).toBe(200)
  expect(env.CAPS.record(ip).values.get('values').actions).toBe(41)
  expect((await call('w2', '/api/settings', true)).status).toBe(429)
  expect(env.CAPS.record(dayKey()).values.get('values').actions).toBe(250)
})

it('gives back the day reservation when the ip reservation fails', async () => {
  const { env, call } = await setup()
  const ip = `cap:ip:${await digest('203.0.113.1')}:${new Date().toISOString().slice(0, 10)}`
  env.CAPS.record(ip).values.set('values', { actions: 40 })
  expect((await call('w1')).status).toBe(429)
  expect(env.CAPS.record(dayKey()).values.get('values').actions).toBe(0)
})

it('makes no cap object calls during a state read and only two for a mutation', async () => {
  const { env, call } = await setup()
  expect((await call('w1', '/api/state', false, 'GET')).status).toBe(200)
  expect(env.CAPS.calls).toHaveLength(0)
  expect((await call('w1')).status).toBe(200)
  expect(env.CAPS.calls).toHaveLength(2)
})
