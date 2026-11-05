// @ts-check

const SMALL = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 })
const TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })

/** @param {string} text */
function wordsValue(text) {
  let total = 0, group = 0, seen = false
  for (const word of text.toLowerCase().replace(/-/g, ' ').split(/\s+/)) {
    if (word === 'and' || word === 'a' || word === 'an') continue
    if (word in SMALL) { group += SMALL[/** @type {keyof typeof SMALL} */ (word)]; seen = true }
    else if (word in TENS) { group += TENS[/** @type {keyof typeof TENS} */ (word)]; seen = true }
    else if (word === 'hundred') { group = (group || 1) * 100; seen = true }
    else if (word === 'thousand') { total += (group || 1) * 1000; group = 0; seen = true }
    else return null
  }
  return seen ? total + group : null
}

/** @param {string} text */
export function numbersIn(text) {
  const values = []
  for (const match of text.matchAll(/\$?\b\d[\d,]*(?:\.\d+)?\b/g)) {
    const digits = match[0].replace(/^\$/, '')
    if (digits.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(digits)) continue
    values.push(Number(digits.replace(/,/g, '')))
  }
  const tokens = text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || []
  for (let i = 0; i < tokens.length;) {
    let best = null
    let bestEnd = i + 1
    for (let end = i + 1; end <= tokens.length; end++) {
      const candidate = wordsValue(tokens.slice(i, end).join(' '))
      if (candidate === null) break
      best = candidate
      bestEnd = end
    }
    if (best !== null) {
      values.push(best)
      i = bestEnd
    } else i++
  }
  return values
}

// A number said as digits or words, for example "2", "1.5", "forty five", "an".
const SMALL_WORDS = Object.keys(SMALL).join('|')
const NUM = String.raw`(?:\d+(?:\.\d+)?|an|a|(?:${Object.keys(TENS).join('|')})(?: (?:${SMALL_WORDS}))?|${SMALL_WORDS})`
/** @type {Array<{ re: RegExp, read: (m: RegExpExecArray) => number }>} */
const FORMS = [
  { re: /\b(?:three quarters|3 quarters) of an hour\b/, read: () => 0.75 },
  { re: /\bhalf an hour\b/, read: () => 0.5 },
  { re: new RegExp(String.raw`\b(?:(${NUM}) )?hours? and a half\b`), read: (m) => count(m[1]) + 0.5 },
  { re: new RegExp(String.raw`\b(${NUM}) and a half hours?\b`), read: (m) => count(m[1]) + 0.5 },
  { re: new RegExp(String.raw`\b(${NUM}) hours?\b`), read: (m) => count(m[1]) },
  { re: /\b(\d+(?:\.\d+)?)h\b/, read: (m) => Number(m[1]) },
  { re: new RegExp(String.raw`\b(${NUM}) min(?:ute)?s?\b`), read: (m) => count(m[1]) / 60 },
]

/** @param {string | undefined} said */
function count(said) {
  if (!said || said === 'a' || said === 'an') return 1
  return /^\d/.test(said) ? Number(said) : wordsValue(said) ?? NaN
}

/**
 * One complete duration in hours, rounded once; null for missing or uncertain lengths.
 * @param {string} text @param {number} stepMinutes
 */
