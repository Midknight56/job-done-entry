// A picture of the page at a named step, only when SHOTS_DIR is set (the contact sheet of a hosted run).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let n = 0

/** @param {import('@playwright/test').Page} page @param {string} name */
export async function shot(page, name) {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  n += 1
  await page.screenshot({ path: join(dir, `${String(n).padStart(2, '0')}-${name}.png`) })
}
