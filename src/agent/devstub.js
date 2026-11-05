// @ts-check
// A stand in for the model, for running the app on a developer's own machine without Workers AI. It answers the
// demo lines with the JSON a model would return, so the tools, the guard and the PayPal calls run for real. It is
// used only when MODEL_STUB is "1" in .dev.vars AND the page is served from localhost; the hosted demo never uses it,
// and the panel names it "development stub" on every step.
import { durationHours } from '../pricing/words.js'

/** @param {string} text */
function firstStep(text) {
  const t = text.toLowerCase()
  if (/waiting list/.test(t)) {
    const name = /put (\w+) on/.exec(t)?.[1] || /for (\w+)/.exec(t)?.[1] || ''
    return { calls: [{ tool: 'find_customer', args: { name } }] }
  }
  if (/owed|owe me/.test(t)) return { calls: [{ tool: 'open_invoices', args: {} }] }
  if (/remind/.test(t)) {
    const name = /remind (\w+)/.exec(t)?.[1] || ''
    return { calls: [{ tool: 'find_customer', args: { name } }, { tool: 'open_invoices', args: {} }] }
  }
  if (/cash/.test(t)) {
    const name = /^(\w+)/.exec(t)?.[1] || ''
    return { calls: [{ tool: 'find_customer', args: { name } }, { tool: 'open_invoices', args: {} }] }
  }
  if (/^book|book /.test(t)) {
    const name = /for (\w+)/.exec(t)?.[1] || ''
    return { calls: [{ tool: 'find_customer', args: { name } }, { tool: 'find_slots', args: { duration_hours: 1 } }] }
  }
  const name = /for (\w+)/.exec(t)?.[1] || ''
  const part = /the (\w+) was \$?(\d+(?:\.\d+)?)/.exec(t)
  const lines = /** @type {any[]} */ ([{ kind: 'callout' }, { kind: 'labour', hours: hoursIn(t) }])
  if (part) lines.push({ kind: 'part', description: part[1][0].toUpperCase() + part[1].slice(1), cost: Number(part[2]) })
  return { calls: [{ tool: 'find_customer', args: { name } }, { tool: 'price_lines', args: { lines } }] }
}

/** @param {string} t */
function hoursIn(t) {
  if (/hour and a half|90 minutes|ninety minutes/.test(t)) return 1.5
  if (/half an hour|30 minutes/.test(t)) return 0.5
  const m = /(\d+(?:\.\d+)?) hours?/.exec(t)
  return m ? Number(m[1]) : 1
}

/** @param {string} text @param {any} results */
function finalStep(text, results) {
  const t = text.toLowerCase()
  const r = (tool) => results.find((x) => x.tool === tool)?.result
  const customerId = r('find_customer')?.matches?.[0]?.id || 'new'
  if (/waiting list/.test(t)) {
    const detail = /waiting list for (.+?)(?:,|$)/.exec(t)?.[1] || ''
    const plain = detail.replace(/^(?:a |an )?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|half an) hours?\s+/, '').trim()
    const summary = plain ? plain[0].toUpperCase() + plain.slice(1) : 'Job'
    return { final: { kind: 'waiting', customer_id: customerId, summary, hours: durationHours(text, 15), free: /afternoons/.test(t) ? 'afternoons' : /mornings/.test(t) ? 'mornings' : 'any' } }
  }
  if (/owed|owe me/.test(t)) {
    const inv = r('open_invoices')?.invoices || []
    return { final: { kind: 'answer', text: inv.map((i) => `${i.due} from ${i.customer}.`).join(' '), invoice_ids: inv.map((i) => i.invoice_id) } }
  }
  if (/remind|cash/.test(t)) {
    const inv = (r('open_invoices')?.invoices || []).find((i) => i.customer_id === customerId)
    if (!inv) return { final: { kind: 'answer', text: 'Nothing is open for them.', invoice_ids: [] } }
    if (/remind/.test(t)) return { final: { kind: 'reminder', invoice_id: inv.invoice_id, text: `Hi. ${inv.due} is still open. Thanks.` } }
    const amount = /(\d+(?:\.\d+)?)/.exec(t)?.[1] || inv.due
    return { final: { kind: 'cash', invoice_id: inv.invoice_id, amount: Number(amount).toFixed(2) } }
  }
  if (/^book|book /.test(t)) return { final: { kind: 'booking', customer_id: customerId, slot_id: 's1', summary: 'Bathroom tap' } }
  const ids = (r('price_lines')?.lines || []).map((l) => l.id)
  return { final: { kind: 'invoice', customer_id: customerId, customer_name: /for tom baker\b/.test(t) ? 'Tom Baker' : /for (\w+)/.exec(t)?.[1], line_ids: ids, summary: 'Kitchen tap' } }
}

/** @param {string} text */
export function devStubModel(text) {
  let step = 0
  return async (messages) => {
    step++
    if (step === 1) return { text: JSON.stringify(firstStep(text)), neurons: 0 }
    const last = String(messages.at(-1)?.content || '')
    const results = JSON.parse(last.slice(last.indexOf('['), last.lastIndexOf(']') + 1) || '[]')
    return { text: JSON.stringify(finalStep(text, results)), neurons: 0 }
  }
}
