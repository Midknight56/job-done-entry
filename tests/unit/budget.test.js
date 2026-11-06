import { describe, it, expect } from 'vitest'
import { DAILY_NEURONS, PER_IP_NEURONS, ACCOUNT_NEURONS, MAX_OUTPUT_TOKENS, MAX_INPUT_CHARS, CHARS_PER_TOKEN_RESERVE, CHAT_MESSAGE_TOKENS, CHAT_REPLY_TOKENS, stepWorstCase, audioWorstCase, actualNeurons } from '../../src/caps.js'
import { createBudget, memoryLedger, memoryCounter, d1Ledger } from '../../src/ai/budget.js'
import { runModel } from '../../src/ai/model.js'

const DAY = '2026-10-26'

describe('the reservation arithmetic', () => {
  it('reserves 11.592408 neurons for a full input step and at most 23.32 for a 30 s clip', () => {
    expect(stepWorstCase(MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS)).toBeCloseTo(11.592408, 6)
    expect(audioWorstCase(30)).toBeCloseTo(23.32, 1)
  })

  it.each([[3536, 500, 6], [3537, 54, 2], [0, 9999, 1]])('reserves characters, formatting and capped output: %s / %s / %s', (chars, maxTokens, messages) => {
    expect(CHARS_PER_TOKEN_RESERVE).toBe(2.5)
    expect(CHAT_MESSAGE_TOKENS).toBe(32)
    expect(CHAT_REPLY_TOKENS).toBe(32)
    const tokens = Math.ceil(chars / 2.5) + messages * 32 + 32
    expect(stepWorstCase(chars, maxTokens, messages)).toBeCloseTo(tokens * 1542 / 1e6 + Math.min(maxTokens, 500) * 10158 / 1e6, 8)
  })

  it('the caps keep the app inside its share and the share inside the free day', () => {
    // The five apps' shares on the account (read from each app's code, 24 Oct 2026), with this app's own constant.
    const shares = { 'gift-scout': 2000, 'running-tab': 1500, 'job-done': DAILY_NEURONS, circlekeeper: 700, 'dispute-desk': 700 }
    expect(DAILY_NEURONS).toBeLessThanOrEqual(2000)
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(ACCOUNT_NEURONS)
    expect(PER_IP_NEURONS).toBeLessThan(DAILY_NEURONS)
    expect(ACCOUNT_NEURONS).toBeLessThan(10000)
  })
})

describe('the budget', () => {
  it('charges the reservation BEFORE the call, so the ledger holds it even if the call fails', async () => {
    const ledger = memoryLedger()
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    const r = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 26.8 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.id).toBeDefined()
    expect(await ledger.dayTotal(DAY, 'job-done')).toBeCloseTo(26.8)
  })

  it('settles a successful charge to real usage with a ten percent margin while keeping the visitor counter reserved', async () => {
    const ledger = memoryLedger()
    const perIp = memoryCounter()
    const budget = createBudget({ ledger, perIp, app: 'job-done' })
    const reserved = 30
    const charged = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: reserved })
    expect(charged.ok).toBe(true)
    if (!charged.ok) return
    const actual = actualNeurons({ prompt_tokens: 1168, completion_tokens: 54 })
    expect(actual).not.toBeNull()
    await budget.settle({ id: charged.id, neurons: actual * 1.1 })
    expect(await ledger.dayTotal(DAY, 'job-done')).toBeCloseTo(actual * 1.1)
    expect(await perIp.get(`ipA:${DAY}`)).toBe(reserved)
  })

  it('retains usage above its reservation', async () => {
    const ledger = memoryLedger()
    const perIp = memoryCounter()
    const budget = createBudget({ ledger, perIp, app: 'job-done' })
    const charged = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 12 })
    if (!charged.ok) return
    await budget.settle({ id: charged.id, neurons: 20 })
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(20)
    expect(await perIp.get(`ipA:${DAY}`)).toBe(20)
  })

  it('ignores invalid settlement amounts', async () => {
    const ledger = memoryLedger()
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    const charged = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 12 })
    if (!charged.ok) return
    await budget.settle({ id: charged.id, neurons: NaN })
    await budget.settle({ id: charged.id, neurons: -1 })
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(12)
  })

  it('D1 settlement sends one atomic update with the row id', async () => {
    const calls = []
    const db = { prepare: (sql) => ({ bind: (...args) => ({ run: async () => (calls.push({ sql, args }), { meta: { changes: 1 } }) }) }) }
    await d1Ledger(db).settle(42, 7.5)
    expect(calls).toEqual([{ sql: 'UPDATE ai_calls SET neurons = ?2 WHERE id = ?1', args: [42, 7.5] }])
  })
  it('refuses at DAILY_NEURONS for the app', async () => {
    const ledger = memoryLedger()
    await ledger.add(DAY, 'job-done', DAILY_NEURONS - 10)
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    const r = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 26.8 })
    expect(r).toEqual({ ok: false, reason: 'day' })
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(DAILY_NEURONS - 10)
  })

  it('refuses at ACCOUNT_NEURONS when other apps used the shared day', async () => {
    const ledger = memoryLedger()
    await ledger.add(DAY, 'another-app', ACCOUNT_NEURONS - 5)
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    expect(await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 26.8 })).toEqual({ ok: false, reason: 'account' })
  })

  it('refuses at PER_IP_NEURONS for one visitor while another visitor still gets through', async () => {
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
    let last
    for (let i = 0; i < 100; i++) {
      last = await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 26.8 })
      if (!last.ok) break
    }
    expect(last).toEqual({ ok: false, reason: 'ip' })
    expect((await budget.charge({ ipKey: 'ipB', day: DAY, neurons: 26.8 })).ok).toBe(true)
  })

  it('reports what is left for the page', async () => {
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })
    await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 50 })
    const left = await budget.left({ ipKey: 'ipA', day: DAY })
    expect(left.app).toBeCloseTo(DAILY_NEURONS - 50)
    expect(left.ip).toBeCloseTo(PER_IP_NEURONS - 50)
  })

  it('honours optional daily and visitor limits for charges and remaining budget', async () => {
    const budget = createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done', dailyLimit: 80, ipLimit: 30 })
    expect((await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 25 })).ok).toBe(true)
    expect(await budget.left({ ipKey: 'ipA', day: DAY })).toEqual({ app: 55, ip: 5, account: ACCOUNT_NEURONS - 25 })
    expect(await budget.charge({ ipKey: 'ipA', day: DAY, neurons: 6 })).toEqual({ ok: false, reason: 'ip' })
    expect(await budget.charge({ ipKey: 'ipB', day: DAY, neurons: 56 })).toEqual({ ok: false, reason: 'day' })
  })
})

