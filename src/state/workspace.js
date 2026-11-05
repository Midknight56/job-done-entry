// @ts-check
// One JSON document per workspace: a made up one person plumbing business with its rate card, four customers, a
// week of jobs and one job on the waiting list. Everything a user action changes is saved in one KV write.

import { DEMO_RATE_CARD } from '../pricing/ratecard.js'
import { LATE_DAYS } from '../caps.js'
import { resolveRecipient } from '../paypal/invoices.js'

export const PANEL_KEEP = 60
export const NOTICES_KEEP = 30
const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * @typedef {{ id: string, name: string, given: string, surname: string, address: string, email: string }} Customer
 * @typedef {{ id: string, customerId: string, summary: string, start: string, end: string, state: string, invoiceId?: string, settlementId?: string, completedAt?: number, depositInvoiceId?: string, depositPaid?: boolean, draftedAt?: number, hours?: number, free?: 'any' | 'mornings' | 'afternoons' | number[] }} Job
 * @typedef {{ id: string, jobId?: string, customerId: string, kind: string, total: string, due: string, status: string, sentAt?: number, reminders: number, payerUrl?: string, qr?: string, cash?: boolean, paidAt?: number, paid?: string, tip?: string, refunded?: string }} Invoice
 */

/**
 * Local time helpers. The workspace keeps the browser's offset from UTC in minutes (east positive), so the server can
 * place jobs in working hours without a time zone database.
 * @param {number} ms @param {number} tz
 */
export function localDate(ms, tz) {
  const d = new Date(ms + tz * 60_000)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() }
}

/** The UTC time of a local wall clock time on the day `dayOffset` days from `ms`. @param {number} ms @param {number} tz @param {number} dayOffset @param {number} hour */
export function atLocal(ms, tz, dayOffset, hour) {
  const l = localDate(ms, tz)
  return Date.UTC(l.y, l.m, l.d + dayOffset, 0, 0) + hour * HOUR - tz * 60_000
}

/** The next weekday at or after `dayOffset` days from now (skips Saturday and Sunday). */
function weekday(ms, tz, dayOffset) {
  let off = dayOffset
  for (;;) {
    const dow = localDate(atLocal(ms, tz, off, 12), tz).dow
    if (dow !== 0 && dow !== 6) return off
    off += 1
  }
}

/** @param {{ id: string, now: number, tzOffsetMinutes: number, demoHold?: boolean }} o */
export function seedWorkspace({ id, now, tzOffsetMinutes: tz, demoHold = true }) {
  const iso = (ms) => new Date(ms).toISOString()
  const today = weekday(now, tz, 0)
  const localDow = localDate(now, tz).dow
  const before = localDow === 1 || localDow === 0 || localDow === 6 ? today : weekday(now, tz, today - 1) // Keep the job in the week the calendar opens.
  const next1 = weekday(now, tz, today + 1)
  const next2 = weekday(now, tz, next1 + 1)
  /** @type {Customer[]} */
  const customers = [
    // Maria's invoices go to the sandbox buyer persona, so a judge or the video can pay them on PayPal's sandbox page.
    { id: 'c1', name: 'Maria Lopez', given: 'Maria', surname: 'Lopez', address: '14 Elm Street', email: 'persona:buyer' },
    { id: 'c2', name: 'Dave Chen', given: 'Dave', surname: 'Chen', address: '3 Harbour Road', email: 'dave@example.com' },
    { id: 'c3', name: 'Sam Okafor', given: 'Sam', surname: 'Okafor', address: '27 Mill Lane', email: 'sam@example.com' },
    { id: 'c4', name: 'Priya Nair', given: 'Priya', surname: 'Nair', address: '9 Birch Close', email: 'priya@example.com' },
  ]
  /** @type {Job[]} */
  const jobs = [
    { id: 'j1', customerId: 'c2', summary: 'Leak repair', start: iso(atLocal(now, tz, before, 10)), end: iso(atLocal(now, tz, before, 11)), state: 'booked' },
    { id: 'j2', customerId: 'c1', summary: 'Kitchen tap', start: iso(atLocal(now, tz, today, 13)), end: iso(atLocal(now, tz, today, 14.5)), state: 'booked' },
    { id: 'j3', customerId: 'c3', summary: 'Boiler check', start: iso(atLocal(now, tz, next1, 10)), end: iso(atLocal(now, tz, next1, 12)), state: 'booked' },
    { id: 'j4', customerId: 'c2', summary: 'Shower valve', start: iso(atLocal(now, tz, next2, 13)), end: iso(atLocal(now, tz, next2, 15)), state: 'booked' },
    { id: 'j5', customerId: 'c4', summary: 'Leak under the sink', start: '', end: '', state: 'waiting', hours: 1, free: 'any' },
  ]
  return {
    id,
    createdAt: now,
    tz,
    settings: {
      business: 'Elm Street Plumbing (demo)',
      rateCard: { ...DEMO_RATE_CARD },
      holdMinutes: demoHold ? 2 : 1440,
      lateDays: LATE_DAYS,
      workHours: [8, 17],
    },
    customers,
    jobs,
    waiting: ['j5'],
    /** @type {Record<string, Invoice>} */
    invoices: {},
    /** @type {Record<string, any>} */
    settlements: {},
    /** @type {Record<string, any>} */
    drafts: {},
    /** @type {Array<any>} */
    holds: [],
    /** @type {Record<string, any>} */
    offers: {},
    /** @type {Record<string, any>} */
    rateOffers: {},
    /** @type {Array<{ at: number, text: string, kind?: string, invoiceId?: string, settlementId?: string }>} */
    notices: [],
    /** @type {Array<any>} */
    panel: [],
    seq: 10, // ids made later start above the seeded j1 to j5
    cursor: 0,
  }
}

