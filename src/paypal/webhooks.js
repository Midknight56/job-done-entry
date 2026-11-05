// @ts-check
// The PayPal webhook receiver, following PayPal's webhook guidance:
// read the raw body once; refuse a delivery without the five signature headers; ask PayPal to verify the signature
// with the raw event placed inside the request unchanged; skip an event id already handled; drop an invoice that is
// not ours (other apps share the sandbox app); save the workspace change before answering success.

import { getInvoice } from './invoices.js'
import { createPayPal } from './client.js'
import { applyStatus } from '../state/money.js'
import { pushPanel } from '../state/workspace.js'
import { loadWs, saveWs } from '../store.js'

const HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']
const STATUS_BY_EVENT = {
  'INVOICING.INVOICE.PAID': 'PAID',
  'INVOICING.INVOICE.CANCELLED': 'CANCELLED',
  'INVOICING.INVOICE.REFUNDED': 'REFUNDED',
}

/**
 * The money state an invoicing event reports. A PAID event also comes for a part payment and for a pending one, so the
 * invoice's own status inside the signed event decides those; the amounts come from the same invoice.
 * @param {any} event @returns {{ status?: string, due?: string, paid?: string, tip?: string, refunded?: string }}
 */
export function paymentOf(event) {
  const inv = event?.resource?.invoice || event?.resource || {}
  let status = STATUS_BY_EVENT[event?.event_type]
  if (status === 'PAID' && (inv.status === 'PARTIALLY_PAID' || inv.status === 'PAYMENT_PENDING')) status = inv.status
  if (status === 'REFUNDED') status = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(inv.status) ? inv.status : undefined
  if (!status && event?.event_type === 'INVOICING.INVOICE.UPDATED') status = inv.status
  return { status, due: inv.due_amount?.value, paid: inv.payments?.paid_amount?.value, tip: inv.gratuity?.value, refunded: inv.refunds?.refund_amount?.value }
}

/**
 * The invoice id in an invoicing event. A real INVOICING.INVOICE.PAID event (23 Oct 2026) nests it at resource.invoice.id;
 * PayPal's simulated sample has it at resource.id. Both are read.
 */
export function invoiceIdOf(event) {
  return event?.resource?.invoice?.id || event?.resource?.id || null
}

/**
 * @param {Request} request @param {any} env @param {{ waitUntil: (p: Promise<any>) => void }} ctx
 * @param {{ fetch?: typeof fetch, now?: () => number, verifyTimeoutMs?: number }} [deps]
 */
