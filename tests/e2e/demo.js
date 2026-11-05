// Starts a fresh demo workspace and fails at once, with the app's own words, when it is refused (for example the
// 20 new demos a day cap on the hosted app), instead of failing later on a page with no workspace.
import { expect } from '@playwright/test'

/** @param {import('@playwright/test').Page} page @param {number} tz */
export async function newDemo(page, tz) {
  const made = await page.request.post('/api/workspace', { data: { tz } })
  expect(made.status(), `a new demo was refused: ${await made.text()}`).toBe(200)
  return made
}
