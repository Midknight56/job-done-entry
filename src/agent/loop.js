// @ts-check
// The agent turn. It does not depend on native function calling: each step the model returns one JSON object, either
// {"calls": [...]} or {"final": {...}}. Code runs the calls and asks once more for the final. Malformed JSON is asked
// for once again; after that the turn ends with a plain message. Never more than MAX_MODEL_CALLS model calls.

import { SYSTEM_PROMPT, userMessage } from './prompt.js'
import { createTools, TOOL_NAMES, toneFor } from './tools.js'
import { checkFinal } from './guard.js'
import { durationHours } from '../pricing/words.js'
import { priceLines } from '../pricing/ratecard.js'
import { proposeInvoiceDraft } from '../flows/send.js'
import { offerRates } from '../flows/rates.js'
import { placeBooking } from '../state/holds.js'
import { slotLabel } from '../state/schedule.js'
import { LATE_DAYS, MAX_MODEL_CALLS } from '../caps.js'

export const DID_NOT_CATCH = 'I did not catch that. Type it or try again.'
const MAX_CALLS_PER_STEP = 6

/** @param {string} text */
export function parseReply(text) {
  const values = topLevelValues(text)
  const parsed = values.map((value) => {
    try { return { valid: true, value: JSON.parse(value) } } catch { return { valid: false, value: null } }
  })
  const first = parsed.find((entry) => entry.valid)?.value
  if (first && !Array.isArray(first) && typeof first === 'object') {
    if (Array.isArray(first.calls) && first.calls.length > 0) return { calls: first.calls }
    if (typeof first.tool === 'string') {
      const firstIndex = parsed.findIndex((entry) => entry.valid)
      return { calls: parsed.slice(firstIndex).flatMap((entry) => {
        const value = entry.value
        return value && !Array.isArray(value) && typeof value === 'object' && typeof value.tool === 'string' ? [value] : []
      }) }
    }
    if (first.final && typeof first.final === 'object') return { final: first.final }
    if (typeof first.kind === 'string') return { final: first }
  }
  if (Array.isArray(first) && first.length > 0 && first.every((call) => call && typeof call.tool === 'string')) return { calls: first }
  return null
}

