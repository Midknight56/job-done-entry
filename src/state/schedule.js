// @ts-check
// Free slots, clashes and moves on the tradesperson's week. All times are ISO strings in UTC; the workspace keeps the
// browser's offset so working hours and labels are local.
import { freeFor, availabilityReason } from './waiting.js'
import { atLocal, customer, job, localDate } from './workspace.js'

/** @param {any} ws @param {{ durationHours: number, after: string|number, before?: string|number, now: number, limit?: number }} options */
export function findSlots(ws, { durationHours, after, before, now, limit = 6 }) {
  const floor = Math.max(typeof after === 'number' ? after : Date.parse(after), now)
  const ceiling = before === undefined ? Infinity : (typeof before === 'number' ? before : Date.parse(before))
  const duration = durationHours * 3_600_000
  if (!Number.isFinite(floor) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(limit) || limit <= 0 || ceiling <= floor) return []
  const work = ws.settings.workHours
  const startDay = localDate(floor, ws.tz)
  const base = Date.UTC(startDay.y, startDay.m, startDay.d)
  const slots = []
  for (let day = 0; day <= 21 && slots.length < limit; day++) {
    const noon = base + day * 86_400_000 + 12 * 3_600_000 - ws.tz * 60_000
    const dow = localDate(noon, ws.tz).dow
    if (dow === 0 || dow === 6) continue
    const dayBase = base + day * 86_400_000
    for (let h = Math.ceil(work[0]); h + durationHours <= work[1] && slots.length < limit; h++) {
      const start = dayBase + h * 3_600_000 - ws.tz * 60_000
      const end = start + duration
      if (start < floor || start >= ceiling || end > ceiling || clashes(ws, start, end).length) continue
      const label = slotLabel(ws, start)
      slots.push({ id: `s${slots.length + 1}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), label })
    }
  }
  return slots
}

/** @param {any} ws @param {string|number} start @param {string|number} end @param {string} [ignoreJobId] */
export function clashes(ws, start, end, ignoreJobId) {
  const a = typeof start === 'number' ? start : Date.parse(start)
  const b = typeof end === 'number' ? end : Date.parse(end)
  return ws.jobs.filter((j) => j.id !== ignoreJobId && j.state !== 'draft' && j.state !== 'released' && j.state !== 'waiting' && j.start && j.end && Date.parse(j.start) < b && Date.parse(j.end) > a)
}

/** @param {any} ws @param {string} jobId @param {string|number} start @param {number} now */
export function moveJob(ws, jobId, start, now) {
  const j = job(ws, jobId)
  if (!j) throw new Error('No such job')
  const startMs = typeof start === 'number' ? start : Date.parse(start)
  const oldStart = Date.parse(j.start)
  const oldEnd = Date.parse(j.end)
  const duration = oldEnd - oldStart
  if (!Number.isFinite(startMs) || !Number.isFinite(duration) || duration <= 0 || startMs < now) return { ok: false, text: `${j.summary} cannot be moved to that time.` }
  const endMs = startMs + duration
  const startLocal = localDate(startMs, ws.tz)
  const endLocal = localDate(endMs, ws.tz)
  const work = ws.settings.workHours
  if (startLocal.y !== endLocal.y || startLocal.m !== endLocal.m || startLocal.d !== endLocal.d || startLocal.h + startLocal.min / 60 < work[0] || endLocal.h + endLocal.min / 60 > work[1]) return { ok: false, text: `${j.summary} must fit inside working hours on one day.` }
  if (!freeFor(ws, j, new Date(startMs).toISOString(), new Date(endMs).toISOString())) return { ok: false, text: 'The customer is not free then. Choose another time.' }
  const clash = clashes(ws, startMs, endMs, jobId)[0]
  if (clash) return { ok: false, clash, text: `${j.summary} clashes with ${customer(ws, clash.customerId)?.name || 'customer'}'s ${clash.summary}.` }
  j.start = new Date(startMs).toISOString()
  j.end = new Date(endMs).toISOString()
  for (const hold of ws.holds) {
    if (hold.jobId === jobId && !hold.ended) { hold.start = j.start; hold.end = j.end }
  }
  for (const offer of Object.values(ws.offers)) {
    if (offer.jobId !== jobId || offer.accepted) continue
    offer.start = j.start
    offer.end = j.end
    offer.reason = availabilityReason(ws, j, j.start)
    const draft = ws.drafts[offer.draftId]
    if (draft) draft.summary = `Deposit to hold ${slotLabel(ws, j.start)}`
  }
  return { ok: true, text: `Moved ${j.summary} to ${slotLabel(ws, startMs)}.` }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A local time as people say it, for example "Tue 3 Nov 9:00". @param {any} ws @param {string|number} at */
export function slotLabel(ws, at) {
  const d = new Date((typeof at === 'number' ? at : Date.parse(at)) + ws.tz * 60_000)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
