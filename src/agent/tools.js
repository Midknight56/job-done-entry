// @ts-check
// The tools the model may call. All run in code, all are read only, none sends money.

import { requestedDates } from './dates.js'
import { priceLines } from '../pricing/ratecard.js'
import { costWasSaid, durationHours, durationNeedsClarification } from '../pricing/words.js'
import { getInvoice } from '../paypal/invoices.js'
import { applyStatus } from '../state/money.js'
import { findSlots } from '../state/schedule.js'
import { LATE_DAYS } from '../caps.js'

export const TOOL_NAMES = ['find_customer', 'price_lines', 'find_slots', 'open_invoices', 'waiting_list']
const DAY = 86_400_000
const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED', 'PAYMENT_PENDING'])

/** The reminder tone, from how many were sent before: the third one is firm. @param {number} sent */
export function toneFor(sent) {
  return sent >= 2 ? 'firm' : sent === 1 ? 'polite' : 'friendly'
}

/** @param {string} s */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * @param {any} ws
 * @param {{ transcript: string, now: number, api?: any }} ctx
 */
export function createTools(ws, ctx) {
  let lineSeq = 0
  /** The input behind each priced line id, so the final draft is priced again from the rate card. */
  const lineInputs = new Map()
  const chargeIds = new Map()

  /** @param {any} c */
  function history(c) {
    const mine = Object.values(ws.invoices).filter((i) => i.customerId === c.id)
    return {
      invoices: mine.length,
      open: mine.filter((i) => OPEN.has(i.status)).length,
      late: mine.filter((i) => OPEN.has(i.status) && i.sentAt && ctx.now - i.sentAt > (ws.settings.lateDays ?? LATE_DAYS) * DAY).length,
      reminders_sent: mine.reduce((n, i) => n + (i.reminders || 0), 0),
    }
  }

  const tools = {
    /** @param {{ name?: string, place_hint?: string }} a */
    async find_customer(a) {
      const name = norm(a.name)
      const place = norm(a.place_hint)
      const matches = ws.customers.filter((c) => {
        const n = norm(c.name)
        const byName = name && name.split(' ').every(w => n.split(' ').includes(w))
        const placeWords = place.replace(/\b(street|st|road|rd|lane|close)\b/g, '').trim().split(' ').filter(Boolean)
        const byPlace = placeWords.length > 0 && placeWords.every(w => norm(c.address).split(' ').includes(w))
        return Boolean((name || place) && (!name || byName) && (!place || byPlace))
      })
      return { matches: matches.map((c) => ({ id: c.id, name: c.name, address: c.address, history: history(c) })) }
    },

    /** @param {{ lines?: any[] }} a */
    async price_lines(a) {
      const step = ws.settings.rateCard.billingStepMinutes
      if (durationNeedsClarification(ctx.transcript)) return { lines: [], needsDuration: true }
      const accepted = /** @type {any[]} */ ([])
      const refused = []
      for (const line of Array.isArray(a.lines) ? a.lines.slice(0, 12) : []) {
        if (line?.kind === 'labour') {
          const said = durationHours(ctx.transcript, step)
          if (said === null || Number(line.hours) !== said) { refused.push({ line, reason: said === null ? 'no time was said' : `the time said was ${said} hours` }); continue }
          accepted.push({ kind: 'labour', hours: said, description: line.description })
        } else if (line?.kind === 'part') {
          const cost = Number(line.cost)
          if (!costWasSaid(ctx.transcript, cost, line.description)) { refused.push({ line, reason: 'that cost was not said' }); continue }
          accepted.push({ kind: 'part', description: String(line.description || 'Part').slice(0, 60), cost })
        } else if (line?.kind === 'callout') {
          accepted.push({ kind: 'callout' })
        } else {
          refused.push({ line, reason: 'unknown line kind' })
        }
      }
      if (refused.some(r => r.line?.kind === 'part')) return { lines: [], refused, needsPartPrice: true }
      if (accepted.length === 0) return { lines: [], refused }
      // The rate card charges a call out on every visit with labour, whether or not the model listed it.
      if (accepted.some((l) => l.kind === 'labour') && !accepted.some((l) => l.kind === 'callout')) accepted.unshift({ kind: 'callout' })
      const unique = accepted.filter((line, i, list) => list.findIndex((other) => chargeKey(other) === chargeKey(line)) === i)
      const priced = priceLines(unique, ws.settings.rateCard)
      const lines = priced.lines.map((l, i) => {
        const input = unique[i], key = chargeKey(input)
        const id = chargeIds.get(key) || `p${++lineSeq}`
        chargeIds.set(key, id)
        lineInputs.set(id, input)
        return { ...l, id, ...(input.kind === 'part' ? { cost: input.cost } : {}) }
      })
      return { lines, refused, itemTotal: priced.itemTotal, tax: priced.tax, taxPercent: priced.taxPercent, total: priced.total, currency: priced.currency }
    },

    /** @param {{ duration_hours?: number, after?: string, before?: string }} a */
    async find_slots(a) {
      const said = durationHours(ctx.transcript, 1)
      if (durationNeedsClarification(ctx.transcript)) return { slots: [], needsDuration: true }
      const hours = said ?? 1
      if (hours < 0.5 || hours > 8) return { slots: [], error: 'The visit length does not match what you said.' }
      const dates = requestedDates(ctx.transcript, ctx.now, ws.tz)
      if (!dates) return { slots: [], needsDate: true }
      const slots = findSlots(ws, { durationHours: hours, after: dates.after, before: dates.before, now: ctx.now, limit: 200 })
        .filter((slot) => {
          const start = new Date(Date.parse(slot.start) + ws.tz * 60000)
          const end = new Date(Date.parse(slot.end) + ws.tz * 60000)
          return !dates.period || (dates.period === 'morning' ? end.getUTCHours() * 60 + end.getUTCMinutes() <= 12 * 60 : start.getUTCHours() >= 12)
        }).slice(0, 6)
      return { slots, ...(said === null ? { defaultDurationHours: 1 } : {}) }

    },

    /** @param {{ customer_id?: string }} a */
    async open_invoices(a) {
      const out = []
      for (const inv of Object.values(ws.invoices)) {
        if (a.customer_id && inv.customerId !== a.customer_id) continue
        if (ctx.api && OPEN.has(inv.status)) {
          try {
            const live = await getInvoice(ctx.api, inv.id)
            applyStatus(ws, inv.id, live.status, ctx.now, { due: live.due, paid: live.paid, tip: live.tip, refunded: live.refunded, source: 'status poll' })
          } catch { /* keep the stored status; the panel shows the failed read */ }
        }
        if (!OPEN.has(inv.status)) continue
        const c = ws.customers.find((x) => x.id === inv.customerId)
        out.push({
          invoice_id: inv.id,
          customer_id: inv.customerId,
          customer: c?.name,
          kind: inv.kind,
          total: inv.total,
          due: inv.due,
          days_since_sent: inv.sentAt ? Math.floor((ctx.now - inv.sentAt) / DAY) : 0,
          reminders_sent: inv.reminders || 0,
          suggested_tone: toneFor(inv.reminders || 0),
        })
      }
      const totalCents = out.reduce((n, i) => n + Math.round(Number(i.due) * 100), 0)
      return { invoices: out, total_due: (totalCents / 100).toFixed(2) }
    },

    async waiting_list() {
      return {
        jobs: ws.waiting.map((id) => ws.jobs.find((j) => j.id === id)).filter(Boolean).map((j) => ({
          job_id: j.id, customer_id: j.customerId, customer: ws.customers.find((c) => c.id === j.customerId)?.name, summary: j.summary, hours: j.hours, free: j.free || 'any',
        })),
      }
    },
  }

  return { tools, lineInputs }
}

/** @param {any} line */
function chargeKey(line) { return line.kind === 'part' ? JSON.stringify(['part', norm(line.description), line.cost]) : line.kind }
