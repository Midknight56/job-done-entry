/** The moment the calendar opens on: now, or the coming Monday on a weekend. tz is minutes from UTC. */
export function openingTime(now, tz = 0) {
  const day = new Date(now + tz * 60000).getUTCDay()
  const skip = day === 6 ? 2 : day === 0 ? 1 : 0
  return now + skip * 86400000
}
