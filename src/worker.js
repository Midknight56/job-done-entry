// @ts-check
// The Job Done Worker: the API the page calls, the PayPal webhook, the health check. Static files are served by
// Workers Static Assets from public/.

import * as caps from './caps.js'
import { createPayPal } from './paypal/client.js'
import { getInvoice, PayPalError, readAfterDueReminder, reminderPlan, remindInvoice } from './paypal/invoices.js'
import { handleWebhook } from './paypal/webhooks.js'
import { createBudget, d1Ledger } from './ai/budget.js'
import { runModel, BudgetError } from './ai/model.js'
import { transcribe } from './ai/whisper.js'
import { runTurn } from './agent/loop.js'
import { replayLines, replayModel } from './agent/replay.js'
import { devStubModel } from './agent/devstub.js'
import { proposeInvoiceDraft, sendDraft, setPaymentOptions, confirmInvoiceVisit, completeDraft } from './flows/send.js'
import { recordCashTap } from './flows/cash.js'
import { sendReminderTap, stopPayPalReminders } from './flows/reminders.js'
import { acceptRate } from './flows/rates.js'
import { priceLines } from './pricing/ratecard.js'
import { seedWorkspace, publicView, pushPanel, pushNotice, job, addCustomer } from './state/workspace.js'
import { WorkspaceDO } from './state/workspace-do.js'
import { CapsDO } from './state/caps-do.js'
import { moveJob } from './state/schedule.js'
import { acceptOffer, declineOffer, dropStaleDrafts, releaseExpired, sendDeposit } from './state/holds.js'
import { addWaiting, updateWaiting, removeWaiting } from './state/waiting.js'
import { applyStatus } from './state/money.js'
import { loadWs, saveWs, indexInvoice, loadCounter, reserveCaps } from './store.js'

const BUILD = 'dev'
const APP = 'job-done'
const COOKIE = 'jd_ws'
const DAY_TTL = 3 * 86_400
const IP_TTL = 2 * 86_400
const MAX_JSON_BYTES = 1_048_576
/** The most one agent turn can cost (three model calls), checked before a live turn starts. */
const TURN_WORST = caps.MAX_MODEL_CALLS * caps.stepWorstCase(caps.MAX_INPUT_CHARS, caps.MAX_OUTPUT_TOKENS)
/** Per isolate: when each watched invoice was last read from PayPal, so an open QR sheet reads it every 5 s at most. */
const lastWatch = new Map()

/** @param {any} body @param {number} [status] @param {Record<string, string>} [headers] */
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
/** @param {string} error @param {string} message @param {number} status */
const fail = (error, message, status) => json({ error, message }, status)

