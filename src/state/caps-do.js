// @ts-check
// One serialized counter document for each shared cap key.

export class CapsDO {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx
    this.tail = Promise.resolve()
  }

  /** @param {Request} request */
  fetch(request) {
    const result = this.tail.then(async () => {
      const url = new URL(request.url)
      if (url.host !== 'do.internal') return new Response('Not found', { status: 404 })
      const values = await this.ctx.storage.get('values') || {}
      if (request.method === 'GET' && url.pathname === '/read') return Response.json(values)
      if (request.method !== 'POST' || !['/reserve', '/release'].includes(url.pathname)) return new Response('Not found', { status: 404 })
      const body = await request.json().catch(() => null)
      const items = body?.items
      if (!Array.isArray(items) || items.some((item) => !item || typeof item.field !== 'string' || !item.field ||
        !Number.isFinite(item.n) || item.n < 0 || (url.pathname === '/reserve' && item.limit !== null && (!Number.isFinite(item.limit) || item.limit < 0)))) {
        return new Response('Invalid counter items', { status: 400 })
      }
      const next = { ...values }
      for (const { field, n } of items) {
        const value = Object.hasOwn(next, field) ? next[field] : 0
        Object.defineProperty(next, field, { value: url.pathname === '/reserve' ? value + n : Math.max(0, value - n), enumerable: true, writable: true, configurable: true })
      }
      // JSON carries an unlimited limit as null.
      if (url.pathname === '/reserve' && items.some(({ field, limit }) => limit !== null && next[field] > limit)) return Response.json({ ok: false, values })
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3 * 86_400_000)
      await this.ctx.storage.put('values', next)
      return Response.json({ ok: true, values: next })
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async alarm() {
    await this.tail
    await this.ctx.storage.deleteAll()
  }
}
