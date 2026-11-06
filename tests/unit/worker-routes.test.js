import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/worker.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { DAILY_ACTIONS, DAILY_INVOICES, DAILY_MAINTAINER_WORKSPACES, DAILY_WORKSPACES, MAX_AUDIO_BYTES, PER_IP_ACTIONS, PER_IP_INVOICES } from '../../src/caps.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { BudgetError } from '../../src/ai/model.js'

const ctx = { waitUntil: () => {} }
const request = (path, { method = 'GET', cookie = 'jd_ws=w1', body, headers = {}, host = 'job-done.test' } = {}) => new Request(`https://${host}${path}`, {
  method,
  headers: { cookie, 'cf-connecting-ip': '203.0.113.1', ...(body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
})

async function setup({ workspace = true, env = {}, script = {} } = {}) {
  const kv = memoryKV()
  if (workspace) await kv.put('ws:w1', JSON.stringify(seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })))
  const pp = fakePayPal(script)
  vi.stubGlobal('fetch', pp.fetch)
  return { kv, pp, env: { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y', ...env } }
}

async function prime(env) {
  await call(env, '/api/settings', { method: 'POST', body: {} })
}

const call = (env, path, options) => worker.fetch(request(path, options), env, ctx)
const saved = async (kv) => JSON.parse(await kv.get('ws:w1'))
const today = () => new Date().toISOString().slice(0, 10)

function d1Ledger({ rejectAfterFirst = false } = {}) {
  const rows = []
  let nextId = 1
  return {
    prepare(sql) {
      let values = []
      return {
        bind(...args) {
          values = args
          return this
        },
        async first() {
          if (sql.includes('RETURNING id')) {
            const [app, day, neurons] = values
            if (rejectAfterFirst && app === 'job-done' && rows.length > 0) return null
            const id = nextId++
            rows.push({ id, app, day, neurons })
            return { id }
          }
          const day = values[0]
          const app = values[1]
          if (rejectAfterFirst && app === 'job-done' && rows.length > 0) return { total: 1000 }
          return { total: rows.filter((row) => row.day === day && (app === undefined || row.app === app)).reduce((total, row) => total + row.neurons, 0) }
        },
        async run() { rows.push({ app: values[0], day: values[1], neurons: values[2] }) },
      }
    },
  }
}

function wav(size = 32000) {
  const bytes = new Uint8Array(44 + size)
  const view = new DataView(bytes.buffer)
  const tag = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + size, true)
  tag(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, size, true)
  return bytes
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetTokenCache()
})