export default {
  /** @param {Request} request @param {any} env @param {ExecutionContext} ctx */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health/history') return healthHistory(env)
    if (url.pathname === '/health') {
      if (url.searchParams.get('deep') !== '1') return json({ ok: true, build: env.BUILD_HASH || BUILD })
      return json(await deepHealth(env), 200)
    }
    if (url.pathname === '/webhooks/paypal' && request.method === 'POST') return handleWebhook(request, env, ctx)
    if (url.pathname.startsWith('/api/')) {
      try {
        if (env.WORKSPACE && cookieWid(request) && !(request.method === 'POST' && url.pathname === '/api/workspace')) {
          const object = env.WORKSPACE.get(env.WORKSPACE.idFromName(cookieWid(request)))
          return await object.fetch(request)
        }
        return await api(request, env, ctx, url)
      } catch (e) {
        return errorResponse(e)
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
  },
  /** @param {ScheduledController} controller @param {any} env @param {ExecutionContext} ctx */
  async scheduled(controller, env, ctx) {
    try {
      const day = new Date(controller.scheduledTime).toISOString().slice(0, 10)
      await sendLateReminder(env, day)
      const monthDay = day.slice(5)
      if (monthDay < '12-01' || monthDay > '12-15') return
      let result
      try {
        result = await deepHealth(env, true)
      } catch (e) {
        result = {
          ok: false,
          build: env.BUILD_HASH || BUILD,
          paypal: healthError(e, env),
          lateInvoice: 'none',
          checkedAt: new Date(controller.scheduledTime).toISOString(),
        }
      }
      await env.JOBDONE.put(`health:${day}`, JSON.stringify(result), { expirationTtl: 40 * 86_400 })
    } catch {
      // A scheduled check must not fail the Worker event.
    }
  },
}

export { WorkspaceDO, CapsDO }

/** @param {any} env @param {string} day */
async function sendLateReminder(env, day) {
  try {
    const dates = String(env.LATE_REMINDER_DAYS || '').split(',').map((date) => date.trim())
    if (!dates.includes(day) || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return
    const invoiceId = await env.JOBDONE.get('seed:late-invoice')
    if (!invoiceId || await env.JOBDONE.get(`remind-done:${day}`)) return

    const paypal = createPayPal(env)
    try {
      const invoice = await getInvoice(paypal, invoiceId)
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(invoice.status)) return
    } catch (e) {
      // A read that finds nothing (404) leaves the decision to PayPal's remind call; any other failure stops this run.
      if (e?.status !== 404) throw e
    }
    await remindInvoice(paypal, invoiceId, {
      subject: 'A quick reminder',
      note: 'Just a quick reminder that this invoice is still due. Thank you.',
    }, `jd-late-remind-${day}`)
    const count = Number(await env.JOBDONE.get('seed:late-reminders')) || 0
    await env.JOBDONE.put('seed:late-reminders', String(count + 1))
    await env.JOBDONE.put(`remind-done:${day}`, '1', { expirationTtl: 60 * 86_400 })
  } catch {
    // A failed late reminder must not fail the scheduled Worker event.
  }
}

/** The last deep check, per isolate, so the check cannot be used to hammer PayPal. */
let lastDeep = { at: 0, body: null }

/**
 * For the judging weeks: can the Worker still mint a PayPal token and read the shared late invoice? Polled daily by
 * a scheduler; HTTP answers from a one minute cache while scheduled checks bypass it.
 * @param {any} env
 * @param {boolean} [bypassCache]
 */
async function deepHealth(env, bypassCache = false) {
  const age = Date.now() - lastDeep.at
  if (!bypassCache && lastDeep.body && age >= 0 && age < 60_000) return lastDeep.body
  const pp = createPayPal(env)
  const lateId = await env.JOBDONE.get('seed:late-invoice')
  let paypal = 'unknown'
  let late = 'none'
  try {
    if (lateId) {
      const inv = await getInvoice(pp, lateId)
      paypal = 'ok'
      late = inv.status
    } else {
      const res = await pp.request({ method: 'GET', path: '/v2/invoicing/invoices?page=1&page_size=1' })
      paypal = res.ok ? 'ok' : `HTTP ${res.status}`
    }
  } catch (e) {
    paypal = healthError(e, env)
  }
  // PayPal's own reminders: the account setting must match the numbers the page shows.
  let reminders = 'off'
  const plan = reminderPlan(env)
  if (plan && paypal === 'ok') {
    try {
      const live = await readAfterDueReminder(pp)
      reminders = live?.status === 'ACTIVE' && live.everyDays === plan.everyDays && live.times === plan.times ? 'ok' : `differs: PayPal has ${live ? `${live.status}, every ${live.everyDays} days, ${live.times} times` : 'none'}`
    } catch (e) {
      reminders = healthError(e, env)
    }
  }
  const body = { ok: paypal === 'ok', build: env.BUILD_HASH || BUILD, paypal, lateInvoice: late, reminders, checkedAt: new Date().toISOString() }
  lastDeep = { at: Date.now(), body }
  return body
}

/** @param {any} e @param {any} env */
function healthError(e, env) {
  if (e === null) return 'null'
  let message = String(e?.message || e)
  let redacted = false
  for (const [key, value] of Object.entries(env || {})) {
    if (/(secret|token|password|key)/i.test(key) && typeof value === 'string' && value && message.includes(value)) redacted = true
  }
  if (redacted) return '[redacted]'
  const status = Number(e?.status) || /HTTP (\d{3})/.exec(String(e?.message || ''))?.[1]
  return status ? `PayPal check failed (HTTP ${status}).` : 'PayPal check failed.'
}

/** @param {any} env */
async function healthHistory(env) {
  const { keys } = await env.JOBDONE.list({ prefix: 'health:' })
  const newest = keys.map((entry) => entry.name).sort((a, b) => b.localeCompare(a)).slice(0, 20)
  const records = await Promise.all(newest.map(async (key) => {
    const raw = await env.JOBDONE.get(key)
    if (!raw) return null
    try {
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const paypal = value.paypal === 'ok' ? 'ok' : /^HTTP \d{3}$/.test(value.paypal) ? value.paypal : 'failed'
      const lateInvoice = ['none', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'REFUNDED', 'MARKED_AS_PAID'].includes(value.lateInvoice) ? value.lateInvoice : 'unknown'
      return {
        day: key.slice('health:'.length),
        ok: Boolean(value.ok),
        paypal,
        lateInvoice,
        checkedAt: typeof value.checkedAt === 'string' && (Number.isFinite(Date.parse(value.checkedAt)) || value.checkedAt === 'now') ? value.checkedAt : null,
      }
    } catch {
      return null
    }
  }))
  return json(records.filter(Boolean))
}

/** @param {any} e */
export function errorResponse(e) {
  if (e instanceof PayPalError) return json({ error: 'paypal', message: `PayPal answered ${e.status}${e.errorName ? ' ' + e.errorName : ''}${e.debugId ? ', debug id ' + e.debugId : ''}.` }, 502)
  if (e instanceof BudgetError) return json({ error: 'budget', message: "Today's free AI budget is used up.", replay: true }, 429)
  if (e?.code && e?.status) return json({ error: String(e.code).toLowerCase(), message: e.message }, e.status)
  console.error('unhandled', e?.message || e)
  return fail('server', 'Something went wrong. Try again.', 500)
}

/** @param {string} text */
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** @param {Request} request */
function cookieWid(request) {
  const m = /(?:^|;\s*)jd_ws=([a-z0-9]{1,40})(?=;|$)/.exec(request.headers.get('cookie') || '')
  return m ? m[1] : null
}

/** @param {Request} request @param {any} env */
function maintainerRequest(request, env) {
  const token = env.MAINTAINER_TOKEN
  if (typeof token !== 'string' || token.length < 32) return false
  const match = /(?:^|;\s*)jd_maint=([^;]*)/.exec(request.headers.get('cookie') || '')
  const supplied = match?.[1]
  if (supplied === undefined || supplied.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ supplied.charCodeAt(i)
  return diff === 0
}

/**
 * @param {Request} request @param {any} env @param {ExecutionContext} ctx @param {URL} url
 */
export async function api(request, env, ctx, url) {
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const maintainer = maintainerRequest(request, env)
  const extraMatch = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(String(env.EXTRA_NEURONS || ''))
  const extraDate = extraMatch ? new Date(`${extraMatch[1]}T00:00:00.000Z`) : null
  const extraNeurons = extraMatch && extraDate && Number.isFinite(extraDate.getTime()) && extraDate.toISOString().slice(0, 10) === extraMatch[1] && extraMatch[1] === day ? Number(extraMatch[2]) : 0
  const dailyLimit = caps.DAILY_NEURONS + (Number.isSafeInteger(extraNeurons) ? extraNeurons : 0)
  // Local test runs (stand in model, localhost only) may name their own visitor with a jd_test cookie, so repeated
  // runs do not share one visitor's daily caps. The hosted app never reads it.
  const testIpAllowed = env.MODEL_STUB === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)
  const testIp = testIpAllowed
    ? /(?:^|;\s*)jd_test=([\w-]+)/.exec(request.headers.get('cookie') || '')?.[1] || null
    : null
  // In a local test run each demo workspace counts as its own visitor, so a whole test suite never meets the caps.
  const testVisitor = testIp ? `${testIp}:${cookieWid(request) || 'new'}` : null
  const ipKey = await sha((testVisitor || request.headers.get('cf-connecting-ip') || 'local') + (env.IP_SALT || ''))
  const visitor = testVisitor || cookieWid(request) || request.headers.get('cf-connecting-ip') || 'local'
  const visitorField = `visitor:${await sha(visitor + (env.IP_SALT || ''))}`
  const visitorNeuronsField = `${visitorField}:neurons`
  const visitorInvoicesField = `${visitorField}:invoices`
  const ipCounterKey = `cap:ip:${ipKey}:${day}`
  const dayCounterKey = testVisitor ? `cap:day:${day}:${testVisitor}` : `cap:day:${day}`
  let ipC
  let dayC
  try {
    ipC = await loadCounter(env, ipCounterKey)
    dayC = await loadCounter(env, dayCounterKey)
    for (const counter of [ipC, dayC]) {
      if (!counter.value || typeof counter.value !== 'object' || Array.isArray(counter.value) || Object.values(counter.value).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw Object.assign(new Error('Invalid counter'), { code: 'INVALID_COUNTER' })
    }
  } catch (e) {
    if (e instanceof SyntaxError || e?.code === 'INVALID_COUNTER') return fail('storage', 'This demo is temporarily unavailable. Try again later.', 503)
    throw e
  }
  const flush = async () => { await ipC.flush(IP_TTL); await dayC.flush(DAY_TTL) }
  /** @param {import('./store.js').CapItem[]} dayItems @param {import('./store.js').CapItem[]} ipItems */
  const reserve = (dayItems, ipItems) => reserveCaps(env, dayCounterKey, ipCounterKey, dayC, ipC, dayItems, ipItems)
  let costs = false
  /** @param {any} ws */
  const client = (ws) => {
    const pp = paypal(env, ws)
    return { request: async (request) => {
      const response = await pp.request(request)
      if (request.method === 'POST' && response.ok) costs = true
      return response
    } }
  }
  // Without the shared ledger no AI call may be made (every call on the account must be counted), so the budget
  // refuses every charge; the free checks on a request (size, format, length) still answer first.
  // Visitor counters retain reservations and receive any upward correction through serialized shared writes.
  const visitorUsage = {
    get: async () => {
      if (!env.CAPS) return Math.max(ipC.get('neurons'), dayC.get(visitorNeuronsField))
      const read = async key => {
        const response = await env.CAPS.get(env.CAPS.idFromName(key)).fetch(new Request('https://do.internal/read'))
        if (!response.ok) throw new Error('Shared counter unavailable')
        return response.json()
      }
      const [ip, shared] = await Promise.all([read(ipCounterKey), read(dayCounterKey)])
      return Math.max(ip.neurons || 0, shared[visitorNeuronsField] || 0)
    },
    add: async (_key, n) => {
      await reserve([{ field: visitorNeuronsField, n, limit: Infinity }], [{ field: 'neurons', n, limit: Infinity }])
      return visitorUsage.get()
    },
  }
  /** @type {any} */
  const budget = env.LEDGER
    ? createBudget({ ledger: d1Ledger(env.LEDGER), perIp: visitorUsage, app: APP, dailyLimit, ipLimit: maintainer ? Infinity : caps.PER_IP_NEURONS })
    : { charge: async () => ({ ok: false, reason: 'ledger' }), left: async () => ({ app: 0, ip: 0, account: 0 }), stub: Boolean(testIpAllowed) }
  const { method } = request
  const path = url.pathname

  if (method === 'POST' && path === '/api/workspace') {
    // A local test run (stand in model, localhost only) starts a demo per test, so it never meets this cap.
    const body = await readJson(request)
    // The count under this name started 5 Nov 2026.
    const workspaceItem = maintainer
      ? { field: 'maintainerDemos', n: 1, limit: caps.DAILY_MAINTAINER_WORKSPACES }
      : { field: 'demos', n: 1, limit: testIp ? Infinity : caps.DAILY_WORKSPACES }
    const reservation = await reserve([
      workspaceItem,
      { field: 'actions', n: 1, limit: Infinity },
    ], [{ field: 'actions', n: 1, limit: Infinity }])
    if (!reservation.ok) return fail('busy', reservation.field === 'demos' || reservation.field === 'maintainerDemos' ? 'Too many demos were started today. Try again tomorrow.' : 'That is enough for today. Try again tomorrow.', 429)
    let saved = false
    try {
      const tz = Math.max(-840, Math.min(840, Math.round(Number(body.tz) || 0)))
      const wid = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const ws = seedWorkspace({ id: wid, now, tzOffsetMinutes: tz })
      const pp = client(ws)
      await seedMoney(ws, env, pp, now)
      await saveWs(env, ws)
      saved = true
      await flush()
      return json(await stateOf(ws, budget, ipKey, day, now, env), 200, { 'set-cookie': `${COOKIE}=${wid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` })
    } finally {
      if (!saved && !costs) { await reservation.release(); await flush() }
    }
  }

  const ws = await loadWs(env, cookieWid(request))
  if (!ws) return fail('no_workspace', 'Start a demo first.', 404)
  const before = JSON.stringify(ws)
  const pp = client(ws)

  if (method === 'GET' && path === '/api/state') {
    dropStaleDrafts(ws, now)
    if (ws.holds.some((h) => !h.ended && h.expiresAt <= now)) await releaseExpired(ws, { api: pp, now })
    const watch = url.searchParams.get('watch')
    if (watch && ws.invoices[watch] && !ws.invoices[watch].shared && (lastWatch.get(watch) || 0) < now - 5000) {
      lastWatch.set(watch, now)
      try {
        const live = await getInvoice(pp, watch)
        applyStatus(ws, watch, live.status, now, { due: live.due, paid: live.paid, tip: live.tip, refunded: live.refunded, source: 'status poll' })
      } catch { /* the panel shows the failed read */ }
    }
    if (JSON.stringify(ws) !== before) await saveWs(env, ws)
    return json(await stateOf(ws, budget, ipKey, day, now, env))
  }

  if (method === 'GET' && path.startsWith('/api/qr/')) {
    const inv = ws.invoices[path.slice('/api/qr/'.length)]
    if (!inv || !inv.qr || inv.shared) return fail('not_found', 'No QR code for that invoice.', 404)
    const bytes = Uint8Array.from(atob(inv.qr), (c) => c.charCodeAt(0))
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } })
  }

  if (method !== 'POST') return fail('not_found', 'No such call.', 404)
  const draftMatch = /^\/api\/drafts\/([a-z0-9]+)\/send$/.exec(path)
  const offerMatch = /^\/api\/offers\/([a-z0-9]+)\/accept$/.exec(path)
  const sendingOffer = offerMatch ? ws.offers[offerMatch[1]] : null
  const sendingDraft = draftMatch ? ws.drafts[draftMatch[1]] : sendingOffer ? ws.drafts[sendingOffer.draftId] : null
  const invoiceNeeded = Boolean(sendingDraft && !sendingDraft.invoiceId && !sendingOffer?.accepted)
  const dayItems = [
    { field: 'actions', n: 1, limit: caps.DAILY_ACTIONS },
    { field: visitorField, n: 1, limit: maintainer ? Infinity : caps.PER_IP_ACTIONS },
  ]
  const ipItems = [{ field: 'actions', n: 1, limit: maintainer ? Infinity : caps.PER_IP_ACTIONS }]
  if (invoiceNeeded) {
    dayItems.push({ field: 'invoices', n: 1, limit: caps.DAILY_INVOICES }, { field: visitorInvoicesField, n: 1, limit: maintainer ? Infinity : caps.PER_IP_INVOICES })
    ipItems.push({ field: 'invoices', n: 1, limit: maintainer ? Infinity : caps.PER_IP_INVOICES })
  }
  const reservation = await reserve(dayItems, ipItems)
  if (!reservation.ok) return fail('busy', reservation.field === 'invoices' || reservation.field === visitorInvoicesField ? 'That is enough invoices for today. Try again tomorrow.' : 'That is enough for today. Try again tomorrow.', 429)
  let saved = false
  const charge = budget.charge.bind(budget)
  budget.charge = async (...args) => {
    const result = await charge(...args)
    if (result.ok) costs = true
    return result
  }
  try {

    /** @type {Record<string, any>} */
    let extra = {}
    let m
    if (path === '/api/voice') {
      const declared = Number(request.headers.get('content-length') || 0)
      if (declared > caps.MAX_AUDIO_BYTES) return fail('too_long', 'Keep it under 30 seconds.', 413)
      const bytes = new Uint8Array(await request.arrayBuffer())
      try {
        const out = await transcribe({ ai: env.AI, budget, ipKey, day, bytes })
        pushPanel(ws, { kind: 'model', at: now, method: 'AI', path: 'whisper-large-v3-turbo', status: 200, neurons: round(out.neurons), text: `${out.seconds.toFixed(1)} s of speech` })
        extra = { text: out.text }
      } catch (e) {
        await flush()
        if (e?.status === 413) return fail('too_long', 'Keep it under 30 seconds.', 413)
        if (e?.status === 415) return fail('format', 'That recording could not be read. Type it instead.', 415)
        if (e instanceof BudgetError && e.reason === 'ledger') return fail('budget', 'Speech needs the AI ledger. Type it instead.', 503)
        if (e instanceof BudgetError) return json({ error: 'budget', message: "Today's free AI budget is used up. Type it instead.", replay: true }, 429)
        throw e
      }
    } else if (path === '/api/customers') {
      addCustomer(ws, await readJson(request), env)
    } else if (path === '/api/agent') {
      const body = await readJson(request)
      const text = (typeof body.text === 'string' ? body.text : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 500)
      if (!text) return fail('empty', 'Say or type what you did.', 422)
      const left = await budget.left({ ipKey, day })
      // With no ledger bound, left is 0 and the turn is answered from recordings: every AI call must be counted.
      const live = left.app >= TURN_WORST && left.ip >= TURN_WORST && left.account >= TURN_WORST && env.AI
      const stub = env.MODEL_STUB === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)
      let replayed = !live && !stub
      let callModel = stub
        ? devStubModel(text)
        : live
          ? async (messages) => runModel({ ai: env.AI, budget, ipKey, day, messages })
          : replayModel(text)
      if (!callModel) {
        await flush()
        return json({ proposal: null, replay: true, message: "Today's free AI budget is used up. Try one of the recorded demo lines.", lines: replayLines(), state: await stateOf(ws, budget, ipKey, day, now, env) })
      }
      let turn
      try {
        turn = await runTurn(ws, text, { callModel, now, api: pp })
      } catch (e) {
        if (!(e instanceof BudgetError)) throw e
        const replay = replayModel(text)
        if (!replay) {
          await flush()
          return json({ proposal: null, replay: true, message: "Today's free AI budget is used up. Try one of the recorded demo lines.", lines: replayLines(), state: await stateOf(ws, budget, ipKey, day, now, env) })
        }
        turn = await runTurn(ws, text, { callModel: replay, now, api: pp })
        replayed = true
      }
      for (const s of turn.steps) {
        if (s.kind === 'model') pushPanel(ws, { kind: 'model', at: now, method: 'AI', path: stub ? 'development stub' : replayed ? 'recorded output' : 'qwen3-30b-a3b-fp8', status: 200, ms: s.ms, neurons: round(s.neurons) })
        else if (s.kind === 'tool') pushPanel(ws, { kind: 'tool', at: now, path: s.name, status: s.ok ? 200 : 422, ms: s.ms })
        else if (s.kind === 'guard') pushPanel(ws, { kind: 'guard', at: now, path: 'drop rule', status: s.result.startsWith('dropped') ? 422 : 200, text: s.result })
      }
      if (turn.proposal?.kind === 'new_customer') turn.proposal.text = text
      extra = { proposal: turn.proposal, message: turn.message, replay: replayed }
      // While replay samples are recorded (RECORD_SAMPLES is set only for that run), the raw replies come back too.
      if (env.RECORD_SAMPLES === '1' && !replayed && !stub) extra.recorded = { outputs: turn.outputs, charged: round(turn.neurons), actual: round(turn.actual), steps: turn.steps }
    } else if ((m = /^\/api\/drafts\/([a-z0-9]+)\/visit$/.exec(path))) {
      const visit = confirmInvoiceVisit(ws, m[1], await readJson(request), now)
      extra = { visit, draft: ws.drafts[m[1]] }
    } else if ((m = /^\/api\/drafts\/([a-z0-9]+)\/complete$/.exec(path))) {
      extra = await completeDraft(ws, m[1], await readJson(request), { api: pp, now })
    } else if ((m = /^\/api\/drafts\/([a-z0-9]+)\/send$/.exec(path))) {
      const draft = ws.drafts[m[1]]
      if (!draft) return fail('not_found', 'That draft is gone. Say it again.', 404)
      if (!draft.invoiceId) {
        // The draft card's ticks: let the customer add a tip, and let them pay part now.
        const choice = await readJson(request)
        setPaymentOptions(draft, { tip: choice?.tip === true, part: choice?.part === true }, ws.settings.rateCard)
      }
      let out
      try {
        out = draft.kind === 'deposit' ? await sendDeposit(ws, draft.id, { api: pp, env, now }) : await sendDraft(ws, draft.id, { api: pp, env, now })
      } catch (e) {
        if (draft.invoiceId) {
          await saveWs(env, ws)
          await flush()
        }
        throw e
      }
      await indexInvoice(env, out.invoiceId, ws.id)
      extra = { invoiceId: out.invoiceId }
    } else if ((m = /^\/api\/invoices\/([A-Z0-9-]+)\/cash$/.exec(path))) {
      const body = await readJson(request)
      await recordCashTap(ws, m[1], String(body.amount || ''), { api: pp, now })
    } else if ((m = /^\/api\/invoices\/([A-Z0-9-]+)\/remind$/.exec(path))) {
      const body = await readJson(request)
      await sendReminderTap(ws, m[1], String(body.text || ''), { api: pp, now })
    } else if ((m = /^\/api\/invoices\/([A-Z0-9-]+)\/stop-reminders$/.exec(path))) {
      await stopPayPalReminders(ws, m[1], { api: pp, now })
    } else if ((m = /^\/api\/rates\/([a-z0-9]+)\/accept$/.exec(path))) {
      // The one tap rate change: only a rate code read from the words can reach the card.
      extra = acceptRate(ws, m[1])
    } else if (path === '/api/waiting') {
      addWaiting(ws, await readJson(request))
    } else if ((m = /^\/api\/waiting\/([a-z0-9]+)\/remove$/.exec(path))) {
      removeWaiting(ws, m[1])
    } else if ((m = /^\/api\/waiting\/([a-z0-9]+)$/.exec(path))) {
      updateWaiting(ws, m[1], await readJson(request))
    } else if ((m = /^\/api\/offers\/([a-z0-9]+)\/decline$/.exec(path))) {
      declineOffer(ws, m[1], now)
    } else if ((m = /^\/api\/offers\/([a-z0-9]+)\/accept$/.exec(path))) {
      const offer = ws.offers[m[1]]
      if (!offer) return fail('not_found', 'That offer is gone.', 404)
      try {
        await acceptOffer(ws, offer.id, { api: pp, env, now })
      } catch (error) {
        if (sendingDraft?.invoiceId) { await saveWs(env, ws); await flush() }
        throw error
      }
      const j = job(ws, offer.jobId)
      if (j?.depositInvoiceId) {
        await indexInvoice(env, j.depositInvoiceId, ws.id)
        extra = { invoiceId: j.depositInvoiceId }
      }
    } else if ((m = /^\/api\/holds\/([a-z0-9]+)\/expire$/.exec(path))) {
      const hold = ws.holds.find((item) => item.jobId === m[1] && !item.ended)
      if (!hold) {
        await flush()
        return fail('not_found', 'That hold is gone.', 404)
      }
      if (ws.settings.holdMinutes !== 2) {
        await flush()
        return fail('not_demo', 'Only demo holds can be run out early.', 409)
      }
      hold.expiresAt = now
      await releaseExpired(ws, { api: pp, now })
    } else if (path === '/api/schedule/move') {
      const body = await readJson(request)
      if (!job(ws, String(body.jobId)) || Number.isNaN(Date.parse(String(body.start)))) return fail('bad', 'That move could not be read.', 422)
      const r = moveJob(ws, String(body.jobId), String(body.start), now)
      pushNotice(ws, { at: now, kind: 'move', text: r.ok ? r.text : `${r.text} Kept where it was.` })
      extra = { ok: r.ok, text: r.text }
    } else if (path === '/api/settings') {
      const body = await readJson(request)
      if (body.holdMinutes === 2 || body.holdMinutes === 1440) ws.settings.holdMinutes = body.holdMinutes
    } else {
      return fail('not_found', 'No such call.', 404)
    }

    await saveWs(env, ws)
    saved = true
    await flush()
    return json({ ...extra, state: await stateOf(ws, budget, ipKey, day, now, env) })
  } finally {
    if (!saved && !costs) {
      await reservation.release()
    } else if (invoiceNeeded && !sendingDraft.invoiceId) {
      await reservation.release('invoices')
    }
    await flush()
  }
}

