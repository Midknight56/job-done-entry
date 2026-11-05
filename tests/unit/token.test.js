import { describe, it, expect, beforeEach } from 'vitest'
import { getToken, resetTokenCache } from '../../src/paypal/token.js'
import { createPayPal } from '../../src/paypal/client.js'
import { fakePayPal, ENV } from './fake-paypal.js'

beforeEach(() => resetTokenCache())

describe('token cache', () => {
  it('a second call inside expiry makes no token fetch', async () => {
    const pp = fakePayPal()
    let t = 1_000_000
    const a = await getToken(ENV, { fetch: pp.fetch, now: () => t })
    t += 60_000
    const b = await getToken(ENV, { fetch: pp.fetch, now: () => t })
    expect(a).toBe(b)
    expect(pp.tokenFetches()).toBe(1)
  })

  it('reads expires_in and refreshes when under 300 s remain', async () => {
    const pp = fakePayPal({ 'POST /v1/oauth2/token': [{ status: 200, body: { access_token: 'short', expires_in: 400 } }, { status: 200, body: { access_token: 'next', expires_in: 400 } }] })
    let t = 0
    expect(await getToken(ENV, { fetch: pp.fetch, now: () => t })).toBe('short')
    t = 99_000
    expect(await getToken(ENV, { fetch: pp.fetch, now: () => t })).toBe('short')
    t = 101_000
    expect(await getToken(ENV, { fetch: pp.fetch, now: () => t })).toBe('next')
    expect(pp.tokenFetches()).toBe(2)
  })

  it('sends HTTP Basic with the client id and secret and the client credentials grant', async () => {
    const pp = fakePayPal()
    await getToken(ENV, { fetch: pp.fetch })
    const call = pp.calls[0]
    expect(call.headers.get('authorization')).toBe('Basic ' + btoa('id-x:secret-y'))
    expect(String(call.body)).toBe('grant_type=client_credentials')
  })

  it('a token failure throws without the secret in the message', async () => {
    const pp = fakePayPal({ 'POST /v1/oauth2/token': [{ status: 401, body: { error: 'invalid_client' } }] })
    await expect(getToken(ENV, { fetch: pp.fetch })).rejects.toThrow(/401/)
    await expect(getToken(ENV, { fetch: pp.fetch })).rejects.not.toThrow(/secret-y/)
  })

  it('a 401 on an API call mints once and retries once', async () => {
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-A': [{ status: 401, body: { name: 'AUTHENTICATION_FAILURE' } }, { status: 200, body: { id: 'INV2-A' } }] })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    const res = await api.request({ method: 'GET', path: '/v2/invoicing/invoices/INV2-A' })
    expect(res.status).toBe(200)
    expect(pp.tokenFetches()).toBe(2)
    expect(pp.calls.filter((c) => c.path.startsWith('/v2/')).length).toBe(2)
  })

  it('a second 401 is returned, not retried again', async () => {
    const pp = fakePayPal({ 'GET /v2/invoicing/invoices/INV2-A': [{ status: 401, body: { name: 'AUTHENTICATION_FAILURE' } }] })
    const api = createPayPal(ENV, { fetch: pp.fetch, sleep: async () => {} })
    const res = await api.request({ method: 'GET', path: '/v2/invoicing/invoices/INV2-A' })
    expect(res.status).toBe(401)
    expect(pp.tokenFetches()).toBe(2)
    expect(pp.calls.filter((c) => c.path.startsWith('/v2/')).length).toBe(2)
  })
})
