// Headless-chrome INP probe for the Add IP modal.
//
// What it does:
//   1. Logs in via Django session at /admin/login/
//   2. Navigates to a prefix detail page
//   3. Subscribes to PerformanceEventTiming for pointer events
//   4. Clicks the "Add IP" primary button N times (close, reopen)
//   5. Reports min/median/p95/max processing duration in ms
//
// Run with:
//   LD_LIBRARY_PATH=/tmp/deps/extracted/usr/lib/x86_64-linux-gnu \
//   node frontend/scripts/measure-modal-inp.mjs

import puppeteer from "puppeteer-core"

const CHROME = "/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell"
const FRONTEND = "http://localhost:3200"
const BACKEND = "http://localhost:8000"
const PREFIX_ID = "e83e105b-330f-472f-a05b-67ded4a175c1"
const USER = "admin"
const PASS = "measureonly"
const ITERATIONS = 5

function pct(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function login(page) {
  await page.goto(`${BACKEND}/admin/login/?next=/admin/`, { waitUntil: "domcontentloaded" })
  await page.type('input[name="username"]', USER)
  await page.type('input[name="password"]', PASS)
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.click('input[type="submit"]'),
  ])
  const cookies = await page.cookies()
  const hasSession = cookies.some((c) => c.name === "sessionid")
  if (!hasSession) throw new Error("No sessionid after login")
}

async function measure(page) {
  await page.goto(`${FRONTEND}/prefixes/${PREFIX_ID}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
  // Wait for the Add IP button to appear.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Add IP"),
    { timeout: 30_000 },
  )
  // Give the idle prefetch a fair chance to land.
  await new Promise((r) => setTimeout(r, 1500))

  await page.evaluate(() => {
    window.__events = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.entryType !== "event") continue
        if (e.name !== "pointerdown" && e.name !== "pointerup" && e.name !== "click") continue
        window.__events.push({
          name: e.name,
          duration: e.duration,
          processingStart: e.processingStart - e.startTime,
          processingEnd: e.processingEnd - e.processingStart,
          presentation: (e.startTime + e.duration) - e.processingEnd,
        })
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 })
  })

  const samples = []
  for (let i = 0; i < ITERATIONS; i++) {
    // Click Add IP
    const t0 = Date.now()
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Add IP",
      )
      btn?.click()
    })
    // Wait for the dialog to actually appear (cidr input or "Address" label).
    await page.waitForSelector("dialog[open], [role=dialog]", { timeout: 5000 })
    const tOpen = Date.now() - t0
    // Close it via ESC.
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      () => !document.querySelector("dialog[open]") && !document.querySelector("[role=dialog]"),
      { timeout: 5000 },
    )
    samples.push(tOpen)
    await new Promise((r) => setTimeout(r, 400))
  }

  const events = await page.evaluate(() => window.__events)
  return { samples, events }
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-zygote",
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on("console", (msg) => {
      const t = msg.text()
      if (t.includes("[FastDialog]")) console.log("PAGE:", t)
    })
    await login(page)
    const { samples, events } = await measure(page)
    console.log("\n=== Wall-clock click→dialog-visible (ms) ===")
    console.log(`samples: ${samples.map((n) => n.toFixed(0)).join(", ")}`)
    console.log(`median: ${pct(samples, 50)}  p95: ${pct(samples, 95)}  max: ${Math.max(...samples)}`)
    const pointers = events.filter((e) => e.name === "pointerdown" || e.name === "pointerup")
    console.log("\n=== PerformanceEventTiming.duration (ms) — pointer events ===")
    console.log(`count: ${pointers.length}`)
    const durations = pointers.map((p) => p.duration)
    console.log(`min: ${Math.min(...durations).toFixed(0)}  median: ${pct(durations, 50)}  p95: ${pct(durations, 95)}  max: ${Math.max(...durations).toFixed(0)}`)
    console.log("\n=== Slowest 5 events ===")
    pointers.sort((a, b) => b.duration - a.duration).slice(0, 5).forEach((e) => {
      console.log(`  ${e.name}: dur=${e.duration.toFixed(0)}  delay=${e.processingStart.toFixed(0)}  process=${e.processingEnd.toFixed(0)}  present=${e.presentation.toFixed(0)}`)
    })
  } finally {
    await browser.close()
  }
})()
