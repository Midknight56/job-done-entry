import { expect, it, vi, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createBudget, memoryLedger, memoryCounter, d1Ledger } from '../../src/ai/budget.js'
import { runModel } from '../../src/ai/model.js'
import { stepWorstCase, actualNeurons, DAILY_NEURONS, PER_IP_NEURONS, ACCOUNT_NEURONS } from '../../src/caps.js'
import worker from '../../src/worker.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { CapsDO } from '../../src/state/caps-do.js'
import { memoryKV } from './memory-kv.js'

const day = '2026-11-05'
afterEach(() => vi.restoreAllMocks())

it('allows six full 12-call demo runs of typical requests and refuses the seventh at its first call', async () => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const ai = { run: vi.fn(async () => ({ response: '{}' })) }
  const messages = ['system', 'user', 'assistant', 'user', 'assistant', 'user']
    .map((role, index) => ({ role, content: 'x'.repeat(index < 5 ? 590 : 586) }))

  expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBe(3536)
  for (let run = 0; run < 6; run++) {
    for (let call = 0; call < 12; call++) {
      await runModel({ ai, budget, ipKey: 'visitor', day, messages, maxTokens: 500 })
    }
  }

  let refusedAt = -1
  for (let call = 0; call < 12; call++) {
    try { await runModel({ ai, budget, ipKey: 'visitor', day, messages, maxTokens: 500 }) }
    catch (error) {
      expect(error).toMatchObject({ code: 'BUDGET', reason: 'ip' })
      refusedAt = call
      break
    }
  }
  expect(refusedAt).toBe(0)
  expect(ai.run).toHaveBeenCalledTimes(72)
  expect(await perIp.get(`${'visitor'}:${day}`)).toBeCloseTo(547.656336, 6)
})

it('reserves JavaScript string lengths and sends the user message unchanged', async () => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: '漢😀'.repeat(1000) }]
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
  const expected = (Math.ceil(chars / 2.5) + 2 * 32 + 32) * 1542 / 1e6 + 500 * 10158 / 1e6
  const ai = { run: vi.fn(async (_id, input) => {
    expect(await ledger.dayTotal(day)).toBeCloseTo(expected, 8)
    expect(await perIp.get(`ip:${day}`)).toBeCloseTo(expected, 8)
    expect(input.messages[1].content).toBe(messages[1].content)
    return { response: '{}' }
  }) }
  await runModel({ ai, budget, ipKey: 'ip', day, messages })
  expect(ai.run).toHaveBeenCalledTimes(1)
})

it.each(['app', 'ip', 'account'])('R6 item 2 records excess on every counter and refuses the next call at %s cap', async cap => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const target = cap === 'app' ? DAILY_NEURONS : cap === 'ip' ? PER_IP_NEURONS : ACCOUNT_NEURONS
  if (cap === 'account') await ledger.add(day, 'other', ACCOUNT_NEURONS - 100)
  const actual = cap === 'account' ? 100 : target
  const charged = await budget.charge({ ipKey: 'ip', day, neurons: 5 })
  expect(charged.ok).toBe(true)
  await budget.settle({ id: charged.id, neurons: actual })
  expect(await ledger.dayTotal(day, 'job-done')).toBe(actual)
  expect(await perIp.get(`ip:${day}`)).toBe(actual)
  expect((await budget.charge({ ipKey: 'ip', day, neurons: 1 })).ok).toBe(false)
})

it('R6 item 2 keeps a reported overage and serializes repeated settlements', async () => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const charged = await budget.charge({ ipKey: 'ip', day, neurons: 5 })
  const actual = actualNeurons({ prompt_tokens: 3000, completion_tokens: 500 })
  expect(actual).toBeCloseTo(9.705, 8)
  await Promise.all([budget.settle({ id: charged.id, neurons: actual }), budget.settle({ id: charged.id, neurons: actual })])
  expect(await ledger.dayTotal(day)).toBe(actual)
  expect(await perIp.get(`ip:${day}`)).toBe(actual)
})

it('R6 item 2 production SQL records an upward correction', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('schema/ai_calls.sql', 'utf8'))
  const db = { prepare: sql => ({ bind: (...args) => ({
    first: async () => sqlite.prepare(sql).get(...args),
    run: async () => sqlite.prepare(sql).run(...args),
  }) }) }
  try {
    const ledger = d1Ledger(db)
    const id = await ledger.add(day, 'job-done', 24.4875)
    await ledger.settle(id, 29.1125)
    expect(await ledger.dayTotal(day)).toBe(29.1125)
  } finally { sqlite.close() }
})

