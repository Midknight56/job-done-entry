import { describe, it, expect, afterEach, vi } from 'vitest'
import worker from '../../src/worker.js'
import { DAILY_WORKSPACES } from '../../src/caps.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'

const ctx = { waitUntil: () => {} }
const day = () => new Date().toISOString().slice(0, 10)
const create = (env, host, cookie) => worker.fetch(new Request(`http://${host}/api/workspace`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.4', ...(cookie ? { cookie } : {}) },
  body: '{}',
}), env, ctx)

afterEach(() => vi.unstubAllGlobals())

describe('new demos in a local test run', () => {
  it('a local test run with the stand in model never meets the new demos a day cap', async () => {
    vi.stubGlobal('fetch', fakePayPal({}).fetch)
    const env = { JOBDONE: memoryKV(), MODEL_STUB: '1', PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }
    await env.JOBDONE.put(`cap:day:${day()}:run1:new`, JSON.stringify({ demos: DAILY_WORKSPACES }))
    expect((await create(env, '127.0.0.1', 'jd_test=run1')).status).toBe(200)
  })

  it('the hosted app keeps the cap, even with a test cookie', async () => {
    vi.stubGlobal('fetch', fakePayPal({}).fetch)
    const env = { JOBDONE: memoryKV(), MODEL_STUB: '1', PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' }
    await env.JOBDONE.put(`cap:day:${day()}`, JSON.stringify({ demos: DAILY_WORKSPACES }))
    expect((await create(env, 'job-done.midknight-labs.workers.dev', 'jd_test=run1')).status).toBe(429)
  })
})