describe('Worker API routes', () => {
  it('adds a waiting job and reserves one action without sending', async () => {
    const { env, kv, pp } = await setup()
    const response = await call(env, '/api/waiting', { method: 'POST', body: { customerId: 'c3', summary: 'Gutter clean', hours: 2, free: 'mornings' } })
    expect(response.status).toBe(200)
    expect((await response.json()).state.ws.jobs.at(-1)).toMatchObject({ state: 'waiting', customerId: 'c3', summary: 'Gutter clean', hours: 2, free: 'mornings' })
    expect((await saved(kv)).waiting).toHaveLength(2)
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(1)
    expect(pp.calls).toEqual([])
  })
  it('changes a waiting job and reserves one action', async () => {
    const { env, kv, pp } = await setup()
    const response = await call(env, '/api/waiting/j5', { method: 'POST', body: { hours: 2, free: [1, 3] } })
    expect(response.status).toBe(200)
    expect((await response.json()).state.ws.jobs.find((j) => j.id === 'j5')).toMatchObject({ hours: 2, free: [1, 3] })
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(1)
    expect(pp.calls).toEqual([])
  })
  it('removes a waiting job and reserves one action', async () => {
    const { env, kv, pp } = await setup()
    const response = await call(env, '/api/waiting/j5/remove', { method: 'POST' })
    expect(response.status).toBe(200)
    const { state } = await response.json()
    expect(state.ws.waiting).toEqual([])
    expect(state.ws.jobs.some((j) => j.id === 'j5')).toBe(false)
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(1)
    expect(pp.calls).toEqual([])
  })
  it('returns 422 for invalid waiting input without saving or consuming the allowance', async () => {
    const { env, kv } = await setup()
    const before = await saved(kv)
    const response = await call(env, '/api/waiting', { method: 'POST', body: { customerId: 'c3', summary: 'Gutter clean', hours: 0.25 } })
    expect(response.status).toBe(422)
    expect((await response.json()).message).toMatch(/hours/i)
    expect(await saved(kv)).toEqual(before)
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(0)
  })
  it('keeps the cleaned original words on a new customer proposal', async () => {
    const { env } = await setup({ env: { MODEL_STUB: '1' } })
    const text = 'Kitchen tap for Tom Baker, hour and a half. ' + 'details '.repeat(80)
    const response = await call(env, '/api/agent', { host: 'localhost', method: 'POST', body: { text: '\u0000' + text } })
    expect(response.status).toBe(200)
    expect((await response.json()).proposal).toMatchObject({ kind: 'new_customer', text: text.trim().slice(0, 500) })
  })

  it('saves a new customer and returns state while counting one action without sending', async () => {
    const { env, kv, pp } = await setup()
    const response = await call(env, '/api/customers', { method: 'POST', body: { name: 'Tom Baker', address: '', email: 'tom@example.com' } })
    expect(response.status).toBe(200)
    expect((await response.json()).state.ws.customers.at(-1)).toMatchObject({ name: 'Tom Baker', email: 'tom@example.com' })
    expect((await saved(kv)).customers).toHaveLength(5)
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(1)
    expect(pp.calls).toEqual([])
  })

  it('rejects a gmail customer with 422 and preserves state and action allowance', async () => {
    const { env, kv, pp } = await setup()
    const before = await saved(kv)
    const response = await call(env, '/api/customers', { method: 'POST', body: { name: 'Tom Baker', address: '', email: 'tom@gmail.com' } })
    expect(response.status).toBe(422)
    expect((await response.json()).message).toMatch(/example.com/)
    expect(await saved(kv)).toEqual(before)
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).actions).toBe(0)
    expect(pp.calls).toEqual([])
  })

  it('declines an offer, saves the next offer and counts an action without sending', async () => {
    const { env, kv, pp } = await setup()
    await prime(env)
    const ws = await saved(kv)
    const start = new Date(Date.now() + 86400000).toISOString()
    const end = new Date(Date.parse(start) + 3600000).toISOString()
    Object.assign(ws.jobs.find((j) => j.id === 'j5'), { state: 'offered', start, end })
    ws.waiting = ['next']
    ws.jobs.push({ id: 'next', customerId: 'c2', summary: 'Next tap', hours: 1, state: 'waiting', start: '', end: '' })
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start, end }
    ws.drafts.d1 = { id: 'd1', jobId: 'j5', kind: 'deposit' }
    await kv.put('ws:w1', JSON.stringify(ws))
    const dayKey = `cap:day:${today()}`
    const before = JSON.parse(await kv.get(dayKey)).actions
    const response = await call(env, '/api/offers/o1/decline', { method: 'POST' })
    expect(response.status).toBe(200)
    const body = await response.json()
    const state = await saved(kv)
    expect(body.state.ws.jobs.find((j) => j.id === 'j5')).toMatchObject({ state: 'waiting', start: '', end: '' })
    expect(state.offers.o1).toBeUndefined()
    expect(state.drafts.d1).toBeUndefined()
    expect(Object.values(state.offers)).toEqual([expect.objectContaining({ jobId: 'next', start, end })])
    expect(JSON.parse(await kv.get(dayKey)).actions).toBe(before + 1)
    expect(pp.calls).toEqual([])
    expect((await call(env, '/api/offers/o1/decline', { method: 'POST' })).status).toBe(404)
    const day = JSON.parse(await kv.get(dayKey))
    day.actions = DAILY_ACTIONS
    await kv.put(dayKey, JSON.stringify(day))
    const nextOffer = Object.values(state.offers)[0]
    expect((await call(env, `/api/offers/${nextOffer.id}/decline`, { method: 'POST' })).status).toBe(429)
    expect((await saved(kv)).offers[nextOffer.id]).toBeDefined()
  })

  it('state polling drops stale booking drafts and saves the cleanup', async () => {
    const { env, kv } = await setup()
    const ws = await saved(kv)
    ws.jobs.push({ id: 'old', state: 'draft', draftedAt: Date.now() - 31 * 60_000, start: '', end: '' })
    ws.drafts.old = { id: 'old', jobId: 'old', kind: 'deposit' }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/state')
    expect((await response.json()).ws.jobs.some((j) => j.id === 'old')).toBe(false)
    expect((await saved(kv)).drafts.old).toBeUndefined()
  })

  it('runs out a live demo hold now and returns the new state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-28T14:00:00Z'))
    const ws = seedWorkspace({ id: 'w1', now: Date.now(), tzOffsetMinutes: 0 })
    ws.holds = [{ jobId: 'j2', invoiceId: 'INV2-DEP', start: ws.jobs.find((item) => item.id === 'j2').start, end: ws.jobs.find((item) => item.id === 'j2').end, expiresAt: Date.now() + 120000 }]
    ws.invoices['INV2-DEP'] = { id: 'INV2-DEP', customerId: 'c1', kind: 'deposit', total: '50.00', due: '50.00', status: 'SENT', sentAt: Date.now(), reminders: 0 }
    const kv = memoryKV()
    await kv.put('ws:w1', JSON.stringify(ws))
    const pp = fakePayPal({
      'GET /v2/invoicing/invoices/INV2-DEP': [{ status: 200, body: { id: 'INV2-DEP', status: 'SENT', amount: { currency_code: 'USD', value: '50.00' }, due_amount: { currency_code: 'USD', value: '50.00' } } }],
      'POST /v2/invoicing/invoices/INV2-DEP/cancel': [{ status: 204 }],
    })
    vi.stubGlobal('fetch', pp.fetch)
    const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'id-x', PAYPAL_CLIENT_SECRET: 'secret-y' }
    const response = await call(env, '/api/holds/j2/expire', { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json()).state.ws.holds[0].ended).toBe('released')
    expect(pp.calls.some((item) => item.path.endsWith('/cancel'))).toBe(true)
  })

  it('refuses to run out a non demo hold', async () => {
    const { env, kv } = await setup()
    const ws = await saved(kv)
    ws.settings.holdMinutes = 1440
    ws.holds = [{ jobId: 'j2', invoiceId: 'INV2-DEP', expiresAt: Date.now() + 86400000 }]
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/holds/j2/expire', { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_demo', message: 'Only demo holds can be run out early.' })
  })

  it('returns not found for an unknown or ended hold', async () => {
    const { env, kv } = await setup()
    const ws = await saved(kv)
    ws.holds = [{ jobId: 'j2', invoiceId: 'INV2-DEP', ended: 'paid', expiresAt: Date.now() + 120000 }]
    await kv.put('ws:w1', JSON.stringify(ws))
    expect((await call(env, '/api/holds/nope/expire', { method: 'POST' })).status).toBe(404)
    expect((await call(env, '/api/holds/j2/expire', { method: 'POST' })).status).toBe(404)
  })

  it('creates a workspace, clamps its timezone and refuses the daily workspace cap', async () => {
    const { env, kv } = await setup({ workspace: false })
    const created = await call(env, '/api/workspace', { method: 'POST', body: { tz: 900 } })
    expect(created.status).toBe(200)
    expect(created.headers.get('set-cookie')).toMatch(/jd_ws=[a-f0-9]{24}/)
    const response = await created.json()
    expect(response.ws.tz).toBe(840)
    const day = JSON.parse(await kv.get(`cap:day:${today()}`))
    day.demos = DAILY_WORKSPACES
    await kv.put(`cap:day:${today()}`, JSON.stringify(day))
    const refused = await call(env, '/api/workspace', { method: 'POST', body: {} })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: 'busy' })
  })

  it('allows 20 visitor demos and refuses the 21st', async () => {
    const { env, kv } = await setup({ workspace: false })
    for (let index = 0; index < DAILY_WORKSPACES; index++) {
      expect((await call(env, '/api/workspace', { method: 'POST', body: {} })).status).toBe(200)
    }
    const refused = await call(env, '/api/workspace', { method: 'POST', body: {} })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ message: 'Too many demos were started today. Try again tomorrow.' })
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).demos).toBe(DAILY_WORKSPACES)
  })

  it('keeps maintainer demos apart from visitor demos', async () => {
    const token = 'm'.repeat(32)
    const { env, kv } = await setup({ workspace: false, env: { MAINTAINER_TOKEN: token } })
    for (let index = 0; index < 20; index++) {
      expect((await call(env, '/api/workspace', { method: 'POST', cookie: `jd_maint=${token}`, body: {} })).status).toBe(200)
    }
    for (let index = 0; index < DAILY_WORKSPACES; index++) {
      expect((await call(env, '/api/workspace', { method: 'POST', body: {} })).status).toBe(200)
    }
    const day = JSON.parse(await kv.get(`cap:day:${today()}`))
    expect(day).toMatchObject({ maintainerDemos: 20, demos: DAILY_WORKSPACES })
  })

  it('refuses the 61st maintainer demo in a day', async () => {
    const token = 'm'.repeat(32)
    const { env, kv } = await setup({ workspace: false, env: { MAINTAINER_TOKEN: token } })
    for (let index = 0; index < DAILY_MAINTAINER_WORKSPACES; index++) {
      expect((await call(env, '/api/workspace', { method: 'POST', cookie: `jd_maint=${token}`, body: {} })).status).toBe(200)
    }
    const refused = await call(env, '/api/workspace', { method: 'POST', cookie: `jd_maint=${token}`, body: {} })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ message: 'Too many demos were started today. Try again tomorrow.' })
    expect(JSON.parse(await kv.get(`cap:day:${today()}`)).maintainerDemos).toBe(DAILY_MAINTAINER_WORKSPACES)
  })

  it('counts 41 local demos from one test visitor without enforcing action limits', async () => {
    const { env, kv } = await setup({ workspace: false, env: { MODEL_STUB: '1' } })
    for (let index = 0; index < 41; index++) {
      const response = await call(env, '/api/workspace', {
        method: 'POST', host: '127.0.0.1', cookie: 'jd_test=workspace-run', body: {},
      })
      expect(response.status).toBe(200)
    }
    const day = JSON.parse(await kv.get(`cap:day:${today()}:workspace-run:new`))
    expect(day).toMatchObject({ demos: 41, actions: 41 })
    const ipKey = [...kv.keys()].find((key) => key.startsWith('cap:ip:'))
    expect(JSON.parse(await kv.get(ipKey)).actions).toBe(41)
  })

  it('enforces the hosted workspace limit even with a local test cookie', async () => {
    const { env, kv } = await setup({ workspace: false, env: { MODEL_STUB: '1' } })
    await kv.put(`cap:day:${today()}`, JSON.stringify({ demos: DAILY_WORKSPACES - 3, actions: DAILY_ACTIONS }))
    for (let index = 0; index < 4; index++) {
      const response = await call(env, '/api/workspace', {
        method: 'POST', cookie: 'jd_test=workspace-run', body: {},
      })
      expect(response.status).toBe(index < 3 ? 200 : 429)
      if (index === 3) expect(await response.json()).toMatchObject({ error: 'busy', message: 'Too many demos were started today. Try again tomorrow.' })
    }
    expect(JSON.parse(await kv.get(`cap:day:${today()}`))).toMatchObject({ demos: DAILY_WORKSPACES, actions: DAILY_ACTIONS + 3 })
  })

  it('returns 404 without a workspace and forwards non API requests to assets', async () => {
    const { env } = await setup({ workspace: false, env: { ASSETS: { fetch: vi.fn(async () => new Response('asset')) } } })
    expect((await call(env, '/api/state')).status).toBe(404)
    expect(await (await call(env, '/favicon.ico')).text()).toBe('asset')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
    const bare = await call({ JOBDONE: memoryKV() }, '/favicon.ico')
    expect(bare.status).toBe(404)
    expect(await bare.text()).toBe('Not found')
    expect((await call({ JOBDONE: memoryKV() }, '/api/state', { cookie: '' })).status).toBe(404)
  })

  it('returns state without QR data, releases expired holds and polls an unshared watched invoice', async () => {
    const now = Date.now()
    const { env, kv, pp } = await setup({ script: {
      'GET /v2/invoicing/invoices/INV2-WATCH': [{ status: 200, body: { id: 'INV2-WATCH', status: 'PAID', amount: { value: '10.00' }, due_amount: { value: '0.00' } } }],
      'GET /v2/invoicing/invoices/INV2-OLD': [{ status: 200, body: { id: 'INV2-OLD', status: 'CANCELLED', amount: { value: '10.00' }, due_amount: { value: '10.00' } } }],
    } })
    const ws = await saved(kv)
    ws.holds.push({ jobId: 'j5', invoiceId: 'INV2-OLD', expiresAt: now - 1 })
    ws.invoices['INV2-WATCH'] = { id: 'INV2-WATCH', customerId: 'c1', jobId: 'j2', kind: 'invoice', total: '10.00', due: '10.00', status: 'SENT', qr: 'aGVsbG8=' }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/state?watch=INV2-WATCH')
    const body = await response.json()
    expect(body.ws.invoices['INV2-WATCH']).toMatchObject({ status: 'PAID', hasQr: true })
    expect(body.ws.invoices['INV2-WATCH']).not.toHaveProperty('qr')
    expect((await saved(kv)).holds[0].ended).toBeTruthy()
    expect(pp.calls.some((c) => c.path === '/v2/invoicing/invoices/INV2-WATCH')).toBe(true)
  })

  it('does not poll a shared invoice or poll the same invoice again within five seconds', async () => {
    const { env, kv, pp } = await setup()
    const ws = await saved(kv)
    ws.invoices['INV2-SHARED'] = { id: 'INV2-SHARED', shared: true, status: 'SENT' }
    ws.invoices['INV2-WATCH2'] = { id: 'INV2-WATCH2', status: 'SENT' }
    await kv.put('ws:w1', JSON.stringify(ws))
    await call(env, '/api/state?watch=INV2-SHARED')
    await call(env, '/api/state?watch=INV2-WATCH2')
    await call(env, '/api/state?watch=INV2-WATCH2')
    expect(pp.calls.filter((entry) => entry.path.includes('/invoices/'))).toHaveLength(1)
  })

  it('serves an invoice QR and refuses missing or shared QR images', async () => {
    const { env, kv } = await setup()
    const ws = await saved(kv)
    ws.invoices.QR1 = { id: 'QR1', qr: 'aGVsbG8=' }
    ws.invoices.SHARED = { id: 'SHARED', qr: 'aGVsbG8=', shared: true }
    await kv.put('ws:w1', JSON.stringify(ws))
    const found = await call(env, '/api/qr/QR1')
    expect(found.headers.get('content-type')).toBe('image/png')
    expect(found.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
    expect((await call(env, '/api/qr/MISSING')).status).toBe(404)
    expect((await call(env, '/api/qr/SHARED')).status).toBe(404)
  })

  it('rejects voice uploads by declared size, actual duration and format, and without a ledger', async () => {
    const { env } = await setup()
    const header = await call(env, '/api/voice', { method: 'POST', body: new Uint8Array(), headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) } })
    expect(header.status).toBe(413)
    const length = await call(env, '/api/voice', { method: 'POST', body: wav(MAX_AUDIO_BYTES + 1), headers: { 'content-type': 'audio/wav' } })
    expect(length.status).toBe(413)
    const format = await call(env, '/api/voice', { method: 'POST', body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'audio/wav' } })
    expect(format.status).toBe(415)
    const noLedger = await call(env, '/api/voice', { method: 'POST', body: wav(), headers: { 'content-type': 'audio/wav' } })
    expect(noLedger.status).toBe(503)
    expect(await noLedger.json()).toMatchObject({ error: 'budget' })
  })

  it('returns a server error when the speech service fails unexpectedly', async () => {
    const { env } = await setup({ env: { AI: { run: async () => { throw new Error('model unavailable') } }, LEDGER: d1Ledger() } })
    const response = await call(env, '/api/voice', { method: 'POST', body: wav(), headers: { 'content-type': 'audio/wav' } })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'server' })
  })

  it('answers empty, recorded and unrecorded agent turns with the corresponding replay behavior', async () => {
    const { env } = await setup()
    const empty = await call(env, '/api/agent', { method: 'POST', body: { text: '  ' } })
    expect(empty.status).toBe(422)
    expect(await empty.json()).toMatchObject({ error: 'empty' })
    env.MODEL_STUB = '1'
    const liveStub = await call(env, '/api/agent', { method: 'POST', body: { text: 'show my schedule' }, cookie: 'jd_ws=w1; jd_test=agent', host: 'localhost' })
    expect(liveStub.status).toBe(200)
  })

  it('treats a missing agent text as empty and permits local stub requests without a test cookie', async () => {
    const { env } = await setup({ env: { MODEL_STUB: '1' } })
    const empty = await call(env, '/api/agent', { method: 'POST', body: {} })
    expect(empty.status).toBe(422)
    const local = await call(env, '/api/agent', { method: 'POST', body: { text: 'show my schedule' }, cookie: 'jd_ws=w1', host: '127.0.0.1' })
    expect(local.status).toBe(200)
    expect(await local.json()).toMatchObject({ replay: false })
    const noTestVisitor = await call(env, '/api/state', { cookie: '', host: 'localhost' })
    expect(noTestVisitor.status).toBe(404)
    const noWorkspaceCookie = await call(env, '/api/state', { cookie: 'jd_test=orphan', host: 'localhost' })
    expect(noWorkspaceCookie.status).toBe(404)
  })

  it('replays a recorded agent line when live budget is unavailable', async () => {
    const { env } = await setup()
    const result = await call(env, '/api/agent', { method: 'POST', body: { text: 'book the bathroom tap for maria next week' } })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ replay: true, proposal: { kind: 'booking' } })
  })

  it('runs a live agent turn when its ledger has room', async () => {
    let aiCalls = 0
    const { env } = await setup({ env: {
      RECORD_SAMPLES: '1',
      LEDGER: d1Ledger(),
      AI: { run: async () => { aiCalls++; return { response: '{"final":{"kind":"answer","text":"Hello.","invoice_ids":[]}}', usage: { prompt_tokens: 1, completion_tokens: 1 } } } },
    } })
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 'Hello there' } })
    expect(response.status).toBe(200)
    expect(aiCalls).toBe(1)
    expect(await response.json()).toMatchObject({ replay: false, proposal: { kind: 'answer' }, recorded: { outputs: expect.any(Array) } })
  })

  it('records a failed tool and a dropped model proposal in the panel', async () => {
    let aiCalls = 0
    const { env, kv } = await setup({ env: {
      LEDGER: d1Ledger(),
      AI: { run: async () => {
        aiCalls++
        const response = aiCalls === 1
          ? '{"calls":[{"tool":"not_a_tool","args":{}}]}'
          : '{"final":{"kind":"refund","invoice_id":"INV2-UNKNOWN"}}'
        return { response, usage: { prompt_tokens: 1, completion_tokens: 1 } }
      } },
    } })
    const result = await call(env, '/api/agent', { method: 'POST', body: { text: 'refund this invoice' } })
    expect(result.status).toBe(200)
    expect(aiCalls).toBe(3)
    const ws = await saved(kv)
    expect(ws.panel.some((entry) => entry.kind === 'tool' && entry.status === 422)).toBe(true)
    expect(ws.panel.some((entry) => entry.kind === 'guard' && entry.status === 422)).toBe(true)
  })

  it('falls back to a recorded reply when the ledger refuses a live turn midway', async () => {
    let aiCalls = 0
    const { env } = await setup({ env: {
      LEDGER: d1Ledger({ rejectAfterFirst: true }),
      AI: { run: async () => { aiCalls++; return { response: '{"calls":[{"tool":"open_invoices","args":{}}]}', usage: { prompt_tokens: 1, completion_tokens: 1 } } } },
    } })
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.' } })
    expect(response.status).toBe(200)
    expect(aiCalls).toBe(1)
    expect(await response.json()).toMatchObject({ replay: true, proposal: { kind: 'invoice' } })
  })

  it('returns the budget message when a refused live turn has no recorded reply', async () => {
    const { env } = await setup({ env: {
      LEDGER: d1Ledger({ rejectAfterFirst: true }),
      AI: { run: async () => ({ response: '{"calls":[{"tool":"open_invoices","args":{}}]}', usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
    } })
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 'a one time phrase with no recording' } })
    expect(await response.json()).toMatchObject({ proposal: null, replay: true, message: expect.stringContaining('free AI budget') })
  })

  it('returns the unrecorded line refusal when the AI budget cannot fund a turn', async () => {
    const { env } = await setup()
    const result = await call(env, '/api/agent', { method: 'POST', body: { text: 'a unique phrase never recorded' } })
    expect(await result.json()).toMatchObject({ proposal: null, replay: true, lines: expect.any(Array) })
  })

  it('refuses invoice actions when invoice caps are exhausted', async () => {
    const { env, kv } = await setup()
    await prime(env)
    const ws = await saved(kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: 0, lines: [] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    const ipKey = [...kv.keys()].find((key) => key.startsWith('cap:ip:'))
    const counters = JSON.parse(await kv.get(ipKey))
    counters.invoices = PER_IP_INVOICES
    await kv.put(ipKey, JSON.stringify(counters))
    const dayKey = `cap:day:${today()}`
    const day = JSON.parse(await kv.get(dayKey))
    day.invoices = DAILY_INVOICES
    await kv.put(dayKey, JSON.stringify(day))
    const result = await call(env, '/api/drafts/d1/send', { method: 'POST' })
    expect(result.status).toBe(429)
    expect(await result.json()).toMatchObject({ error: 'busy' })
  })

  it('sends an existing deposit draft and refuses a missing invoice draft', async () => {
    const { env, kv } = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: {
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-DEP' } }],
      'POST /v2/invoicing/invoices/INV2-DEP/send': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-DEP/generate-qr-code': [{ status: 200, body: 'iVBORw0KGgo=' }],
      'GET /v2/invoicing/invoices/INV2-DEP': [{ status: 200, body: { id: 'INV2-DEP', status: 'SENT', amount: { value: '50.00' }, due_amount: { value: '50.00' } } }],
    } })
    const ws = await saved(kv)
    ws.drafts.d1 = { id: 'd1', kind: 'deposit', customerId: 'c1', jobId: 'j2', summary: 'Booking', priced: { currency: 'USD', taxPercent: 0, total: '50.00', itemTotal: '50.00', tax: '0.00', lines: [{ name: 'Deposit', quantity: '1', unitAmount: '50.00', amount: '50.00', uom: 'ITEM', description: 'Deposit' }] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    const missing = await call(env, '/api/drafts/missing/send', { method: 'POST' })
    expect(missing.status).toBe(404)
    const sent = await call(env, '/api/drafts/d1/send', { method: 'POST' })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({ invoiceId: 'INV2-DEP' })
  })

  it('does not create a second invoice when a sent draft is tapped again', async () => {
    const { env, kv, pp } = await setup()
    const ws = await saved(kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', invoiceId: 'INV2-ALREADY', sentAt: Date.now() }
    ws.invoices['INV2-ALREADY'] = { id: 'INV2-ALREADY', status: 'SENT', total: '10.00', due: '10.00' }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/drafts/d1/send', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ invoiceId: 'INV2-ALREADY' })
    expect(pp.calls).toHaveLength(0)
  })

  it('records cash and reminder route results and persists workspace changes', async () => {
    const { env, kv } = await setup({ script: {
      'GET /v2/invoicing/invoices/INV2-DAVE': [
        { status: 200, body: { id: 'INV2-DAVE', status: 'SENT', amount: { value: '108.00' }, due_amount: { value: '108.00' } } },
        { status: 200, body: { id: 'INV2-DAVE', status: 'MARKED_AS_PAID', amount: { value: '108.00' }, due_amount: { value: '0.00' } } },
      ],
      'POST /v2/invoicing/invoices/INV2-DAVE/payments': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }],
    } })
    const ws = await saved(kv)
    ws.invoices['INV2-DAVE'] = { id: 'INV2-DAVE', customerId: 'c2', jobId: 'j1', kind: 'invoice', total: '108.00', due: '108.00', status: 'SENT', reminders: 0 }
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', reminders: 0 }
    await kv.put('ws:w1', JSON.stringify(ws))
    expect((await call(env, '/api/invoices/INV2-DAVE/cash', { method: 'POST', body: { amount: '108.00' } })).status).toBe(200)
    expect((await saved(kv)).invoices['INV2-DAVE']).toMatchObject({ cash: true, due: '0.00' })
    expect((await call(env, '/api/invoices/INV2-SAM/remind', { method: 'POST', body: { text: 'Please pay 340.00' } })).status).toBe(200)
    expect((await saved(kv)).invoices['INV2-SAM'].reminders).toBe(1)
  })

  it('refuses cash with no amount and accepts a standard reminder with no message', async () => {
    const { env, kv } = await setup({ script: { 'POST /v2/invoicing/invoices/INV2-SAM/remind': [{ status: 204 }], 'GET /v2/invoicing/invoices/INV2-DAVE': [{ status: 200, body: { id: 'INV2-DAVE', status: 'SENT', amount: { value: '108.00' }, due_amount: { value: '108.00' } } }] } })
    const ws = await saved(kv)
    ws.invoices['INV2-DAVE'] = { id: 'INV2-DAVE', customerId: 'c2', due: '108.00', total: '108.00', status: 'SENT' }
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', due: '340.00', total: '340.00', status: 'SENT' }
    await kv.put('ws:w1', JSON.stringify(ws))
    const cash = await call(env, '/api/invoices/INV2-DAVE/cash', { method: 'POST', body: {} })
    expect(cash.status).toBe(422)
    expect(await cash.json()).toMatchObject({ error: 'cash_bad' })
    const reminder = await call(env, '/api/invoices/INV2-SAM/remind', { method: 'POST', body: {} })
    expect(reminder.status).toBe(200)
  })

  it('refuses a missing offer, enforces invoice caps and accepts a valid offer', async () => {
    const { env, kv } = await setup()
    await prime(env)
    const ws = await saved(kv)
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T10:00:00.000Z', accepted: false }
    ws.drafts.d1 = { id: 'd1', kind: 'deposit', customerId: 'c4', jobId: 'j5', priced: { total: '50.00', lines: [] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    expect((await call(env, '/api/offers/missing/accept', { method: 'POST' })).status).toBe(404)
    const dayKey = `cap:day:${today()}`
    const day = JSON.parse(await kv.get(dayKey))
    day.invoices = DAILY_INVOICES
    await kv.put(dayKey, JSON.stringify(day))
    expect((await call(env, '/api/offers/o1/accept', { method: 'POST' })).status).toBe(429)
  })

  it('accepts an offer by sending its deposit, starting the hold and indexing the invoice', async () => {
    const { env, kv } = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: {
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-OFFER' } }],
      'POST /v2/invoicing/invoices/INV2-OFFER/send': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-OFFER/generate-qr-code': [{ status: 200, body: 'iVBORw0KGgo=' }],
      'GET /v2/invoicing/invoices/INV2-OFFER': [{ status: 200, body: { id: 'INV2-OFFER', status: 'SENT', amount: { value: '50.00' }, due_amount: { value: '50.00' } } }],
    } })
    const ws = await saved(kv)
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T10:00:00.000Z', accepted: false }
    ws.drafts.d1 = { id: 'd1', kind: 'deposit', customerId: 'c4', jobId: 'j5', summary: 'Hold slot', priced: { currency: 'USD', taxPercent: 0, total: '50.00', itemTotal: '50.00', tax: '0.00', lines: [{ name: 'Deposit', quantity: '1', unitAmount: '50.00', amount: '50.00', uom: 'ITEM' }] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/offers/o1/accept', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ invoiceId: 'INV2-OFFER' })
    expect((await saved(kv)).offers.o1.accepted).toBe(true)
    expect((await saved(kv)).holds[0].invoiceId).toBe('INV2-OFFER')
    expect(await kv.get('inv:INV2-OFFER')).toBe('w1')
  })

  it('does not resend an already accepted offer without a deposit invoice', async () => {
    const { env, kv, pp } = await setup()
    const ws = await saved(kv)
    ws.offers.o1 = { id: 'o1', jobId: 'j5', draftId: 'd1', accepted: true }
    await kv.put('ws:w1', JSON.stringify(ws))
    const response = await call(env, '/api/offers/o1/accept', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('invoiceId')
    expect(pp.calls).toHaveLength(0)
  })

  it('validates schedule moves, saves successful moves, and reports clashes without moving jobs', async () => {
    const { env, kv } = await setup()
    const bad = await call(env, '/api/schedule/move', { method: 'POST', body: { jobId: 'missing', start: 'bad date' } })
    expect(bad.status).toBe(422)
    const ok = await call(env, '/api/schedule/move', { method: 'POST', body: { jobId: 'j2', start: '2026-11-08T10:00:00.000Z' } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true })
    const before = (await saved(kv)).jobs.find((job) => job.id === 'j2').start
    const ws = await saved(kv)
    ws.jobs.push({ id: 'j100', customerId: 'c1', summary: 'Blocked repair', start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T10:00:00.000Z', state: 'booked' })
    await kv.put('ws:w1', JSON.stringify(ws))
    const clash = await call(env, '/api/schedule/move', { method: 'POST', body: { jobId: 'j2', start: '2026-11-04T09:00:00.000Z' } })
    expect(await clash.json()).toMatchObject({ ok: false })
    expect((await saved(kv)).jobs.find((job) => job.id === 'j2').start).toBe(before)
  })

  it('updates supported settings and returns 404 for unknown API routes and methods', async () => {
    const { env, kv } = await setup()
    expect((await call(env, '/api/settings', { method: 'POST', body: { holdMinutes: 1440 } })).status).toBe(200)
    expect((await saved(kv)).settings.holdMinutes).toBe(1440)
    expect((await call(env, '/api/unknown', { method: 'POST' })).status).toBe(404)
    expect((await call(env, '/api/settings', { method: 'GET' })).status).toBe(404)
  })

  it('applies action caps before routing an action', async () => {
    const { env, kv } = await setup()
    await prime(env)
    const ipKey = [...kv.keys()].find((key) => key.startsWith('cap:ip:'))
    const ip = JSON.parse(await kv.get(ipKey))
    ip.actions = PER_IP_ACTIONS
    await kv.put(ipKey, JSON.stringify(ip))
    expect((await call(env, '/api/settings', { method: 'POST', body: {} })).status).toBe(429)
    const { env: dailyEnv, kv: dailyKv } = await setup()
    const dayKey = `cap:day:${today()}`
    await dailyKv.put(dayKey, JSON.stringify({ actions: DAILY_ACTIONS }))
    expect((await call(dailyEnv, '/api/settings', { method: 'POST', body: {} })).status).toBe(429)
  })
})

describe('Worker error mapping and health routes', () => {
  it('maps PayPal, coded, budget and unknown failures to public error responses', async () => {
    const { env, kv } = await setup()
    const ws = await saved(kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'missing', priced: { lines: [] } }
    await kv.put('ws:w1', JSON.stringify(ws))
    const paypalEnv = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: { 'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1' } }] } })
    const paypalWs = await saved(paypalEnv.kv)
    paypalWs.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: 0, lines: [{ name: 'x', quantity: '1', unitAmount: '1.00' }] } }
    await paypalEnv.kv.put('ws:w1', JSON.stringify(paypalWs))
    const pp = await call(paypalEnv.env, '/api/drafts/d1/send', { method: 'POST' })
    expect(pp.status).toBe(502)
    expect(await pp.json()).toMatchObject({ error: 'paypal', message: expect.stringContaining('debug id dbg1') })
    const coded = await call(env, '/api/invoices/INV2-MISSING/cash', { method: 'POST', body: { amount: '1.00' } })
    expect(coded.status).toBe(404)
    expect(await coded.json()).toMatchObject({ error: 'not_found' })
    const unknown = await call({ ...env, JOBDONE: { get: async () => { throw new Error('secret detail') } } }, '/api/state')
    expect(unknown.status).toBe(500)
    expect(await unknown.json()).toMatchObject({ error: 'server' })
    const budgetEnv = { ...env, LEDGER: { prepare: () => { throw new BudgetError('day') } } }
    const budget = await call(budgetEnv, '/api/state')
    expect(budget.status).toBe(429)
    expect(await budget.json()).toMatchObject({ error: 'budget', replay: true })
    const noDetails = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: { 'POST /v2/invoicing/invoices': [{ status: 422, body: {} }] } })
    const draftWs = await saved(noDetails.kv)
    draftWs.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: 0, total: '1.00', itemTotal: '1.00', tax: '0.00', lines: [{ name: 'Repair', quantity: '1', unitAmount: '1.00', amount: '1.00', uom: 'ITEM' }] } }
    await noDetails.kv.put('ws:w1', JSON.stringify(draftWs))
    const noFields = await call(noDetails.env, '/api/drafts/d1/send', { method: 'POST' })
    expect(noFields.status).toBe(502)
    expect((await noFields.json()).message).toBe('PayPal answered 422.')
    const thrownNull = await call({ ...env, LEDGER: { prepare: () => { throw null } } }, '/api/state')
    expect(thrownNull.status).toBe(500)
  })

  it('returns basic and deep health and redacts PayPal secrets from failures', async () => {
    const { env, kv } = await setup({ env: { BUILD_HASH: 'build-42' } })
    expect(await (await call(env, '/health')).json()).toEqual({ ok: true, build: 'build-42' })
    await kv.put('seed:late-invoice', 'INV2-HEALTH')
    const good = await setup({ script: { 'GET /v2/invoicing/invoices/INV2-HEALTH': [{ status: 200, body: { id: 'INV2-HEALTH', status: 'SENT', amount: { value: '10.00' } } }] } })
    await good.kv.put('seed:late-invoice', 'INV2-HEALTH')
    const deep = await call(good.env, '/health?deep=1')
    expect(await deep.json()).toMatchObject({ ok: true, paypal: 'ok', lateInvoice: 'SENT' })
  })

  it('reports deep health errors without leaking secrets and lists only valid recent history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 3_600_000)
    const failed = await setup({ env: { API_TOKEN: 'top-secret-token' }, script: {
      'POST /v1/oauth2/token': [{ status: 401, body: { error: 'invalid_client', error_description: 'top-secret-token denied' } }],
    } })
    const deep = await call(failed.env, '/health?deep=1')
    const result = await deep.json()
    expect(result.ok).toBe(false)
    expect(result.paypal).not.toContain('top-secret-token')
    failed.kv.list = async ({ prefix = '' } = {}) => ({ keys: [...failed.kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) })
    await failed.kv.put('health:2026-10-21', '{broken')
    await failed.kv.put('health:2026-10-22', JSON.stringify({ ok: 1, paypal: 'ok', lateInvoice: 'SENT', checkedAt: 'now' }))
    const history = await call(failed.env, '/health/history')
    expect(await history.json()).toEqual([{ day: '2026-10-22', ok: true, paypal: 'ok', lateInvoice: 'SENT', checkedAt: 'now' }])
    const missing = await worker.fetch(new Request('https://job-done.test/health/history'), {
      JOBDONE: {
        async list() { return { keys: [{ name: 'health:2026-10-23' }] } },
        async get() { return null },
      },
    }, ctx)
    expect(await missing.json()).toEqual([])
  })

  it('reports an HTTP failure when the deep health invoice list cannot be read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 7_200_000)
    const { env } = await setup({ script: { 'GET /v2/invoicing/invoices': [{ status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }] } })
    const result = await (await call(env, '/health?deep=1')).json()
    expect(result).toMatchObject({ ok: false, paypal: 'HTTP 503', lateInvoice: 'none' })
  })

  it('reuses the deep health result during its one minute cache window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10_800_000)
    const { env, pp } = await setup({ script: { 'GET /v2/invoicing/invoices': [{ status: 200, body: { items: [] } }] } })
    const first = await (await call(env, '/health?deep=1')).json()
    const second = await (await call(env, '/health?deep=1')).json()
    expect(second).toEqual(first)
    expect(pp.calls).toHaveLength(2)
  })

  it('stores the scheduled deep health error when the KV read fails', async () => {
    const values = new Map()
    const JOBDONE = {
      async get() { throw new Error('private token failure') },
      async put(key, value) { values.set(key, JSON.parse(value)) },
    }
    await worker.scheduled({ scheduledTime: Date.parse('2026-12-10T12:00:00.000Z') }, { JOBDONE, API_TOKEN: 'private token' }, ctx)
    expect(values.get('health:2026-12-10')).toMatchObject({ ok: false, paypal: expect.stringContaining('[redacted]'), lateInvoice: 'none' })
  })

  it('formats an empty scheduled error and ignores an unsafe extra neuron value', async () => {
    const values = new Map()
    const JOBDONE = {
      async get() { throw null },
      async put(key, value) { values.set(key, JSON.parse(value)) },
    }
    await worker.scheduled({ scheduledTime: Date.parse('2026-12-11T12:00:00.000Z') }, { JOBDONE, API_TOKEN: '', SECRET: 2 }, ctx)
    expect(values.get('health:2026-12-11').paypal).toBe('null')
    const { env } = await setup({ env: { EXTRA_NEURONS: `${today()}:999999999999999999999999999999999999` } })
    expect((await call(env, '/api/state')).status).toBe(200)
    await worker.scheduled({ scheduledTime: Date.parse('2026-12-12T12:00:00.000Z') }, undefined, ctx)
  })

  it('uses the local visitor key when a request has no forwarding IP', async () => {
    const { env } = await setup()
    const response = await worker.fetch(new Request('https://job-done.test/api/state', { headers: { cookie: 'jd_ws=w1' } }), env, ctx)
    expect(response.status).toBe(200)
  })

  it('routes PayPal webhooks through the Worker and returns validation failures', async () => {
    const { env, pp } = await setup()
    const response = await call(env, '/webhooks/paypal', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(400)
    expect(pp.calls).toHaveLength(0)
  })

  it('treats malformed action JSON as an empty settings object', async () => {
    const { env, kv } = await setup()
    const response = await worker.fetch(new Request('https://job-done.test/api/settings', {
      method: 'POST',
      headers: { cookie: 'jd_ws=w1', 'cf-connecting-ip': '203.0.113.1' },
      body: '{broken',
    }), env, ctx)
    expect(response.status).toBe(200)
    expect((await saved(kv)).settings.holdMinutes).toBe(2)
  })

  it('returns a server error when a live agent model fails with a non budget error', async () => {
    const { env } = await setup({ env: { LEDGER: d1Ledger(), AI: { run: async () => { throw new Error('model failed') } } } })
    const response = await call(env, '/api/agent', { method: 'POST', body: { text: 'Hello there' } })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'server' })
  })

  it('seeds a shared late invoice after the initial demo invoice fails', async () => {
    const { env, kv } = await setup({ workspace: false, script: {
      'GET /v2/invoicing/invoices/INV2-LATE': [{ status: 200, body: { id: 'INV2-LATE', status: 'SENT', amount: { value: '340.00' }, due_amount: { value: '340.00' } } }],
    } })
    await kv.put('seed:late-invoice', 'INV2-LATE')
    const response = await call(env, '/api/workspace', { method: 'POST', body: {} })
    expect(response.status).toBe(200)
    expect((await response.json()).ws.invoices['INV2-LATE']).toMatchObject({ shared: true, status: 'SENT', total: '340.00' })
  })
})

