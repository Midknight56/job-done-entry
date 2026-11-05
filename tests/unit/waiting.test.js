import { describe, expect, it } from 'vitest'
import { seedWorkspace } from '../../src/state/workspace.js'
import * as waiting from '../../src/state/waiting.js'

const workspace = () => seedWorkspace({ id: 'w1', now: Date.parse('2026-11-03T10:00:00Z'), tzOffsetMinutes: 0 })
const fields = { customerId: 'c3', summary: 'Gutter clean', hours: 2 }

describe('waiting jobs', () => {
  it('adds a waiting job at the end with a notice and default availability', () => {
    const ws = workspace()
    const j = waiting.addWaiting(ws, fields)
    expect(j).toMatchObject({ ...fields, state: 'waiting', start: '', end: '', free: 'any' })
    expect(ws.jobs.at(-1)).toBe(j)
    expect(ws.waiting).toEqual(['j5', j.id])
    expect(ws.notices.at(-1).text).toBe('Sam is on the waiting list.')
    expect(ws.jobs.find((item) => item.id === 'j5').free).toBe('any')
  })

  it.each([
    ['customer', { customerId: 'missing' }],
    ['empty summary', { summary: '  ' }],
    ['long summary', { summary: 'a'.repeat(81) }],
    ['summary type', { summary: 3 }],
    ['short duration', { hours: 0 }],
    ['long duration', { hours: 8.5 }],
    ['duration step', { hours: 1.25 }],
    ['duration type', { hours: '2' }],
    ['availability name', { free: 'evenings' }],
    ['empty weekdays', { free: [] }],
    ['weekend', { free: [0, 6] }],
    ['weekday type', { free: ['1'] }],
    ['null availability', { free: null }],
  ])('rejects %s without changing state', (_name, bad) => {
    const ws = workspace()
    const before = structuredClone(ws)
    expect(() => waiting.addWaiting(ws, { ...fields, ...bad })).toThrow(expect.objectContaining({ status: 422 }))
    expect(ws).toEqual(before)
  })

  it('accepts half hour boundaries and weekday availability without sharing the input list', () => {
    const ws = workspace()
    const free = [1, 3]
    const first = waiting.addWaiting(ws, { ...fields, hours: 0.5, free })
    free.push(5)
    expect(first.free).toEqual([1, 3])
    expect(waiting.addWaiting(ws, { ...fields, hours: 8, free: 'afternoons' }).hours).toBe(8)
  })

  it('refuses an eleventh waiting job', () => {
    const ws = workspace()
    for (let i = 0; i < 9; i++) waiting.addWaiting(ws, fields)
    expect(() => waiting.addWaiting(ws, fields)).toThrow(expect.objectContaining({ status: 422 }))
    expect(ws.waiting).toHaveLength(10)
  })

  it('updates only supplied fields and keeps queue order even at capacity', () => {
    const ws = workspace()
    for (let i = 0; i < 9; i++) waiting.addWaiting(ws, fields)
    const order = [...ws.waiting]
    waiting.updateWaiting(ws, 'j5', { customerId: 'c2', summary: 'Shower job', hours: 2, free: 'mornings' })
    waiting.updateWaiting(ws, 'j5', { hours: 1.5, state: 'booked', start: 'bad' })
    expect(ws.jobs.find((j) => j.id === 'j5')).toMatchObject({ customerId: 'c2', summary: 'Shower job', hours: 1.5, free: 'mornings', state: 'waiting', start: '' })
    expect(ws.waiting).toEqual(order)
  })

  it('rejects invalid updates atomically and refuses changes to jobs outside waiting', () => {
    const ws = workspace()
    const before = structuredClone(ws)
    expect(() => waiting.updateWaiting(ws, 'j5', { summary: 'Changed', hours: 0.25 })).toThrow(expect.objectContaining({ status: 422 }))
    for (const id of ['j1', 'missing']) {
      expect(() => waiting.updateWaiting(ws, id, { hours: 2 })).toThrow(expect.objectContaining({ status: 422 }))
      expect(() => waiting.removeWaiting(ws, id)).toThrow(expect.objectContaining({ status: 422 }))
    }
    expect(ws).toEqual(before)
  })

  it('removes a waiting job from both collections and frees capacity', () => {
    const ws = workspace()
    waiting.removeWaiting(ws, 'j5')
    expect(ws.waiting).toEqual([])
    expect(ws.jobs.some((j) => j.id === 'j5')).toBe(false)
    expect(waiting.addWaiting(ws, fields).state).toBe('waiting')
  })

  it('avoids a job id already in use', () => {
    const ws = workspace()
    ws.seq = 4
    const j = waiting.addWaiting(ws, fields)
    expect(j.id).not.toBe('j5')
    expect(new Set(ws.jobs.map((item) => item.id)).size).toBe(ws.jobs.length)
  })
})

describe('local availability', () => {
  const slot = (free, start, end, tz = 840) => waiting.freeFor({ tz }, { free }, start, end)
  it('rejects a morning slot ending even one second after local noon', () => {
    expect(slot('mornings', '2026-11-02T21:00:00Z', '2026-11-02T22:00:01Z')).toBe(false)
  })
  it('checks mornings through noon in local time on a different UTC day', () => {
    expect(slot('mornings', '2026-11-02T20:00:00Z', '2026-11-02T22:00:00Z')).toBe(true)
    expect(slot('mornings', '2026-11-02T21:30:00Z', '2026-11-02T22:30:00Z')).toBe(false)
    expect(slot('mornings', '2026-11-03T09:00:00Z', '2026-11-03T10:30:00Z')).toBe(false)
  })
  it('checks afternoons from noon and rejects a slot spanning local midnight', () => {
    expect(slot('afternoons', '2026-11-02T22:00:00Z', '2026-11-02T23:00:00Z')).toBe(true)
    expect(slot('afternoons', '2026-11-02T21:30:00Z', '2026-11-02T22:30:00Z')).toBe(false)
    expect(slot('afternoons', '2026-11-03T09:00:00Z', '2026-11-03T10:30:00Z')).toBe(false)
  })
  it('uses local weekdays with positive and negative offsets', () => {
    expect(slot([2], '2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z')).toBe(true)
    expect(slot([1, 3], '2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z')).toBe(false)
    expect(slot([1], '2026-11-03T01:00:00Z', '2026-11-03T02:00:00Z', -240)).toBe(true)
    expect(slot([2], '2026-11-03T01:00:00Z', '2026-11-03T02:00:00Z', -240)).toBe(false)
  })
  it('treats any and missing availability as any time', () => {
    expect(slot('any', '2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z')).toBe(true)
    expect(waiting.freeFor({ tz: -240 }, {}, '2026-11-03T01:00:00Z', '2026-11-03T02:00:00Z')).toBe(true)
  })
})