/** @param {string} text */
function topLevelValues(text) {
  /** @type {string[]} */
  const values = []
  /** @type {Array<'{' | '['>} */
  let stack = []
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (start < 0) {
      if (c === '{' || c === '[') { start = i; stack = [c] }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      const expected = c === '}' ? '{' : '['
      if (stack.at(-1) !== expected) { start = -1; stack = []; continue }
      stack.pop()
      if (stack.length === 0) {
        values.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return values
}

/**
 * @param {any} ws
 * @param {string} transcript
 * @param {{ callModel: (messages: any[]) => Promise<{ text: string, neurons: number, actual?: number }>, now: number, api?: any }} deps
 */
export async function runTurn(ws, transcript, { callModel, now, api }) {
  /** @type {any[]} */
  const steps = []
  /** @type {Array<{ tool: string, result: any }>} */
  const results = []
  const { tools, lineInputs } = createTools(ws, { transcript, now, api })
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage({ business: ws.settings.business, today: todayText(ws, now), transcript }) },
  ]
  let calls = 0
  let retried = false
  let neurons = 0
  /** The model's raw replies, in order, for recording replay samples. */
  const outputs = []
  /** What the calls really cost, from the token counts Workers AI returns (the worst case is what was charged). */
  let actual = 0

  /** @param {boolean} needFinal */
  async function ask(needFinal) {
    for (;;) {
      if (calls >= MAX_MODEL_CALLS) return null
      calls++
      const t = Date.now()
      const out = await callModel(messages)
      outputs.push(out.text)
      neurons += out.neurons || 0
      actual += out.actual || 0
      steps.push({ kind: 'model', ms: Date.now() - t, neurons: out.neurons || 0 })
      const r = parseReply(out.text)
      if (r && (!needFinal || r.final)) {
        messages.push({ role: 'assistant', content: out.text })
        return r
      }
      if (retried) return null
      retried = true
      messages.push({ role: 'assistant', content: out.text.slice(0, 2000) })
      messages.push({ role: 'user', content: needFinal ? 'Reply with one JSON object {"final": {...}} only.' : 'Reply with one JSON object only: {"calls": [...]} or {"final": {...}}.' })
    }
  }

  // A new rate said in the words still gets its one tap card when the model's turn came to nothing.
  const fail = (message) => {
    const rateChanges = offerRates(ws, transcript, now)
    if (rateChanges.length) return { proposal: { kind: 'rate', rateChanges, reason: 'You said a new rate.' }, message: null, steps, neurons, actual, outputs }
    return { proposal: null, message, steps, neurons, actual, outputs }
  }

  let reply = await ask(false)
  if (!reply) return fail(DID_NOT_CATCH)
  /** @param {any[]} requested */
  async function runCalls(requested) {
    const out = []
    for (const call of requested.slice(0, MAX_CALLS_PER_STEP)) {
      const name = String(call?.tool || '')
      const t = Date.now()
      let result
      if (!TOOL_NAMES.includes(name)) result = { error: `unknown tool ${name.slice(0, 40)}` }
      else {
        try { result = await tools[name](call.args || {}) } catch (e) { result = { error: String(e?.message || e).slice(0, 200) } }
      }
      steps.push({ kind: 'tool', name, ms: Date.now() - t, ok: !result.error })
      results.push({ tool: name, result })
      out.push({ tool: name, result })
    }
    if (results.some((r) => r.tool === 'find_slots' && r.result.needsDate)) return { failure: 'Which day? Say one day, like tomorrow or Thursday.' }
    if (results.some((r) => r.result.needsDuration)) return { failure: 'How long is the visit? Say one length in hours and minutes.' }
    if (results.some((r) => r.result.needsPartPrice)) return { failure: 'What did the part cost? Say the part name and price.' }
    const candidates = results.filter(r => r.tool === 'find_customer').flatMap(r => r.result.matches || [])
    if (new Set(candidates.map(c => c.id)).size > 1) return { failure: `Which customer? Say the full name and address. ${candidates.map(c => `${c.name}, ${c.address}`).join('; ')}.` }
    return { out }
  }

  if (reply.calls) {
    const executed = await runCalls(reply.calls)
    if (executed.failure) return fail(executed.failure)
    messages.push({ role: 'user', content: `Tool results: ${JSON.stringify(executed.out)}\nNow reply with {"final": {...}} only.` })
    reply = await ask(true)
    if (!reply) return fail(DID_NOT_CATCH)
  }

  if (reply.final.kind === 'booking') {
    let latestSlots = results.filter((r) => r.tool === 'find_slots').at(-1)?.result
    if (!latestSlots) {
      // The small model sometimes skips find_slots; the tool reads only the words, so code can run it.
      const executed = await runCalls([{ tool: 'find_slots', args: {} }])
      if (executed.failure) return fail(executed.failure)
      latestSlots = results.filter((r) => r.tool === 'find_slots').at(-1)?.result
    }
    // A booking always takes the earliest free slot (findSlots returns them in time order); the model's pick does not count.
    const slots = latestSlots?.slots || []
    if (slots.length) reply.final.slot_id = slots[0].id
  }

  let guardRetried = false
  let checked = checkFinal(reply.final, { results, transcript, stepMinutes: ws.settings.rateCard.billingStepMinutes })
  while ('reason' in checked) {
    steps.push({ kind: 'guard', result: `dropped: ${checked.reason}` })
    if (checked.reason === 'the cash amount was not said') return fail('How much cash was paid? Say one amount.')
    if (guardRetried || calls + 2 > MAX_MODEL_CALLS) return fail(`I could not back that up, so I dropped it (${checked.reason}). Try saying it again.`)
    guardRetried = true
    messages.push({ role: 'user', content: `That was dropped: ${checked.reason}. Look at what was said again and reply with {"calls": [...]} only.` })
    const retryCalls = await ask(false)
    if (!retryCalls?.calls) return fail(DID_NOT_CATCH)
    const executed = await runCalls(retryCalls.calls)
    if (executed.failure) return fail(executed.failure)
    messages.push({ role: 'user', content: `Tool results: ${JSON.stringify(executed.out)}\nNow reply with {"final": {...}} only.` })
    reply = await ask(true)
    if (!reply) return fail(DID_NOT_CATCH)
    checked = checkFinal(reply.final, { results, transcript, stepMinutes: ws.settings.rateCard.billingStepMinutes })
  }

  steps.push({ kind: 'guard', result: checked.removed?.length ? `passed, ${checked.removed.length} sentence removed` : 'passed' })
  const proposal = build(ws, checked.proposal, { results, lineInputs, now, transcript })
  const rateChanges = offerRates(ws, transcript, now, proposal.kind === 'invoice' ? proposal.draftId : undefined)
  if (rateChanges.length) proposal.rateChanges = rateChanges
  return { proposal, message: null, steps, neurons, actual, outputs }
}

/** Today in the workspace's local time with its year and ISO date, so the model's dates land in the right year. */
function todayText(ws, now) {
  const local = new Date(now + ws.tz * 60_000)
  const iso = local.toISOString().slice(0, 10)
  return `${slotLabel(ws, now).replace(/ \d+:\d+$/, '')} ${local.getUTCFullYear()} (${iso})`
}