it('R6 item 2 keeps calls blocked if an overage cannot be settled', async () => {
  const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
  budget.settle = async () => { throw new Error('storage unavailable') }
  const ai = { run: vi.fn(async () => ({ response: '{}', usage: { prompt_tokens: 100000, completion_tokens: 500 } })) }
  const input = { ai, budget, ipKey: 'ip', day, messages: [{ role: 'user', content: 'hi' }] }
  await expect(runModel(input)).rejects.toMatchObject({ code: 'BUDGET', reason: 'ledger' })
  expect(ai.run).toHaveBeenCalledTimes(1)
})

it('R6 item 2 includes more formatting for more messages', () => {
  expect(stepWorstCase(6000, 500, 6)).toBeGreaterThan(stepWorstCase(6000, 500, 1))
  expect(stepWorstCase(6000, 500)).toBeCloseTo((2400 + 6 * 32 + 32) * 1542 / 1e6 + 500 * 10158 / 1e6, 8)
})

it('R6 item 2 records model-reported usage above the character reservation in the ledger and per IP counter', async () => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const usage = { prompt_tokens: 3000, completion_tokens: 500 }
  const ai = { run: async () => ({ response: '{}', usage }) }
  const out = await runModel({ ai, budget, ipKey: 'ip', day, messages: [{ role: 'user', content: 'x'.repeat(3536) }] })
  const settled = actualNeurons(usage) * 1.1
  expect(settled).toBeGreaterThan(out.neurons)
  expect(await ledger.dayTotal(day, 'job-done')).toBeCloseTo(settled, 8)
  expect(await perIp.get(`ip:${day}`)).toBeCloseTo(settled, 8)
})

it('R6 item 2 retains the shared usage correction even if a visitor counter write fails', async () => {
  const ledger = memoryLedger(), perIp = memoryCounter()
  const budget = createBudget({ ledger, perIp, app: 'job-done' })
  const charged = await budget.charge({ ipKey: 'ip', day, neurons: 10 })
  vi.spyOn(perIp, 'add').mockRejectedValueOnce(new Error('counter unavailable'))
  await expect(budget.settle({ id: charged.id, neurons: 30 })).rejects.toThrow('counter unavailable')
  expect(await ledger.dayTotal(day)).toBe(30)
  expect(await budget.charge({ ipKey: 'ip', day, neurons: 1 })).toEqual({ ok: false, reason: 'ledger' })
})

it('R6 item 2 persists excess to both shared counters and uses recorded fallback on the next request', async () => {
  const objects = new Map(), values = new Map()
  const CAPS = { idFromName: key => key, get(key) {
    if (!objects.has(key)) {
      const data = new Map()
      values.set(key, data)
      objects.set(key, new CapsDO({ storage: {
        get: async k => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)),
        getAlarm: async () => 1,
      } }, {}))
    }
    return objects.get(key)
  } }
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync('schema/ai_calls.sql', 'utf8'))
  const LEDGER = { prepare: sql => ({ bind: (...args) => ({ first: async () => sqlite.prepare(sql).get(...args), run: async () => sqlite.prepare(sql).run(...args) }) }) }
  const JOBDONE = memoryKV(), now = Date.now(), today = new Date(now).toISOString().slice(0, 10)
  await JOBDONE.put('ws:usage6', JSON.stringify(seedWorkspace({ id: 'usage6', now, tzOffsetMinutes: 0 })))
  const usage = { prompt_tokens: 400000, completion_tokens: 500 }
  const AI = { run: vi.fn(async () => ({ response: '{"final":{"kind":"answer","text":"Nothing is owed.","invoice_ids":[]}}', usage })) }
  const env = { JOBDONE, LEDGER, CAPS, AI }
  const request = () => worker.fetch(new Request('https://job-done.test/api/agent', { method: 'POST', headers: { cookie: 'jd_ws=usage6', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'What am I owed?' }) }), env, { waitUntil() {} })
  try {
    expect((await request()).status).toBe(200)
    const actual = actualNeurons(usage) * 1.1
    expect(await d1Ledger(LEDGER).dayTotal(today)).toBeCloseTo(actual)
    const ip = [...values].find(([key]) => key.startsWith('cap:ip:'))[1].get('values')
    const shared = values.get(`cap:day:${today}`).get('values')
    expect(ip.neurons).toBeCloseTo(actual)
    expect(shared[Object.keys(shared).find(key => key.endsWith(':neurons'))]).toBeCloseTo(actual)
    const result = await (await request()).json()
    expect(result.replay).toBe(true)
    expect(AI.run).toHaveBeenCalledTimes(1)
  } finally { sqlite.close() }
})