describe('measured token allowance', () => {
  it('covers 1,168 input tokens and 54 output tokens for 3,536 characters', () => {
    expect(stepWorstCase(3536, 54)).toBeGreaterThanOrEqual(actualNeurons({ prompt_tokens: 1168, completion_tokens: 54 }))
  })
})

describe('the model call', () => {
  const budgetOk = () => createBudget({ ledger: memoryLedger(), perIp: memoryCounter(), app: 'job-done' })

  it('cleans a think block and returns text', async () => {
    const ai = { run: async () => ({ response: '<think>hmm</think>{"final":{"kind":"answer","text":"ok"}}' }) }
    const out = await runModel({ ai, budget: budgetOk(), ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })
    expect(out.text).toBe('{"final":{"kind":"answer","text":"ok"}}')
    expect(out.neurons).toBeGreaterThan(0)
  })

  it('keeps the reserved charge when usage is missing or invalid', async () => {
    for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 2 }]) {
      const ledger = memoryLedger()
      const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
      const out = await runModel({ ai: { run: async () => ({ response: 'ok', usage }) }, budget, ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })
      expect(out.actual).toBeNull()
      expect(await ledger.dayTotal(DAY, 'job-done')).toBe(out.neurons)
    }
  })

  it('continues when settling throws and leaves the reservation in place', async () => {
    const ledger = memoryLedger()
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    budget.settle = async () => { throw new Error('D1 unavailable') }
    const out = await runModel({ ai: { run: async () => ({ response: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }) }, budget, ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })
    expect(out.text).toBe('ok')
    expect(await ledger.dayTotal(DAY, 'job-done')).toBe(out.neurons)
  })

  it('turns a reply that came back as an object into JSON text', async () => {
    const ai = { run: async () => ({ response: { final: { kind: 'answer', text: 'ok' } } }) }
    const out = await runModel({ ai, budget: budgetOk(), ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })
    expect(JSON.parse(out.text)).toEqual({ final: { kind: 'answer', text: 'ok' } })
  })

  it('does not call the model when the budget refuses', async () => {
    let called = 0
    const ai = { run: async () => { called++; return { response: '{}' } } }
    const ledger = memoryLedger()
    await ledger.add(DAY, 'job-done', DAILY_NEURONS)
    const budget = createBudget({ ledger, perIp: memoryCounter(), app: 'job-done' })
    await expect(runModel({ ai, budget, ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'BUDGET', reason: 'day' })
    expect(called).toBe(0)
  })

  it('sends max_tokens no higher than MAX_OUTPUT_TOKENS and refuses input over MAX_INPUT_CHARS', async () => {
    let seen
    const ai = { run: async (_m, input) => { seen = input; return { response: '{}' } } }
    await runModel({ ai, budget: budgetOk(), ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'hi' }], maxTokens: 9999 })
    expect(seen.max_tokens).toBe(MAX_OUTPUT_TOKENS)
    await expect(runModel({ ai, budget: budgetOk(), ipKey: 'ipA', day: DAY, messages: [{ role: 'user', content: 'x'.repeat(MAX_INPUT_CHARS + 1) }] })).rejects.toMatchObject({ code: 'TOO_LONG' })
  })
})