/** Turns a checked final into the proposal the page shows, making its draft where one is needed. */
function build(ws, p, { results, lineInputs, now, transcript }) {
  const name = (id) => ws.customers.find((c) => c.id === id)?.name
  switch (p.kind) {
    case 'waiting':
      return { kind: 'waiting', customerId: p.customer_id, customer: name(p.customer_id), summary: p.summary, hours: p.hours, free: p.free, reason: 'The job waits for a slot when the customer is free.' }
    case 'invoice': {
      const priced = priceLines(p.line_ids.map((id) => lineInputs.get(id)), ws.settings.rateCard)
      const draft = proposeInvoiceDraft(ws, { customerId: p.customer_id, priced, summary: p.summary || 'Job', note: p.note || undefined })
      draft.requiresVisit = true
      return { kind: 'invoice', draftId: draft.id, customerId: p.customer_id, customer: name(p.customer_id), priced: draft.priced, summary: draft.summary, jobId: null, needsVisit: true, reason: 'Priced from your rate card and what you said.' }

    }
    case 'booking': {
      const slot = results.filter((r) => r.tool === 'find_slots').flatMap((r) => r.result.slots || []).find((s) => s.id === p.slot_id)
      const hours = (Date.parse(slot.end) - Date.parse(slot.start)) / 3_600_000
      const { job, draft } = placeBooking(ws, { customerId: p.customer_id, summary: p.summary, hours, slot, now })
      return { kind: 'booking', jobId: job.id, draftId: draft.id, customerId: p.customer_id, customer: name(p.customer_id), slot, summary: p.summary, deposit: draft.priced.total, holdMinutes: ws.settings.holdMinutes, reason: `${durationHours(transcript, 1) === null ? 'One hour by default.' : `Visit length ${hours} hours.`} First free time in the period you asked for. A ${draft.priced.total} deposit holds it.` }
    }
    case 'cash': {
      const inv = ws.invoices[p.invoice_id]
      return { kind: 'cash', invoiceId: p.invoice_id, amount: p.amount, due: inv?.due, customerId: inv?.customerId, customer: name(inv?.customerId), reason: `Matches ${name(inv?.customerId)}'s open invoice for ${inv?.due}.` }
    }
    case 'reminder': {
      const inv = ws.invoices[p.invoice_id]
      const tone = toneFor(inv?.reminders || 0)
      return { kind: 'reminder', invoiceId: p.invoice_id, tone, text: p.text || reminderTemplate(tone, inv, name(inv?.customerId)), customer: name(inv?.customerId), due: inv?.due, reason: 'PayPal sends its standard reminder. The draft is for you to send yourself.' }
    }
    case 'answer': {
      // A money answer is written by code from the open invoice rows: who owes whom, the amount and the linked invoice
      // come from the same row. The model only picks which rows (a review on 9 Nov 2026 found "You owe 340.00 to Sam
      // Okafor." and "You are owed 85." had passed a check that matched numbers alone).
      const rows = results.filter((x) => x.tool === 'open_invoices' && x.result && !x.result.error).at(-1)?.result?.invoices
      if (!rows) return { kind: 'answer', text: p.text || 'Nothing is owed right now.', invoiceIds: p.invoice_ids, reason: 'Each figure is an open invoice.' }
      const picked = rows.filter((r) => p.invoice_ids.includes(r.invoice_id))
      const chosen = picked.length ? picked : rows
      return { kind: 'answer', text: owedText(chosen, ws.settings.lateDays ?? LATE_DAYS, chosen.length === rows.length), invoiceIds: chosen.map((r) => r.invoice_id), reason: 'Each figure is an open invoice.' }
    }
    // The guard passes only the kinds above, so the last one is the new customer card.
    default:
      return { ...p, reason: 'No customer by that name yet.' }
  }
}

/** @param {string} tone @param {any} inv @param {string | undefined} who */
export function reminderTemplate(tone, inv, who) {
  const first = (who || '').split(' ')[0] || 'there'
  if (tone === 'firm') return `Hi ${first}. This is my third note about the ${inv?.due} for the work I did. Please pay it this week using the link in the invoice.`
  if (tone === 'polite') return `Hi ${first}. A reminder that ${inv?.due} is still open for the work I did. The link in the invoice takes card or PayPal.`
  return `Hi ${first}. Just a nudge on the ${inv?.due} invoice. Thanks again for having me out.`
}

/**
 * The answer about money, from open_invoices rows only: "Sam Okafor owes you 340.00, 15 days late. 340.00 in all."
 * @param {any[]} rows @param {number} lateDays
 */
export function owedText(rows, lateDays, everything = true) {
  if (!rows.length) return 'Nothing is owed right now.'
  const parts = rows.map((i) => `${i.customer} owes you ${i.kind === 'deposit' ? `a ${i.due} deposit` : i.due}${i.days_since_sent > lateDays ? `, ${i.days_since_sent} days late` : ''}`)
  const cents = rows.reduce((n, i) => n + Math.round(Number(i.due) * 100), 0)
  // The total closes an answer about everything owed, or about more than one invoice.
  const total = everything || rows.length > 1 ? ` ${(cents / 100).toFixed(2)} in all.` : ''
  return `${parts.join('. ')}.${total}`
}
