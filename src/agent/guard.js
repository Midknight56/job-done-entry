// @ts-check
// The drop rule. Code, not the prompt, decides what reaches the screen:
// 1. every id in a final proposal must appear in a tool result from this turn;
// 2. every figure in any text must be a figure from this turn's tool results or from what was said, or its sentence
//    is removed;
// 3. a part cost must have been said, and labour hours must match the duration that was said;
// 4. cash may not be more than the invoice's due amount, and the amount must have been said;
// 5. a name with no customer match becomes "new customer, confirm details" and cannot be invoiced.
// Recipients (rule 6) are checked before any PayPal call, in src/paypal/invoices.js.

import { costWasSaid, cashAmountWasSaid, durationHours, durationNeedsClarification, numbersIn } from '../pricing/words.js'
import { toCents } from '../pricing/ratecard.js'
import { validFree } from '../state/waiting.js'

/**
 * @typedef {{ tool: string, result: any }} ToolResult
 * @typedef {{ results: ToolResult[], transcript: string, stepMinutes?: number }} TurnContext
 */

/** @param {ToolResult[]} results @param {string} tool */
function all(results, tool) {
  return results.filter((r) => r.tool === tool && r.result && !r.result.error).map((r) => r.result)
}

/** Every figure the tools returned or the tradesperson said, in cents. @param {TurnContext} ctx */
export function backedFigures(ctx) {
  const cents = new Set()
  const walk = (v) => {
    if (typeof v === 'number') cents.add(toCents(v))
    else if (typeof v === 'string') numbersIn(v).forEach((n) => cents.add(toCents(n)))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  ctx.results.forEach((r) => walk(r.result))
  numbersIn(ctx.transcript).forEach((n) => cents.add(toCents(n)))
  return cents
}

/**
 * The figures a sentence states. Small whole numbers (0 to 12) written without a currency sign or decimals are
 * counts and clock hours, not money, and are left alone.
 * @param {string} sentence
 */
function statedFigures(sentence) {
  const out = []
  const digits = /(\$\s?)?\b\d[\d,]*(\.\d+)?\b/g
  for (const m of sentence.matchAll(digits)) {
    const n = Number(m[0].replace(/[$,\s]/g, ''))
    if (!m[1] && !m[2] && Number.isInteger(n) && n <= 12) continue
    out.push(n)
  }
  for (const n of numbersIn(sentence.replace(/\$?\b\d[\d,]*(\.\d+)?\b/g, ' '))) if (n > 12) out.push(n)
  return out
}

/**
 * Removes every sentence that states a figure no tool returned and nobody said.
 * @param {string} text @param {TurnContext} ctx
 */
export function scrubText(text, ctx) {
  const backed = backedFigures(ctx)
  const kept = []
  const removed = []
  // Amounts are shown plain, in the rate card's currency. A model once wrote a pound sign on a dollar invoice
  // (recorded 23 Oct 2026), so every currency sign is taken out.
  const plain = String(text || '').replace(/[$Â£â‚¬Â¥â‚¹]\s?/g, '')
  for (const sentence of plain.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (statedFigures(sentence).every((n) => backed.has(toCents(n)))) kept.push(sentence)
    else removed.push(sentence)
  }
  return { text: kept.join(' '), removed }
}

const DROP = (reason) => ({ ok: /** @type {const} */ (false), reason })

/**
 * @param {any} final the model's final proposal
 * @param {TurnContext} ctx
 * @returns {{ ok: true, proposal: any, removed?: string[] } | { ok: false, reason: string }}
 */
export function checkFinal(final, ctx) {
  if (!final || typeof final !== 'object') return DROP('no proposal')
  if (['invoice', 'booking', 'waiting'].includes(final.kind) && durationNeedsClarification(ctx.transcript)) return DROP('say one visit length in hours and minutes')
  const customers = new Set(all(ctx.results, 'find_customer').flatMap((r) => (r.matches || []).map((m) => m.id)))
  const searched = all(ctx.results, 'find_customer').length > 0
  if (['invoice', 'booking', 'cash', 'reminder', 'waiting'].includes(final.kind) && customers.size > 1) return DROP('choose one customer by full name and address')
  /** @type {Map<string, any>} */
  const lines = new Map()
  all(ctx.results, 'price_lines').forEach((r) => (r.lines || []).forEach((l) => lines.set(l.id, l)))
  const slots = new Set(all(ctx.results, 'find_slots').flatMap((r) => (r.slots || []).map((s) => s.id)))
  /** @type {Map<string, any>} */
  const invoices = new Map()
  all(ctx.results, 'open_invoices').forEach((r) => (r.invoices || []).forEach((i) => invoices.set(i.invoice_id, i)))
  const step = ctx.stepMinutes || 15

  const newCustomer = () => ({ ok: /** @type {const} */ (true), proposal: { kind: 'new_customer', name: String(final.customer_name || '').slice(0, 60) || 'New customer' } })

  switch (final.kind) {
    case 'waiting': {
      if (!customers.has(final.customer_id)) return DROP('not backed by a tool result')
      if (durationHours(ctx.transcript, step) !== final.hours) return DROP('the waiting hours were not said')
      const free = final.free === undefined ? 'any' : final.free
      if (typeof final.summary !== 'string' || !final.summary.trim() || final.summary.length > 80 ||
        typeof final.hours !== 'number' || final.hours < 0.5 || final.hours > 8 || !Number.isInteger(final.hours * 2) || !validFree(free)) return DROP('invalid waiting details')
      const summary = scrubText(final.summary.trim(), ctx).text
      if (!summary) return DROP('invalid waiting details')
      return { ok: true, proposal: { kind: 'waiting', customer_id: final.customer_id, summary, hours: final.hours, free } }
    }
    case 'invoice': {
      if (!final.customer_id || final.customer_id === 'new') return searched ? newCustomer() : DROP('not backed by a tool result')
      if (!customers.has(final.customer_id)) return DROP('not backed by a tool result')
      const ids = Array.isArray(final.line_ids) ? final.line_ids : []
      if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((id) => lines.has(id))) return DROP('not backed by a tool result')
      for (const id of ids) {
        const l = lines.get(id)
        if (l.kind === 'part' && !costWasSaid(ctx.transcript, Number(l.cost ?? l.unitAmount), l.description || l.name)) return DROP(`the part cost ${l.unitAmount} was not said`)
        if (l.kind === 'labour' && durationHours(ctx.transcript, step) !== Number(l.quantity)) return DROP(`${l.quantity} hours were not said`)
      }
      const selected = ids.map((id) => lines.get(id))
      const labour = selected.filter((l) => l.kind === 'labour')
      const said = durationHours(ctx.transcript, step)
      if ((said !== null || labour.length) && labour.reduce((sum, l) => sum + Number(l.quantity), 0) !== said) return DROP('the total hours do not match what was said')
      if (labour.length) {
        const callouts = selected.filter((l) => l.kind === 'callout')
        if (callouts.length > 1) return DROP('include one callout for the visit')
        if (callouts.length === 0) {
          const callout = [...lines].find(([, line]) => line.kind === 'callout')
          if (!callout) return DROP('include one callout for the visit')
          ids.push(callout[0])
          selected.push(callout[1])
        }
      }
      const keys = selected.map((l) => l.kind === 'part' ? JSON.stringify([l.kind, l.description, l.cost ?? l.unitAmount]) : l.kind)
      if (new Set(keys).size !== keys.length) return DROP('a charge was repeated')
      const note = final.note ? scrubText(final.note, ctx).text : ''
      const summary = scrubText(String(final.summary || '').slice(0, 80), ctx).text
      return { ok: true, proposal: { kind: 'invoice', customer_id: final.customer_id, line_ids: ids, summary, note } }
    }
    case 'booking': {
      if (!final.customer_id || final.customer_id === 'new') return searched ? newCustomer() : DROP('not backed by a tool result')
      if (!customers.has(final.customer_id) || !slots.has(final.slot_id)) return DROP('not backed by a tool result')
      const slot = all(ctx.results, 'find_slots').flatMap((r) => r.slots || []).find((s) => s.id === final.slot_id)
      const hours = durationHours(ctx.transcript, 1) ?? 1
      if ((Date.parse(slot.end) - Date.parse(slot.start)) / 3600000 !== hours) return DROP('the visit length does not match what was said')
      return { ok: true, proposal: { kind: 'booking', customer_id: final.customer_id, slot_id: final.slot_id, summary: String(final.summary || 'Job').slice(0, 80) } }
    }
    case 'cash': {
      const inv = invoices.get(final.invoice_id)
      if (!inv) return DROP('not backed by a tool result')
      if (searched && (!customers.size || (inv.customer_id && !customers.has(inv.customer_id)))) return DROP('choose one customer by full name and address')
      const amount = toCents(final.amount)
      if (!(amount > 0) || amount > toCents(inv.due)) return DROP('cash is more than the amount due')
      if (!cashAmountWasSaid(ctx.transcript, amount / 100)) return DROP('the cash amount was not said')
      return { ok: true, proposal: { kind: 'cash', invoice_id: final.invoice_id, amount: (amount / 100).toFixed(2) } }
    }
    case 'reminder': {
      if (!invoices.has(final.invoice_id)) return DROP('not backed by a tool result')
      const inv = invoices.get(final.invoice_id)
      if (searched && (!customers.size || (inv.customer_id && !customers.has(inv.customer_id)))) return DROP('choose one customer by full name and address')
      const s = scrubText(final.text, ctx)
      return { ok: true, proposal: { kind: 'reminder', invoice_id: final.invoice_id, text: s.text }, removed: s.removed }
    }
    case 'answer': {
      const s = scrubText(final.text, ctx)
      const open = all(ctx.results, 'open_invoices').at(-1)?.invoices || []
      let text = s.text
      const removed = [...s.removed]
      if (open.length > 1) {
        const dueCounts = new Map()
        let total = 0
        for (const inv of open) {
          const due = toCents(Number(inv.due))
          total += due
          dueCounts.set(due, (dueCounts.get(due) || 0) + 1)
        }
        const statedCounts = new Map()
        for (const figure of statedFigures(text)) {
          const cents = toCents(figure)
          statedCounts.set(cents, (statedCounts.get(cents) || 0) + 1)
        }
        if (statedCounts.has(total) && [...dueCounts].some(([due, count]) => (statedCounts.get(due) || 0) < count)) {
          // On 24 Oct 2026, 340.00 and 282.42 were listed beside a 672.42 total, leaving out a 50.00 deposit.
          removed.push(text)
          text = ''
        }
      }
      const ids = (Array.isArray(final.invoice_ids) ? final.invoice_ids : []).filter((id) => invoices.has(id))
      return { ok: true, proposal: { kind: 'answer', text, invoice_ids: ids }, removed }
    }
    default:
      return DROP('not a proposal this app makes')
  }
}
