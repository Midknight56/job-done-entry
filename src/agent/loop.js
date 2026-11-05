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
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const j = JSON.parse(text.slice(start, end + 1))
    if (j && Array.isArray(j.calls) && j.calls.length > 0) return { calls: j.calls }
    if (j && j.final && typeof j.final === 'object') return { final: j.final }
    // Seen live on 23 Oct 2026: the model sometimes sends the proposal without its {"final": ...} wrapper.
    if (j && typeof j.kind === 'string') return { final: j }
  } catch { /* fall through */ }
  return null
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
  if (reply.calls) {
    const out = []
    for (const call of reply.calls.slice(0, MAX_CALLS_PER_STEP)) {
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
    if (results.some((r) => r.tool === 'find_slots' && r.result.needsDate)) return fail('Which day? Say one day, like tomorrow or Thursday.')
    if (results.some((r) => r.result.needsDuration)) return fail('How long is the visit? Say one length in hours and minutes.')
    if (results.some((r) => r.result.needsPartPrice)) return fail('What did the part cost? Say the part name and price.')
    const candidates = results.filter(r => r.tool === 'find_customer').flatMap(r => r.result.matches || [])
    if (new Set(candidates.map(c => c.id)).size > 1) return fail(`Which customer? Say the full name and address. ${candidates.map(c => `${c.name}, ${c.address}`).join('; ')}.`)
    messages.push({ role: 'user', content: `Tool results: ${JSON.stringify(out)}\nNow reply with {"final": {...}} only.` })
    reply = await ask(true)
    if (!reply) return fail(DID_NOT_CATCH)
  }

  const checked = checkFinal(reply.final, { results, transcript, stepMinutes: ws.settings.rateCard.billingStepMinutes })
  if ('reason' in checked) {
    steps.push({ kind: 'guard', result: `dropped: ${checked.reason}` })
    if (checked.reason === 'the cash amount was not said') return fail('How much cash was paid? Say one amount.')
    return fail(`I could not back that up, so I dropped it (${checked.reason}). Try saying it again.`)
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
      const text = p.text || owedFromResults(results, ws.settings.lateDays ?? LATE_DAYS)
      return { kind: 'answer', text, invoiceIds: p.invoice_ids.length ? p.invoice_ids : openIds(results), reason: 'Each figure is an open invoice.' }
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

/** A plain answer built by code from open_invoices, used when the model's text did not survive the guard. */
function owedFromResults(results, lateDays) {
  const r = results.filter((x) => x.tool === 'open_invoices').at(-1)?.result
  if (!r || !r.invoices?.length) return 'Nothing is owed right now.'
  const parts = r.invoices.map((i) => `${i.due} from ${i.customer}${i.days_since_sent > lateDays ? `, ${i.days_since_sent} days late` : ''}`)
  return `${parts.join('. ')}. ${r.total_due} in all.`
}

function openIds(results) {
  return results.filter((x) => x.tool === 'open_invoices').flatMap((x) => (x.result.invoices || []).map((i) => i.invoice_id))
}
