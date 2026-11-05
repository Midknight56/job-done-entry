// @ts-check
/** Resolve supported date words using the workspace clock, never model bounds.
 * @param {string} text @param {number} now @param {number} tz */
export function requestedDates(text, now, tz) {
  const local = new Date(now + tz * 60000)
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - tz * 60000
  const day = 86400000
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []
  const relative = text.match(/\b(next week|this week|today|tomorrow)\b/gi) || []
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const weekday = [...text.matchAll(/\b(?:(on|this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)]
  if (iso.length + relative.length + weekday.length !== 1) return null
  let after, before
  if (iso.length) {
    after = Date.parse(iso[0] + 'T00:00:00Z') - tz * 60000
    if (!Number.isFinite(after) || new Date(after + tz * 60000).toISOString().slice(0, 10) !== iso[0]) return null
    before = after + day
  } else if (weekday.length) {
    const target = weekdays.indexOf(weekday[0][2].toLowerCase())
    if (weekday[0][1]?.toLowerCase() === 'next') {
      const monday = midnight - ((local.getUTCDay() + 6) % 7) * day
      after = monday + (7 + (target + 6) % 7) * day
    } else {
      after = midnight + ((target - local.getUTCDay() + 7) % 7) * day
    }
    before = after + day
  } else {
    const phrase = relative[0].toLowerCase()
    if (phrase === 'today' || phrase === 'tomorrow') {
      after = midnight + (phrase === 'tomorrow' ? day : 0)
      before = after + day
    } else {
      const monday = midnight - ((local.getUTCDay() + 6) % 7) * day
      after = monday + (phrase === 'next week' ? 7 * day : 0)
      before = after + 7 * day
    }
  }
  // Other date qualifiers would make this interpretation unchecked.
  if (/\b(except|until|after|before|or|not|following|weekend|fortnight|noon|midnight|evening|tonight)\b/i.test(text)) return null
  if (/\b(?:at\s+\d|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|o.clock)\b/i.test(text)) return null
  const period = /\bmorning(s)?\b/i.test(text) ? 'morning' : /\bafternoon(s)?\b/i.test(text) ? 'afternoon' : null
  if (period && /\bmorning(s)?\b/i.test(text) && /\bafternoon(s)?\b/i.test(text)) return null
  return { after, before, period }
}
