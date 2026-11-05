import { describe, it, expect } from 'vitest'
import { openingTime } from '../../public/week.js'

describe('calendar opening time', () => {
  it('keeps Friday unchanged', () => {
    const now = Date.parse('2026-10-30T12:00:00Z')
    expect(openingTime(now)).toBe(now)
  })

  it('keeps Monday unchanged', () => {
    const now = Date.parse('2026-11-02T12:00:00Z')
    expect(openingTime(now)).toBe(now)
  })

  it('moves Saturday to Monday', () => {
    expect(openingTime(Date.parse('2026-10-31T12:00:00Z'))).toBe(Date.parse('2026-11-02T12:00:00Z'))
  })

  it('moves Sunday to Monday', () => {
    expect(openingTime(Date.parse('2026-11-01T12:00:00Z'))).toBe(Date.parse('2026-11-02T12:00:00Z'))
  })

  it('uses the local weekday across UTC boundaries', () => {
    expect(openingTime(Date.parse('2026-11-02T01:00:00Z'), -180)).toBe(Date.parse('2026-11-03T01:00:00Z'))
  })
})
