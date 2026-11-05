// @ts-check
// Replay mode. When today's free AI budget is used up, the scripted demo lines are answered from model output that
// was recorded from real live runs (samples/replay.json). The page labels it. The replayed output still passes the
// guard, and every PayPal call stays live.

import samples from '../../samples/replay.json'

/** @param {string} text */
export function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The scripted lines a visitor can try in replay mode. */
export function replayLines() {
  return Array.isArray(samples.lines) ? samples.lines.filter((line) => typeof line === 'string') : []
}

/**
 * The recorded turn for a line, matched exactly after normalize() (case, spaces and punctuation). Never a near match:
 * "Sam paid cash, 108" is one word from Dave's recorded line and would pass the guard, because 108 was said.
 * @param {string} text @param {Record<string, any>} turns
 */
export function matchReplayTurn(text, turns) {
  const key = normalize(text)
  return Object.hasOwn(turns, key) ? turns[key] : null
}

/**
 * A model stand in that answers from the recording for this line, or null when the line was never recorded.
 * @param {string} text
 */
export function replayModel(text) {
  const turns = samples.turns && typeof samples.turns === 'object' && !Array.isArray(samples.turns) ? /** @type {Record<string, any>} */ (samples.turns) : {}
  const turn = matchReplayTurn(text, turns)
  if (!turn || !Array.isArray(turn.outputs) || !turn.outputs.every((output) => typeof output === 'string') || !turn.outputs.length) return null
  const outputs = [...turn.outputs]
  return async (/** @type {Array<{ content: string }>} */ messages) => ({ text: remapInvoices(outputs.shift() || '', messages), neurons: 0 })
}

/**
 * A recording names the invoices of the demo it was made in. Each recorded invoice id is replaced by the open invoice
 * of the customer this turn's tools found, so the replayed proposal points at this demo's own invoice.
 * @param {string} text @param {Array<{ content: string }>} messages
 */
export function remapInvoices(text, messages) {
  const ids = [...new Set(text.match(/INV2(?:-[A-Z0-9]{4}){4}/g) || [])]
  const last = String(messages?.at(-1)?.content || '')
  if (!ids.length || !last.startsWith('Tool results:')) return text
  let results
  try {
    results = JSON.parse(last.slice(last.indexOf('['), last.lastIndexOf(']') + 1))
  } catch {
    return text
  }
  const safeResults = Array.isArray(results) ? results.filter((r) => r && typeof r === 'object' && r.result && typeof r.result === 'object') : []
  if (!safeResults.some((r) => r.tool === 'open_invoices')) return text
  const customers = safeResults.filter((r) => r.tool === 'find_customer').flatMap((r) => Array.isArray(r.result.matches) ? r.result.matches : []).map((m) => m?.id).filter(Boolean)
  const open = safeResults.filter((r) => r.tool === 'open_invoices').flatMap((r) => Array.isArray(r.result.invoices) ? r.result.invoices : []).filter((invoice) => typeof invoice?.invoice_id === 'string')
  const mine = open.filter((i) => customers.length === 0 || customers.includes(i.customer_id))
  return ids.reduce((out, id, n) => out.split(id).join(mine[n]?.invoice_id || '__unavailable_invoice__'), text)
}