/** A fresh id inside this workspace. @param {any} ws @param {string} prefix */
export function nextId(ws, prefix) {
  ws.seq += 1
  return `${prefix}${ws.seq}`
}

/** @param {any} ws @param {any} fields @param {any} [env] @returns {Customer} */
export function addCustomer(ws, fields, env = {}) {
  const invalid = (message) => { throw Object.assign(new Error(message), { code: 'customer', status: 422 }) }
  if (typeof fields?.name !== 'string' || !fields.name.trim() || fields.name.length > 60) invalid('Name must be 1 to 60 characters.')
  if (typeof fields?.address !== 'string' || fields.address.length > 80) invalid('Address must be at most 80 characters.')
  if (typeof fields?.email !== 'string') invalid('Use an example.com email address.')
  const name = fields.name.trim()
  const email = fields.email.trim()
  resolveRecipient(email, env)
  if (ws.customers.length >= 20) invalid('This demo holds at most 20 customers.')
  const [given, ...rest] = name.split(/\s+/)
  const person = { id: nextId(ws, 'c'), name, given, surname: rest.join(' '), address: fields.address.trim(), email }
  ws.customers.push(person)
  return person
}

/** @param {any} ws @param {any} entry */
export function pushPanel(ws, entry) {
  ws.cursor += 1
  ws.panel.push({ ...entry, n: ws.cursor })
  if (ws.panel.length > PANEL_KEEP) ws.panel.splice(0, ws.panel.length - PANEL_KEEP)
}

/** @param {any} ws @param {{ at: number, text: string, kind?: string, invoiceId?: string, settlementId?: string }} notice */
export function pushNotice(ws, notice) {
  ws.cursor += 1
  ws.notices.push({ ...notice, n: ws.cursor })
  if (ws.notices.length > NOTICES_KEEP) ws.notices.splice(0, ws.notices.length - NOTICES_KEEP)
}

/** @param {any} ws @param {string} id @returns {Customer | undefined} */
export function customer(ws, id) {
  return ws.customers.find((c) => c.id === id)
}

/** @param {any} ws @param {string} id @returns {Job | undefined} */
export function job(ws, id) {
  return ws.jobs.find((j) => j.id === id)
}

/** What the browser may see: persona emails are shown as a label, never as the address. @param {any} ws */
export function publicView(ws) {
  return {
    ...ws,
    customers: ws.customers.map((c) => ({ ...c, email: c.email.startsWith('persona:') ? 'PayPal sandbox buyer' : c.email })),
  }
}

export { DAY, HOUR }
