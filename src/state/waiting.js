// @ts-check
import { customer, job, localDate, nextId, pushNotice } from './workspace.js'

/** @param {string} message @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'waiting', status: 422 })
}

/** @param {any} free */
export function validFree(free) {
  return ['any', 'mornings', 'afternoons'].includes(free) ||
    (Array.isArray(free) && free.length > 0 && free.every((day) => Number.isInteger(day) && day >= 1 && day <= 5))
}

/** Checks all fields before changing workspace state. @param {any} ws @param {any} fields */
function checked(ws, fields) {
  if (!customer(ws, fields?.customerId)) invalid('Choose a customer.')
  if (typeof fields?.summary !== 'string' || !fields.summary.trim() || fields.summary.length > 80) invalid('Summary must be 1 to 80 characters.')
  if (typeof fields.hours !== 'number' || !Number.isFinite(fields.hours) || fields.hours < 0.5 || fields.hours > 8 || !Number.isInteger(fields.hours * 2)) invalid('Hours must be 0.5 to 8 in half hours.')
  const free = fields.free === undefined ? 'any' : fields.free
  if (!validFree(free)) invalid('Choose when the customer is free.')
  return { customerId: fields.customerId, summary: fields.summary.trim(), hours: fields.hours, free: Array.isArray(free) ? [...new Set(free)].sort() : free }
}

/** @param {any} ws @param {any} fields */
export function addWaiting(ws, fields) {
  const values = checked(ws, fields)
  if (ws.waiting.length >= 10) invalid('The waiting list holds at most 10 jobs.')
  let id = nextId(ws, 'j')
  while (job(ws, id)) id = nextId(ws, 'j')
  const added = { id, ...values, start: '', end: '', state: 'waiting' }
  ws.jobs.push(added)
  ws.waiting.push(id)
  const person = customer(ws, values.customerId)
  pushNotice(ws, { at: Date.now(), text: `${person.given || person.name.split(' ')[0]} is on the waiting list.` })
  return added
}

/** @param {any} ws @param {string} jobId */
function waitingJob(ws, jobId) {
  const found = job(ws, jobId)
  if (!found || found.state !== 'waiting' || !ws.waiting.includes(jobId)) invalid('That job is no longer on the waiting list.')
  return found
}

/** @param {any} ws @param {string} jobId @param {any} fields */
export function updateWaiting(ws, jobId, fields) {
  const found = waitingJob(ws, jobId)
  const values = checked(ws, { ...found, ...fields })
  Object.assign(found, values)
  return found
}

/** @param {any} ws @param {string} jobId */
export function removeWaiting(ws, jobId) {
  waitingJob(ws, jobId)
  ws.waiting = ws.waiting.filter((id) => id !== jobId)
  ws.jobs = ws.jobs.filter((item) => item.id !== jobId)
}

/** @param {any} ws @param {any} job @param {string} startIso @param {string} endIso */
export function freeFor(ws, job, startIso, endIso) {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
  const free = job.free === undefined ? 'any' : job.free
  if (free === 'any') return true
  const a = localDate(start, ws.tz)
  const b = localDate(end, ws.tz)
  if (a.y !== b.y || a.m !== b.m || a.d !== b.d) return false
  if (free === 'mornings') return end <= Date.UTC(a.y, a.m, a.d, 12) - ws.tz * 60_000
  if (free === 'afternoons') return a.h >= 12
  return Array.isArray(free) && free.includes(a.dow)
}

/** Refresh the availability explanation for an offered time. @param {any} ws @param {any} candidate @param {string} start */
export function availabilityReason(ws, candidate, start) {
  const person = customer(ws, candidate.customerId)
  const name = person?.given || person?.name.split(' ')[0] || 'This customer'
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][localDate(Date.parse(start), ws.tz).dow]
  const free = candidate.free || 'any'
  const when = free === 'mornings' || free === 'afternoons' ? `${day} ${free}` : `on ${day}`
  return `${name} fits ${candidate.hours} hours and is free ${when}.`
}