export async function handleWebhook(request, env, ctx, deps = {}) {
  const now = deps.now || Date.now
  const length = Number(request.headers.get('content-length'))
  if (length > 1_000_000) return new Response('body too large', { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 1_000_000) return new Response('body too large', { status: 413 })
  const h = Object.fromEntries(HEADERS.map((k) => [k, request.headers.get(k)]))
  if (HEADERS.some((k) => !h[k])) return new Response('missing PayPal headers', { status: 400 })
  if (!env.PAYPAL_WEBHOOK_ID) return new Response('webhook id not set', { status: 503 })
  let event
  try { event = JSON.parse(raw) } catch { return new Response('not JSON', { status: 400 }) }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return new Response('invalid event', { status: 400 })
  if (typeof event.id !== 'string' || !event.id) return new Response('event id missing', { status: 400 })

  const resourceId = event?.resource?.id
  const nestedInvoiceId = event?.resource?.invoice?.id
  if (resourceId && nestedInvoiceId && resourceId !== nestedInvoiceId) return new Response('ok', { status: 200 })
  const invoiceId = invoiceIdOf(event)

  // The verify body is built as text so the event's bytes are exactly the ones PayPal signed.
  const body = '{' + [
    `"auth_algo":${JSON.stringify(h['paypal-auth-algo'])}`,
    `"cert_url":${JSON.stringify(h['paypal-cert-url'])}`,
    `"transmission_id":${JSON.stringify(h['paypal-transmission-id'])}`,
    `"transmission_sig":${JSON.stringify(h['paypal-transmission-sig'])}`,
    `"transmission_time":${JSON.stringify(h['paypal-transmission-time'])}`,
    `"webhook_id":${JSON.stringify(env.PAYPAL_WEBHOOK_ID)}`,
    `"webhook_event":${raw}`,
  ].join(',') + '}'
  const panel = []
  const api = createPayPal(env, { fetch: deps.fetch, now, log: (e) => panel.push(e) })
  const t = now()
  let timer
  const res = await Promise.race([
    api.request({ method: 'POST', path: '/v1/notifications/verify-webhook-signature', body, requestId: `jd-verify-${h['paypal-transmission-id']}` }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.verifyTimeoutMs ?? 15_000) }),
  ])
  clearTimeout(timer)
  if (!res) return new Response('verification timed out', { status: 503 })
  if (!res.ok) return new Response('verification unavailable', { status: 503 })
  const verdict = res.json?.verification_status || 'INVALID RESPONSE'

  if (verdict !== 'SUCCESS') {
    const wid = invoiceId ? await env.JOBDONE.get(`inv:${invoiceId}`) : null
    if (wid) {
      try { await note(env, wid, { kind: 'guard', at: now(), text: `Webhook ${event.event_type || ''} refused: signature ${verdict}`, status: 400, id: invoiceId }) } catch {}
    }
    return new Response('signature not verified', { status: 400 })
  }
  const wid = invoiceId ? await env.JOBDONE.get(`inv:${invoiceId}`) : null
  let payment = paymentOf(event)
  if (wid && event.event_type === 'INVOICING.INVOICE.REFUNDED' && (!payment.status || (payment.status === 'PARTIALLY_REFUNDED' && (!payment.refunded || !payment.paid || payment.due == null)))) {
    try { payment = await getInvoice(api, invoiceId) } catch { return new Response('refund details unavailable', { status: 503 }) }
    if (!['REFUNDED', 'PARTIALLY_REFUNDED'].includes(payment.status) || (payment.status === 'PARTIALLY_REFUNDED' && (!payment.refunded || !payment.paid || payment.due == null))) return new Response('refund details unresolved', { status: 503 })
  }
  const { status, due, paid, tip, refunded } = payment
  if (!wid || !status) return new Response('ok', { status: 200 })

  const seen = await env.JOBDONE.get(`evt:${event.id}`)
  if (seen) return new Response('ok', { status: 200 })

  const update = (async () => {
    try {
      if (env.WORKSPACE) {
        const object = env.WORKSPACE.get(env.WORKSPACE.idFromName(wid))
        const updated = await object.fetch(new Request('https://do.internal/internal/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            wid,
            invoiceId,
            eventId: event.id,
            status,
            due,
            paid,
            tip,
            refunded,
            now: now(),
            entry: { kind: 'webhook', at: now(), method: 'POST', path: '/webhooks/paypal', status: 200, id: invoiceId, ms: now() - t, text: `${event.event_type}, signature ${verdict}` },
          }),
        }))
        if (!updated.ok) return new Response('workspace update failed', { status: 503 })
      } else {
        const ws = await loadWs(env, wid)
        if (!ws) return new Response('workspace unavailable', { status: 503 })
        applyStatus(ws, invoiceId, status, now(), { due, paid, tip, refunded, source: 'webhook' })
        pushPanel(ws, { kind: 'webhook', at: now(), method: 'POST', path: '/webhooks/paypal', status: 200, id: invoiceId, ms: now() - t, text: `${event.event_type}, signature ${verdict}` })
        await saveWs(env, ws)
      }
      await env.JOBDONE.put(`evt:${event.id}`, '1', { expirationTtl: 7 * 86_400 })
      return new Response('ok', { status: 200 })
    } catch {
      return new Response('workspace update failed', { status: 503 })
    }
  })()
  return update
}

/** A guard line in the owner's panel, for a refused delivery about one of our invoices. */
async function note(env, wid, entry) {
  if (env.WORKSPACE) {
    const object = env.WORKSPACE.get(env.WORKSPACE.idFromName(wid))
    await object.fetch(new Request('https://do.internal/internal/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wid, kind: 'guard', entry }),
    }))
    return
  }
  const ws = await loadWs(env, wid)
  if (!ws) return
  pushPanel(ws, entry)
  await saveWs(env, ws)
}
