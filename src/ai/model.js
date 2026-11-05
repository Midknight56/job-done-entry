// @ts-check

import { actualNeurons, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, stepWorstCase, REQUEST_SUFFIX } from '../caps.js'

export const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'

export class BudgetError extends Error {
  /** @param {'account'|'day'|'ip'|'ledger'} reason */
  constructor(reason) { super(`AI budget exceeded: ${reason}`); this.name = 'BudgetError'; this.code = 'BUDGET'; this.reason = reason }
}

export class TooLongError extends Error {
  constructor() { super('Input is too long'); this.name = 'TooLongError'; this.code = 'TOO_LONG' }
}

/** @param {unknown} raw */
export function cleanReply(raw) {
  if (raw !== null && typeof raw === 'object') return JSON.stringify(raw)
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const strayClose = text.indexOf('</think>')
  if (strayClose >= 0) text = text.slice(strayClose + '</think>'.length)
  return text.trim()
}

/** @param {{ai: {run: (model: string, input: any) => Promise<any>}, budget: {charge: (input: {ipKey: string, day: string, neurons: number}) => Promise<{ok: true, id?: number}|{ok: false, reason: 'account'|'day'|'ip'|'ledger'}>, settle?: (input: {id: number, neurons: number}) => Promise<void>}, ipKey: string, day: string, messages: {role: string, content: string}[], maxTokens?: number, temperature?: number}} options */
export async function runModel({ ai, budget, ipKey, day, messages, maxTokens = MAX_OUTPUT_TOKENS, temperature = 0.2 }) {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
  if (chars > MAX_INPUT_CHARS) throw new TooLongError()
  if (!messages.every(message => ['system', 'user', 'assistant'].includes(message.role)) || !Number.isFinite(maxTokens) || maxTokens <= 0) throw new TooLongError()
  const neurons = stepWorstCase(chars, maxTokens, messages.length)
  const charged = await budget.charge({ ipKey, day, neurons })
  if (charged.ok === false) throw new BudgetError(charged.reason)
  const modelMessages = messages.map((message) => ({ ...message }))
  for (let i = modelMessages.length - 1; i >= 0; i--) {
    if (modelMessages[i].role === 'user') { modelMessages[i].content += REQUEST_SUFFIX; break }
  }
  const out = await ai.run(MODEL, { messages: modelMessages, max_tokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS), temperature })
  const actual = actualNeurons(out.usage)
  if (charged.id !== undefined && actual !== null && budget.settle) {
    try { await budget.settle({ id: charged.id, neurons: actual * 1.1 }) }
    catch { if (actual * 1.1 > neurons) throw new BudgetError('ledger') }
  }
  return { text: cleanReply(out.response), neurons, actual, usage: out.usage || null }
}
