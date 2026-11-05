// @ts-check
// One serialized writer for each workspace document.

import { api, errorResponse, paypal } from '../worker.js'
import { dropStaleDrafts, releaseExpired } from './holds.js'
import { applyStatus } from './money.js'
import { pushPanel } from './workspace.js'

const WS_TTL = 30 * 86_400_000

/** @param {any} ctx @param {any} env */
export class WorkspaceDO {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.tail = Promise.resolve()
    this.store = {
      get: (key) => this.ctx.storage.get(key),
      put: async (key, value) => {
        await Promise.all([
          this.ctx.storage.put(key, value),
          this.ctx.storage.put('deleteAt', Date.now() + WS_TTL),
        ])
        await this.nextAlarm()
      },
    }
  }

  /** @param {Request} request */
  fetch(request) {
    return this.lock(async () => {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/internal/')) {
        if (url.host !== 'do.internal') return new Response('Not found', { status: 404 })
        return this.internal(request, url)
      }
      if (url.host === 'do.internal') return new Response('Not found', { status: 404 })

      const wid = /(?:^|;\s*)jd_ws=([a-z0-9]+)/.exec(request.headers.get('cookie') || '')?.[1]
      if (!wid || !/^[a-z0-9]{1,40}$/.test(wid) || (this.ctx.id?.name && wid !== this.ctx.id.name)) return Response.json({ error: 'no_workspace', message: 'Start a demo first.' }, { status: 404 })
      // A thrown error loses its code and status when it crosses back to the Worker, so it is answered here.
      try {
        await this.ensureWorkspace(wid)
        return await api(request, { ...this.env, WORKSPACE_STORE: this.store }, this.ctx, url)
      } catch (e) {
        return errorResponse(e)
      }
    })
  }

  /** @param {() => Promise<Response>} callback */
  lock(callback) {
    const result = this.tail.then(callback)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** @param {string} wid */
  async ensureWorkspace(wid) {
    if (await this.ctx.storage.get('ws')) return
    if (await this.env.JOBDONE.get(`expired:${wid}`)) return
    const legacy = await this.env.JOBDONE.get(`ws:${wid}`)
    if (legacy) await this.store.put('ws', legacy)
  }

  /** @param {Request} request @param {URL} url */
  async internal(request, url) {
    if (url.host !== 'do.internal') return new Response('Not found', { status: 404 })
    const body = await request.json().catch(() => null)
    const objectName = this.ctx.id?.name
    if (url.pathname === '/internal/workspace' && request.method === 'PUT' && body && typeof body.id === 'string') {
      if (objectName && body.id !== objectName) return new Response('workspace mismatch', { status: 400 })
      await this.store.put('ws', JSON.stringify(body))
      await this.env.JOBDONE.delete(`expired:${body.id}`)
      return new Response('ok')
    }
    if (url.pathname === '/internal/webhook' && request.method === 'POST' && body && typeof body.wid === 'string') {
      if (objectName && body.wid !== objectName) return new Response('workspace mismatch', { status: 400 })
      await this.ensureWorkspace(body.wid)
      if (body.eventId && await this.ctx.storage.get(`evt:${body.eventId}`)) return new Response('ok')
      const text = await this.ctx.storage.get('ws')
      if (!text) return new Response('workspace unavailable', { status: 503 })
      const ws = JSON.parse(text)
      if (body.kind === 'guard') pushPanel(ws, body.entry)
      else {
        applyStatus(ws, body.invoiceId, body.status, body.now, { due: body.due, paid: body.paid, tip: body.tip, refunded: body.refunded, source: 'webhook' })
        pushPanel(ws, body.entry)
      }
      await this.store.put('ws', JSON.stringify(ws))
      if (body.eventId) await this.ctx.storage.put(`evt:${body.eventId}`, '1')
      return new Response('ok')
    }
    return new Response('Not found', { status: 404 })
  }

  async alarm() {
    await this.lock(async () => {
      const now = Date.now()
      const deleteAt = await this.ctx.storage.get('deleteAt')
      if (deleteAt != null && now >= deleteAt) {
        await this.ctx.storage.deleteAll()
        if (this.ctx.id?.name) await this.env.JOBDONE.put(`expired:${this.ctx.id.name}`, '1', { expirationTtl: 30 * 86_400 })
        return new Response('ok')
      }
      const text = await this.ctx.storage.get('ws')
      if (text) {
        const ws = JSON.parse(text)
        await releaseExpired(ws, { api: paypal(this.env, ws), now, alarm: true })
        dropStaleDrafts(ws, now)
        if (JSON.stringify(ws) !== text) await this.store.put('ws', JSON.stringify(ws))
      }
      await this.nextAlarm()
      return new Response('ok')
    })
  }

  async nextAlarm() {
    let deleteAt = await this.ctx.storage.get('deleteAt')
    if (deleteAt == null) {
      deleteAt = Date.now() + WS_TTL
      await this.ctx.storage.put('deleteAt', deleteAt)
    }
    let next = deleteAt
    const text = await this.ctx.storage.get('ws')
    if (text) {
      const ws = JSON.parse(text)
      for (const hold of ws.holds || []) {
        if (!hold.ended && (hold.tries || 0) < 10) next = Math.min(next, Math.max(hold.expiresAt, hold.retryAt || 0))
      }
    }
    await this.ctx.storage.setAlarm(next)
  }
}
