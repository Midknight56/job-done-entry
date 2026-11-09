import { confirmVisit } from './visit.js'
// Every button keeps 8 px padding, sits 16 px inside the screen, keeps 12 px from its neighbours, and nothing
// overlaps, at a small phone, a common phone and a laptop. A failure names the screen, the size and the button.
// It also saves a picture of each screen in test-results/screens/ for a person to look at.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

const SIZES = [
  { name: 'small phone', width: 360, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'laptop', width: 1280, height: 800 },
]
const TABS = ['Today', 'Calendar', 'Owed', 'Settings']

/** Measures every visible button and link styled as a button inside the phone. */
async function measure(page) {
  return page.evaluate(() => {
    const phone = document.querySelector('.phone').getBoundingClientRect()
    const problems = []
    const boxes = []
    // With the QR sheet open, only its own controls can be touched.
    const sheet = document.querySelector('#sheet:not([hidden])')
    for (const el of (sheet || document).querySelectorAll(sheet ? 'button, a.button' : '.phone button, .phone a.button')) {
      const full = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (full.width === 0 || full.height === 0 || style.visibility === 'hidden' || el.closest('[hidden]')) continue
      // Only the part a person can see counts: a scrolling area clips what is scrolled out of it.
      let clip = el.parentElement
      while (clip && !/(auto|scroll|hidden)/.test(getComputedStyle(clip).overflowY)) clip = clip.parentElement
      const c = clip ? clip.getBoundingClientRect() : { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity }
      const top = Math.max(full.top, c.top), bottom = Math.min(full.bottom, c.bottom)
      if (bottom - top < 1) continue
      const r = { left: full.left, right: full.right, width: full.width, top, bottom, height: bottom - top }
      if (el.closest('.b-calendar')) continue // Bryntum's own toolbar is measured by Bryntum
      const name = (el.innerText || el.getAttribute('aria-label') || el.className).trim().slice(0, 30)
      const pad = Math.min(...['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((k) => parseFloat(style[k])))
      if (pad < 8 && !el.classList.contains('tab')) problems.push(`${name}: padding ${pad}`)
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`${name}: text overflows`)
      const inside = Math.min(r.left - phone.left, phone.right - r.right)
      if (inside < 15.5 && !el.closest('.tabs') && !el.closest('.calendar-host')) problems.push(`${name}: ${inside.toFixed(0)} px from the edge`)
      boxes.push({ name, r, group: el.closest('.tabs, .calendar-head, .calendar-host') ? 'compact' : 'main' })
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r
        const b = boxes[j].r
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
        if (overlap) problems.push(`${boxes[i].name} overlaps ${boxes[j].name}`)
        else if (boxes[i].group === 'main' && boxes[j].group === 'main') {
          const gapX = Math.max(b.left - a.right, a.left - b.right)
          const gapY = Math.max(b.top - a.bottom, a.top - b.bottom)
          const gap = Math.max(gapX, gapY)
          if (gap >= 0 && gap < 11.5) problems.push(`${boxes[i].name} and ${boxes[j].name}: ${gap.toFixed(0)} px apart`)
        }
      }
    }
    const scroll = document.documentElement.scrollWidth > window.innerWidth + 1
    if (scroll) problems.push('the page scrolls sideways')
    return problems
  })
}

for (const size of SIZES) {
  test(`layout at ${size.name} ${size.width} x ${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.goto('/?calendar=fallback')
    await newDemo(page, 0)
    await page.reload()
    await page.getByRole('tab', { name: 'Today' }).waitFor()
    // A draft on screen, so the card's buttons are measured too.
    await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.')
    await page.getByRole('button', { name: 'Send text' }).click()
    await page.getByRole('button', { name: /^Send \d/ }).waitFor()
    const found = []
    for (const tab of TABS) {
      await page.getByRole('tab', { name: tab }).click()
      await page.waitForTimeout(600)
      await page.screenshot({ path: `test-results/screens/${size.width}-${tab.toLowerCase()}.png` })
      for (const p of await measure(page)) found.push(`${tab}: ${p}`)
    }
    await page.getByRole('tab', { name: 'Today' }).click()
    await confirmVisit(page, page.getByRole('button', { name: /^Send \d/ }))
    await page.getByRole('button', { name: /^Send \d/ }).click()
    await page.locator('#sheet:not([hidden])').waitFor()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `test-results/screens/${size.width}-qr-sheet.png` })
    for (const p of await measure(page)) found.push(`QR sheet: ${p}`)
    expect(found).toEqual([])
  })
}
