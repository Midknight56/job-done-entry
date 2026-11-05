import { describe, it, expect, afterEach, vi } from 'vitest'
import worker from '../../src/worker.js'
import { PER_IP_NEURONS } from '../../src/caps.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const ctx = { waitUntil: () => {} }
const IP = '198.51.100.9'

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

function memoryD1() {
  const rows = []
  let nextId = 1
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
          return { success: true, meta: { changes: 1 } }
        },
      }
    },
  }
}

const newDemo = async (env) => {
  const res = await worker.fetch(new Request('https://job-done.test/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP }, body: '{}' }), env, ctx)
  return res.headers.get('set-cookie').split(';')[0]
}
const speak = (env, cookie) => worker.fetch(new Request('https://job-done.test/api/voice', { method: 'POST', headers: { cookie, 'content-type': 'audio/wav', 'cf-connecting-ip': IP }, body: wav(2) }), env, ctx)

afterEach(() => vi.unstubAllGlobals())

describe('the per visitor AI share follows the address, not only the demo', () => {
  it('a visitor who spent their share cannot get more by starting a second demo', async () => {
    vi.stubGlobal('fetch', fakePayPal({}).fetch)
    let aiCalls = 0
    const env = { JOBDONE: memoryKV(), LEDGER: memoryD1(), AI: { run: async () => { aiCalls++; return { text: 'hello' } } }, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', IP_SALT: 'salt' }
    const first = await newDemo(env)
    expect((await speak(env, first)).status).toBe(200)
    expect(aiCalls).toBe(1)
    // Fill this address's share to the cap.
    const key = [...env.JOBDONE.keys()].find((k) => k.startsWith('cap:ip:'))
    const counts = JSON.parse(await env.JOBDONE.get(key))
    counts.neurons = PER_IP_NEURONS
    await env.JOBDONE.put(key, JSON.stringify(counts))
    const second = await newDemo(env)
    const refused = await speak(env, second)
    expect(refused.status).not.toBe(200)
    expect(aiCalls).toBe(1)
  })
})
