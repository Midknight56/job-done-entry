import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const liveUrl = process.env.JD_LIVE_URL
const body = readFileSync(new URL('../fixtures/event-invoice-paid-sample.json', import.meta.url), 'utf8')

it.skipIf(!liveUrl)('refuses a simulated PayPal webhook without a valid signature', async () => {
  const headers = {
    'content-type': 'application/json',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-5edc0ebc',
    'paypal-transmission-id': randomUUID(),
    'paypal-transmission-sig': Buffer.from('invalid signature').toString('base64'),
    'paypal-transmission-time': new Date().toISOString(),
  }
  const send = (requestHeaders) => fetch(`${liveUrl.replace(/\/$/, '')}/webhooks/paypal`, {
    method: 'POST',
    headers: requestHeaders,
    body,
  })

  const refused = await send(headers)
  expect(refused.status).toBe(400)

  const missing = { ...headers }
  delete missing['paypal-transmission-sig']
  const refusedMissing = await send(missing)
  expect(refusedMissing.status).toBe(400)

  const health = await fetch(`${liveUrl.replace(/\/$/, '')}/health`)
  expect(health.status).toBe(200)
  expect((await health.json()).ok).toBe(true)
}, 60_000)