export function durationHours(text, stepMinutes) {
  const s = text.toLowerCase().replace(/-/g, ' ')
  if (/\b(?:hours?|mins?|minutes?)\s+and a bit\b/.test(s)) return null
  const matches = []
  for (const form of FORMS) {
    for (const m of s.matchAll(new RegExp(form.re.source, 'g'))) {
      const hours = form.read(m)
      if (Number.isFinite(hours) && hours > 0) matches.push({ start: m.index, end: m.index + m[0].length, hours, text: m[0] })
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const phrases = matches.filter((m, i) => !matches.slice(0, i).some(other => other.end > m.start))
  const first = phrases[0]
  if (!first) return null
  let hours = first.hours
  if (phrases.length > 1) {
    const second = phrases[1]
    if (phrases.length !== 2 || !/hours?\b|h\b/.test(first.text) || !/min/.test(second.text) ||
      !/^\s*(?:and\s+)?$/.test(s.slice(first.end, second.start))) return null
    hours += second.hours
  }
  // Do not silently ignore an unsupported duration elsewhere in the request.
  let remaining = s
  for (const phrase of [...phrases].reverse()) remaining = remaining.slice(0, phrase.start) + remaining.slice(phrase.end)
  if (/\b(?:hours?|mins?|minutes?)\b/.test(remaining)) return null
  const step = stepMinutes / 60
  return Number((Math.ceil((hours - 1e-10) / step) * step).toFixed(4))
}

/** @param {string} text */
export function durationNeedsClarification(text) {
  return /\b(?:hours?|mins?|minutes?|\d+(?:\.\d+)?h)\b/i.test(text) && durationHours(text, 1) === null
}

/** One amount attached to a payment expression. @param {string} text @param {number} amount */
export function cashAmountWasSaid(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0 || /\b(?:no|not|never|minus|negative|about|around|maybe|roughly|approximately|between|or)\b|\b\w+n['’]t\b|[-−]\s*\$?\d/i.test(text)) return false
  const words = [...Object.keys(SMALL), ...Object.keys(TENS), 'hundred', 'thousand'].join('|')
  const value = String.raw`(?:\$?\s*\d+(?:,\d{3})*(?:\.\d{1,2})?|(?:${words})\b(?:[ -](?:and\s+)?(?:${words})\b)*)`
  const expressions = [
    new RegExp(String.raw`\b(?:paid|received|gave me|cash payment of)\s+(?:cash\s*[:,]?\s*)?(${value})`, 'gi'),
    new RegExp(String.raw`(${value})\s+(?:dollars?\s+|bucks?\s+)?(?:in\s+)?cash\b`, 'gi'),
  ]
  const amounts = new Set()
  for (const expression of expressions) for (const match of text.matchAll(expression)) {
    const tail = text.slice(match.index + match[0].length)
    // Do not read the start of an address, duration or malformed decimal as money.
    if (tail && !/^(?:\s*$|\s*[.!?,](?!\d)|\s+(?:dollars?\b|bucks?\b|in cash\b|cash\b|from\b|for\b|and\b))/.test(tail)) continue
    const values = numbersIn(match[1])
    if (values.length === 1) amounts.add(Math.round(values[0] * 100))
  }
  return amounts.size === 1 && amounts.has(Math.round(amount * 100))
}

/** @param {string} text @param {number} cost @param {string} [description] */
export function costWasSaid(text, cost, description) {
  if (!Number.isFinite(cost) || cost < 0) return false
  const numberWords = [...Object.keys(SMALL), ...Object.keys(TENS), 'hundred', 'thousand', 'and'].join('|')
  const amount = String.raw`(?:\$?\s*\d+(?:,\d{3})*(?:\.\d+)?|(?:${numberWords})\b(?:[ -](?:${numberWords})\b)*)`
  const expression = new RegExp(String.raw`\b([a-z]+(?: [a-z]+){0,2})\s+(?:was|costs?|costing|priced at)\s+(${amount})`, 'gi')
  for (const m of text.matchAll(expression)) {
    const noun = m[1].toLowerCase().split(' ').filter(w => !['and', 'a', 'the', 'for'].includes(w))
    if (noun.some(w => /^(?:address|visit|job|hour|labour|labor|callout|date|quantity)$/.test(w))) continue
    const tail = text.slice(m.index + m[0].length)
    if (/^[,.\-]\d/.test(tail)) continue
    if (tail && !/^(?:\s*(?:[,.!?]|$)|\s+(?:dollars?\b|bucks?\b|and\b|she\b|he\b|for\b))/.test(tail)) continue
    if (description && !/^(?:part|parts)$/i.test(description) && !noun.includes('part') &&
      !description.toLowerCase().split(/\W+/).some(w => noun.includes(w))) continue
    if (numbersIn(m[2]).some(value => Math.round(value * 100) === Math.round(cost * 100))) return true
  }
  return false
}

/** @param {string} text @param {number} hours @param {number} stepMinutes */
export function hoursWereSaid(text, hours, stepMinutes) {
  return durationHours(text, stepMinutes) === hours
}
