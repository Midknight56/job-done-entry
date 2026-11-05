import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker from '../../src/worker.js'
import { ACCOUNT_NEURONS, DAILY_ACTIONS, DAILY_NEURONS, PER_IP_ACTIONS, PER_IP_INVOICES } from '../../src/caps.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const ctx = { waitUntil: () => {} }
const day = () => new Date().toISOString().slice(0, 10)

/** A valid 16 kHz mono 16 bit PCM WAV of the given length (silence). */
function wav(seconds) {
  const rate = 16000
  const dataBytes = Math.round(seconds * rate * 2)
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const put = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  put(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE')
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  put(36, 'data'); v.setUint32(40, dataBytes, true)
  return new Uint8Array(buf)
}

async function setup(extra = {}) {
  const kv = memoryKV()
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', IP_SALT: 'salt', ...extra }
  vi.stubGlobal('fetch', fakePayPal({}).fetch)
  const res = await worker.fetch(new Request('https://job-done.test/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.2' }, body: '{}' }), env, ctx)
  const ws = res.headers.get('set-cookie').split(';')[0]
  return { env, kv, ws }
}

async function action(env, ws, maintainer) {
  const headers = { cookie: ws, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.2' }
  if (maintainer !== undefined) headers.cookie += `; jd_maint=${maintainer}`
  return worker.fetch(new Request('https://job-done.test/api/settings', { method: 'POST', headers, body: '{}' }), env, ctx)
}

function memoryD1(rows = []) {
  let nextId = rows.length + 1
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this },
        async first() {
          if (sql.includes('RETURNING id')) {
            const [app, day, neurons] = this.args
            const id = nextId++
            rows.push({ id, app, day, neurons })
            return { id }
          }
          const [day, app] = this.args
          return { total: rows.filter((r) => r.day === day && (app === undefined || r.app === app)).reduce((sum, r) => sum + r.neurons, 0) }
        },
        async run() {
          const [app, day, neurons] = this.args
          rows.push({ app, day, neurons })
          return { success: true }
        },
      }
    },
  }
}

async function voice(env, ws, maintainer) {
  const headers = { cookie: `${ws}; jd_maint=${maintainer}`, 'content-type': 'audio/wav', 'cf-connecting-ip': '198.51.100.2' }
  return worker.fetch(new Request('https://job-done.test/api/voice', { method: 'POST', headers, body: wav(30) }), env, ctx)
}

beforeEach(() => {})
afterEach(() => vi.unstubAllGlobals())

