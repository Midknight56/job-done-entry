// @ts-check
// The drop rule. Code, not the prompt, decides what reaches the screen:
// 1. every id in a final proposal must appear in a tool result from this turn;
// 2. in every text the model writes (invoice summary and note, booking summary, waiting summary, reminder text, answer,
//    new customer name) a sentence that states an amount no tool returned and nobody said is removed. A whole number
//    from 0 to 12 is a count or a clock hour unless a currency sign or word goes with it;
// 3. a part cost must have been said, and labour hours must match the duration that was said;
// 4. cash may not be more than the invoice's due amount, and the amount must have been said;
// 5. a name with no customer match becomes "new customer, confirm details" and cannot be invoiced;
// 7. a booking takes the earliest free slot that find_slots returned;
// 8. in an answer, when invoices were read, each amount must be the due or total of an invoice read this turn, or the
//    sum of what is due; code links the invoice behind each amount, and a sentence with any other amount is removed.
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

// Currency signs and words. Kept as regular expressions so no string escaping can break them.
const SIGNS = /[$£€¥₹]\s?/g
const DIGIT_FIGURE = /([$£€¥₹]\s?)?\b\d[\d,]*(\.\d+)?\b(?=(\s*(?:dollars?|bucks?|cad|usd)\b)?)/gi
const DIGITS_ONLY = /[$£€¥₹]?\s?\b\d[\d,]*(\.\d+)?\b/g
const WORDS_THEN_CURRENCY = /((?:[a-z]+[\s-]+){1,4})(?:dollars?|bucks?|cad|usd)\b/gi

/**
 * The figures a sentence states, each marked as money or not. A figure is money when a currency sign goes before it,
 * a currency word follows it, or it has exactly two decimals. Number words count when a currency word follows them,
 * or when they are above 12.
 * @param {string} sentence the sentence with its currency signs still in it
 * @returns {{ n: number, money: boolean }[]}
 */
function figuresIn(sentence) {
  const out = []
  for (const m of sentence.matchAll(DIGIT_FIGURE)) {
    const n = Number(m[0].replace(SIGNS, '').replace(/[,\s]/g, ''))
    const money = Boolean(m[1] || m[3] || (m[2] && m[2].length === 3))
    out.push({ n, money })
  }
  const words = sentence.replace(DIGITS_ONLY, ' ')
  const withCurrency = new Set()
  for (const m of words.matchAll(WORDS_THEN_CURRENCY)) {
    const found = numbersIn(m[1])
    if (found.length) withCurrency.add(found[found.length - 1])
  }
  for (const n of numbersIn(words)) {
    if (withCurrency.has(n)) out.push({ n, money: true })
    else if (n > 12) out.push({ n, money: false })
  }
  return out
}

/**
 * The figures a sentence states that the drop rule checks: everything except small whole numbers that are not money.
 * @param {string} sentence
 */
function statedFigures(sentence) {
  return figuresIn(sentence).filter((f) => f.money || !Number.isInteger(f.n) || f.n > 12).map((f) => f.n)
}

/**
 * Removes every sentence that states a figure no tool returned and nobody said.
 * @param {string} text @param {TurnContext} ctx
 */
export function scrubText(text, ctx) {
  const backed = backedFigures(ctx)
  const kept = []
  const removed = []
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
    // Each sentence is judged with its currency signs, so "$5" counts as money.
    if (statedFigures(sentence).every((n) => backed.has(toCents(n)))) kept.push(sentence)
    else removed.push(sentence)
  }
  // Amounts are shown plain, in the rate card's currency. A model once wrote a pound sign on a dollar invoice
  // (recorded 23 Oct 2026), so every currency sign is taken out.
  return { text: kept.join(' ').replace(SIGNS, ''), removed }
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

  const newCustomer = () => ({ ok: /** @type {const} */ (true), proposal: { kind: 'new_customer', name: scrubText(String(final.customer_name || '').slice(0, 60), ctx).text || 'New customer' } })

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
      const first = all(ctx.results, 'find_slots').at(-1)?.slots?.[0]
      if (!first || first.id !== final.slot_id) return DROP('not the first free slot')
      const slot = first
      const hours = durationHours(ctx.transcript, 1) ?? 1
      if ((Date.parse(slot.end) - Date.parse(slot.start)) / 3600000 !== hours) return DROP('the visit length does not match what was said')
      const summary = scrubText(String(final.summary || '').slice(0, 80), ctx).text || 'Job'
      return { ok: true, proposal: { kind: 'booking', customer_id: final.customer_id, slot_id: final.slot_id, summary } }
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
      // Sentences are judged with their currency signs; the signs are stripped from the kept text at the end.
      const removed = []
      const backedSentences = []
      for (const sentence of String(final.text || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)) {
        if (scrubText(sentence, ctx).text) backedSentences.push(sentence)
        else removed.push(sentence)
      }
      const open = all(ctx.results, 'open_invoices').at(-1)?.invoices || []
      let text = backedSentences.join(' ')
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
      const linked = []
      if (invoices.size) {
        // Each amount must belong to an invoice read this turn; code links that invoice.
        const dueSum = open.reduce((sum, inv) => sum + toCents(Number(inv.due)), 0)
        const keptSentences = []
        for (const sentence of text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
          let backedByInvoice = true
          for (const f of figuresIn(sentence).filter((x) => x.money)) {
            const cents = toCents(f.n)
            const owners = [...invoices.values()].filter((inv) => toCents(Number(inv.due)) === cents || toCents(Number(inv.total)) === cents)
            if (owners.length) owners.forEach((inv) => linked.push(inv.invoice_id))
            else if (open.length && cents === dueSum) open.forEach((inv) => linked.push(inv.invoice_id))
            else backedByInvoice = false
          }
          if (backedByInvoice) keptSentences.push(sentence)
          else removed.push(sentence)
        }
        text = keptSentences.join(' ')
      }
      const chosen = (Array.isArray(final.invoice_ids) ? final.invoice_ids : []).filter((id) => invoices.has(id))
      const ids = [...new Set([...linked, ...chosen])]
      return { ok: true, proposal: { kind: 'answer', text: text.replace(SIGNS, ''), invoice_ids: ids }, removed }
    }
    default:
      return DROP('not a proposal this app makes')
  }
}
