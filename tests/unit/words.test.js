import { describe, it, expect } from 'vitest'
import { durationHours, numbersIn, costWasSaid, hoursWereSaid } from '../../src/pricing/words.js'

describe('spoken durations', () => {
  it.each([
    ['hour and a half', 1.5],
    ['an hour and a half', 1.5],
    ['ninety minutes', 1.5],
    ['90 minutes', 1.5],
    ['an hour', 1],
    ['one hour', 1],
    ['two hours', 2],
    ['2 hours', 2],
    ['1.5 hours', 1.5],
    ['half an hour', 0.5],
    ['three quarters of an hour', 0.75],
    ['two and a half hours', 2.5],
    ['forty five minutes', 0.75],
  ])('"%s" is %s hours', (text, hours) => {
    expect(durationHours(`Kitchen tap for Maria, ${text}, the tap was 89`, 15)).toBe(hours)
  })

  it('rounds up to the billing step: forty minutes at a 15 minute step is 0.75 h', () => {
    expect(durationHours('took forty minutes', 15)).toBe(0.75)
    expect(durationHours('took forty minutes', 30)).toBe(1)
  })

  it('gives null when no duration was said', () => {
    expect(durationHours('the tap was 89', 15)).toBe(null)
  })
})

describe('spoken numbers', () => {
  it('finds digits and number words', () => {
    expect(numbersIn('Kitchen tap for Maria at 14 Elm, the tap was 89')).toEqual(expect.arrayContaining([14, 89]))
    expect(numbersIn('the part was eighty nine')).toContain(89)
    expect(numbersIn('Dave paid cash, 120')).toContain(120)
    expect(numbersIn('a hundred and twenty in cash')).toContain(120)
    expect(numbersIn('the valve was $42.50')).toContain(42.5)
    expect(numbersIn('the valve was 1,250')).toContain(1250)
  })

  it('checks a part cost against the transcript', () => {
    expect(costWasSaid('the tap was 89', 89)).toBe(true)
    expect(costWasSaid('the tap was 89', 98)).toBe(false)
    expect(costWasSaid('the tap was eighty nine', 89)).toBe(true)
  })

  it('checks labour hours against the transcript', () => {
    expect(hoursWereSaid('hour and a half', 1.5, 15)).toBe(true)
    expect(hoursWereSaid('hour and a half', 2, 15)).toBe(false)
    expect(hoursWereSaid('no time said', 1, 15)).toBe(false)
  })
})

describe('more durations', () => {
  it.each([
    ['twenty minutes', 0.5],
    ['fifteen minutes', 0.25],
    ['three hours', 3],
    ['four and a half hours', 4.5],
    ['two hours and a half', 2.5],
    ['thirty mins', 0.5],
  ])('"%s" is %s hours', (text, hours) => {
    expect(durationHours(text, 15)).toBe(hours)
  })
})