describe('maintainer limits', () => {
  it('lets an authenticated maintainer past the visitor action cap only', async () => {
    const { env, kv, ws } = await setup({ MAINTAINER_TOKEN: 'm'.repeat(32) })
    const ipKey = 'cap:ip:'
    const key = [...kv.keys()].find((k) => k.startsWith(ipKey))
    const counts = JSON.parse(await kv.get(key))
    counts.actions = PER_IP_ACTIONS
    await kv.put(key, JSON.stringify(counts))
    expect((await action(env, ws)).status).toBe(429)
    expect((await action(env, ws, 'wrong')).status).toBe(429)
    expect((await action(env, ws, 'm'.repeat(32))).status).toBe(200)
  })

  it('ignores the cookie without a configured token and still enforces the daily action cap', async () => {
    const { env, kv, ws } = await setup()
    const key = [...kv.keys()].find((k) => k.startsWith('cap:ip:'))
    const counts = JSON.parse(await kv.get(key))
    counts.actions = PER_IP_ACTIONS
    await kv.put(key, JSON.stringify(counts))
    expect((await action(env, ws, 'm'.repeat(32))).status).toBe(429)
    const dailyKey = `cap:day:${day()}`
    await kv.put(dailyKey, JSON.stringify({ actions: DAILY_ACTIONS }))
    expect((await action({ ...env, MAINTAINER_TOKEN: 'm'.repeat(32) }, ws, 'm'.repeat(32))).status).toBe(429)
  })

  it('applies EXTRA_NEURONS for today to the app ledger, but ignores it for another date', async () => {
    const today = day()
    const rows = [{ app: 'job-done', day: today, neurons: DAILY_NEURONS }]
    const ledger = memoryD1(rows)
    const { env, ws } = await setup({ MAINTAINER_TOKEN: 'm'.repeat(32), LEDGER: ledger, AI: { run: async () => ({ text: 'ok' }) }, EXTRA_NEURONS: `${today}:30` })
    const accepted = await voice(env, ws, 'm'.repeat(32))
    expect(accepted.status).toBe(200)
    expect(rows.filter((r) => r.day === today && r.app === 'job-done').reduce((n, r) => n + r.neurons, 0)).toBeGreaterThan(DAILY_NEURONS)
    expect(rows.filter((r) => r.day === today && r.app === 'job-done').reduce((n, r) => n + r.neurons, 0)).toBeLessThanOrEqual(DAILY_NEURONS + 30)

    const otherLedger = memoryD1([{ app: 'job-done', day: today, neurons: DAILY_NEURONS }])
    const other = await setup({ MAINTAINER_TOKEN: 'm'.repeat(32), LEDGER: otherLedger, AI: { run: async () => ({ text: 'ok' }) }, EXTRA_NEURONS: `2020-01-01:30` })
    expect((await voice(other.env, other.ws, 'm'.repeat(32))).status).toBe(429)
  })

  it('lets a maintainer send a draft after the visitor invoice cap', async () => {
    const { env, kv, ws } = await setup({ MAINTAINER_TOKEN: 'm'.repeat(32), PAYPAL_BUYER_EMAIL: 'buyer@sandbox.test' })
    const ipKey = [...kv.keys()].find((k) => k.startsWith('cap:ip:'))
    const counts = JSON.parse(await kv.get(ipKey))
    counts.invoices = PER_IP_INVOICES
    await kv.put(ipKey, JSON.stringify(counts))
    const wid = ws.match(/^jd_ws=([^;]+)/)[1]
    const workspace = JSON.parse(await kv.get(`ws:${wid}`))
    workspace.drafts.d1 = { id: 'd1', customerId: 'c1', kind: 'invoice', summary: 'Repair', priced: { currency: 'USD', taxPercent: 0, total: '10.00', lines: [{ name: 'Repair', quantity: '1', unitAmount: '10.00', uom: 'HOUR' }] } }
    await kv.put(`ws:${wid}`, JSON.stringify(workspace))
    vi.stubGlobal('fetch', fakePayPal({
      'POST /v2/invoicing/invoices': [{ status: 201, body: { href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-R1' } }],
      'POST /v2/invoicing/invoices/INV2-R1/send': [{ status: 200, body: {} }],
      'POST /v2/invoicing/invoices/INV2-R1/generate-qr-code': [{ status: 200, body: 'iVBORw0KGgo=' }],
      'GET /v2/invoicing/invoices/INV2-R1': [{ status: 200, body: { id: 'INV2-R1', status: 'SENT', amount: { value: '10.00', currency_code: 'USD' }, due_amount: { value: '10.00', currency_code: 'USD' } } }],
    }).fetch)
    const response = await worker.fetch(new Request('https://job-done.test/api/drafts/d1/send', { method: 'POST', headers: { cookie: `${ws}; jd_maint=${'m'.repeat(32)}`, 'cf-connecting-ip': '198.51.100.2' } }), env, ctx)
    expect(response.status).toBe(200)
  })

  it('still enforces ACCOUNT_NEURONS for a maintainer', async () => {
    const today = day()
    const ledger = memoryD1([{ app: 'other-app', day: today, neurons: ACCOUNT_NEURONS }])
    const { env, ws } = await setup({ MAINTAINER_TOKEN: 'm'.repeat(32), LEDGER: ledger, AI: { run: async () => ({ text: 'should not run' }) }, EXTRA_NEURONS: `${today}:100` })
    expect((await voice(env, ws, 'm'.repeat(32))).status).toBe(429)
  })
})