/** @param {number} n */
const round = (n) => Math.round(n * 100) / 100

/** @param {Request} request */
async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_JSON_BYTES) throw Object.assign(new Error('Request body is too large.'), { code: 'too_large', status: 413 })
  const reader = request.body?.getReader()
  const chunks = []
  let size = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_JSON_BYTES) {
        await reader.cancel()
        throw Object.assign(new Error('Request body is too large.'), { code: 'too_large', status: 413 })
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

/** A PayPal client whose calls become panel entries in this workspace. @param {any} env @param {any} ws */
export function paypal(env, ws) {
  return createPayPal(env, {
    log: (e) => {
      const id = /\/invoices\/([A-Z0-9-]+)/.exec(e.path)?.[1]
      pushPanel(ws, { ...e, ...(id ? { id } : {}) })
    },
  })
}

/** @param {any} ws @param {any} budget @param {string} ipKey @param {string} day @param {number} now */
async function stateOf(ws, budget, ipKey, day, now, env) {
  const left = await budget.left({ ipKey, day })
  const view = publicView(ws)
  view.invoices = Object.fromEntries(Object.entries(view.invoices).map(([k, v]) => [k, { ...v, qr: undefined, hasQr: Boolean(v.qr) }]))
  return {
    now,
    cursor: ws.cursor,
    ws: view,
    reminders: reminderPlan(env),
    // The replay bar is not shown when a local stand in answers instead of the model.
    budget: { replay: !budget.stub && (left.app < TURN_WORST || left.ip < TURN_WORST || left.account < TURN_WORST), appLeft: Math.floor(left.app), ipLeft: Math.floor(left.ip) },
  }
}

/**
 * Money every new demo starts with: Dave's open invoice from yesterday's leak repair (created and sent now, so the
 * cash scene records a payment on a real sandbox invoice), and Sam's real 340.00 invoice sent on 24 Oct 2026, which
 * every demo shares and which no demo may pay.
 * @param {any} ws @param {any} env @param {any} pp @param {number} now
 */
async function seedMoney(ws, env, pp, now) {
  try {
    const priced = priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 0.5, description: 'Leak repair' }, { kind: 'part', description: 'Washer kit', cost: 12.5 }], ws.settings.rateCard)
    const draft = proposeInvoiceDraft(ws, { customerId: 'c2', priced, summary: 'Leak repair', jobId: 'j1' })
    const out = await sendDraft(ws, draft.id, { api: pp, env, now })
    await indexInvoice(env, out.invoiceId, ws.id)
    ws.notices = []
    if (!ws.invoices[out.invoiceId]?.qr) {
      pushNotice(ws, { at: now, text: 'PayPal could not make a QR code for the demo invoice. The invoice is still ready.' })
    }
  } catch (e) {
    pushNotice(ws, { at: now, text: 'Could not reach PayPal for the demo invoices. Try a fresh demo in a minute.' })
  }
  try {
    const lateId = await env.JOBDONE.get('seed:late-invoice')
    if (!lateId) return
    const live = await getInvoice(pp, lateId)
    ws.invoices[lateId] = {
      id: lateId, customerId: 'c3', kind: 'invoice', total: live.total, due: live.due, status: live.status,
      sentAt: Date.parse(live.sentAt || '') || now, reminders: Number(await env.JOBDONE.get('seed:late-reminders')) || 0, shared: true,
    }
  } catch {
    pushNotice(ws, { at: now, text: 'Could not reach PayPal for the shared late invoice. The rest of the demo is ready.' })
  }
}