describe('the Send tap carries the draft card’s payment choices', () => {
  it('a tip and a part payment ticked on the card reach PayPal’s create call', async () => {
    const s = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: { 'POST /v2/invoicing/invoices': [{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1' } }] } })
    const ws = await saved(s.kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: 0, total: '282.42', itemTotal: '282.42', tax: '0.00', lines: [{ name: 'Repair', quantity: '1', unitAmount: '282.42', amount: '282.42', uom: 'AMOUNT' }] } }
    await s.kv.put('ws:w1', JSON.stringify(ws))
    await call(s.env, '/api/drafts/d1/send', { method: 'POST', body: { tip: true, part: true } })
    const created = JSON.parse(s.pp.calls.find((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices').body)
    expect(created.configuration).toEqual({ allow_tip: true, partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '50.00' } } })
  })

  it('a Send with no choices asks for no tip and no part payment', async () => {
    const s = await setup({ env: { PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' }, script: { 'POST /v2/invoicing/invoices': [{ status: 422, body: {} }] } })
    const ws = await saved(s.kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: 0, total: '282.42', itemTotal: '282.42', tax: '0.00', lines: [{ name: 'Repair', quantity: '1', unitAmount: '282.42', amount: '282.42', uom: 'AMOUNT' }] } }
    await s.kv.put('ws:w1', JSON.stringify(ws))
    await call(s.env, '/api/drafts/d1/send', { method: 'POST' })
    const created = JSON.parse(s.pp.calls.find((c) => c.method === 'POST' && c.path === '/v2/invoicing/invoices').body)
    expect(created.configuration).toEqual({ allow_tip: false })
  })
})

describe('PayPal reminders in the Worker', () => {
  const plan = { PAYPAL_REMINDER_EVERY_DAYS: '3', PAYPAL_REMINDER_TIMES: '3', PAYPAL_REMINDERS_SINCE: '2026-10-28T21:00:00Z' }

  it('the page state carries the reminder plan, and the stop route cancels one invoice’s reminders', async () => {
    const s = await setup({ env: plan, script: { 'POST /v2/invoicing/invoices/INV2-SAM/cancel-reminders': [{ status: 204 }] } })
    const ws = await saved(s.kv)
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', reminders: 0, sentAt: Date.now() }
    await s.kv.put('ws:w1', JSON.stringify(ws))
    const state = await (await call(s.env, '/api/state')).json()
    expect(state.reminders).toEqual({ everyDays: 3, times: 3, since: '2026-10-28T21:00:00Z' })
    const stopped = await call(s.env, '/api/invoices/INV2-SAM/stop-reminders', { method: 'POST' })
    expect(stopped.status).toBe(200)
    expect((await saved(s.kv)).invoices['INV2-SAM'].remindersStopped).toBe(true)
  })

  it('with no plan set, the state says so', async () => {
    const s = await setup()
    expect((await (await call(s.env, '/api/state')).json()).reminders).toBeNull()
  })
})

describe('the rate card that learns, in the Worker', () => {
  it('a tapped rate change sets the card and prices the open draft again', async () => {
    const s = await setup()
    const ws = await saved(s.kv)
    ws.drafts.d1 = { id: 'd1', kind: 'invoice', customerId: 'c1', priced: { currency: 'USD', taxPercent: '8', total: '48.60', itemTotal: '45.00', tax: '3.60', lines: [{ id: 'p1', kind: 'callout', name: 'Call out', quantity: '1', unitAmount: '45.00', uom: 'AMOUNT', amount: '45.00', tax: '3.60', source: 'rate card' }] } }
    ws.rateOffers = { r1: { id: 'r1', field: 'callout', label: 'Call out', from: '45.00', value: '60.00', said: '60', on: '28 Oct', draftId: 'd1' } }
    await s.kv.put('ws:w1', JSON.stringify(ws))
    const res = await call(s.env, '/api/rates/r1/accept', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.priced.total).toBe('64.80')
    expect(body.state.ws.settings.rateCard).toMatchObject({ callout: '60.00', learned: { callout: { said: '60', on: '28 Oct' } } })
    expect((await saved(s.kv)).drafts.d1.priced.lines[0].source).toBe('you said 60 on 28 Oct')
  })

  it('an offer the workspace never made is refused', async () => {
    const s = await setup()
    const res = await call(s.env, '/api/rates/r404/accept', { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await saved(s.kv)).settings.rateCard.callout).toBe('45.00')
  })
})
