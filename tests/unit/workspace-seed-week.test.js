import { describe, it, expect } from 'vitest'
import { seedWorkspace } from '../../src/state/workspace.js'
import { openingTime } from '../../public/week.js'

function expectJ1InOpeningWeek(now, tzOffsetMinutes) {
  const ws = seedWorkspace({ id: 'w1', now, tzOffsetMinutes })
  const opening = openingTime(now, tzOffsetMinutes)
  const start = Date.parse(ws.jobs.find((job) => job.id === 'j1').start)
  const localStart = start + tzOffsetMinutes * 60_000
  const startDate = new Date(localStart).toISOString().slice(0, 10)
  const localOpening = new Date(opening + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
  const openingDay = new Date(`${localOpening}T00:00:00Z`).getUTCDay()
  const monday = new Date(`${localOpening}T00:00:00Z`).getTime() - (openingDay === 0 ? 6 : openingDay - 1) * 86400000
  const mondayDate = new Date(monday).toISOString().slice(0, 10)
  const startDay = new Date(`${startDate}T00:00:00Z`).getUTCDay()

  expect(startDay).toBeGreaterThanOrEqual(1)
  expect(startDay).toBeLessThanOrEqual(5)
  expect(startDate >= mondayDate).toBe(true)
  expect(startDate < new Date(monday + 5 * 86400000).toISOString().slice(0, 10)).toBe(true)
}

describe('seeded Monday job visibility', () => {
  it('keeps j1 inside the week opened by the calendar across the DST boundary', () => {
    for (const date of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
      expectJ1InOpeningWeek(Date.parse(`${date}T18:00:00Z`), -240)
    }
  })

  it('keeps j1 inside the opening week at an eastward UTC offset', () => {
    expectJ1InOpeningWeek(Date.parse('2026-11-02T18:00:00Z'), 780)
  })

  it('keeps j1 inside the opening week at a westward UTC offset', () => {
    expectJ1InOpeningWeek(Date.parse('2026-11-02T18:00:00Z'), -600)
  })
})
