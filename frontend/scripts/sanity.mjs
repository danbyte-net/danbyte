import puppeteer from "puppeteer-core"

const CHROME = "/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell"

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 60_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
})
try {
  const page = await browser.newPage()
  page.on("console", (m) => console.log("PAGE:", m.text()))
  page.on("pageerror", (e) => console.log("PAGEERR:", e.message))
  console.log("goto http://example.com ...")
  await page.goto("http://example.com", { waitUntil: "domcontentloaded" })
  console.log("title:", await page.title())
  console.log("ok, navigating to vite dev page ...")
  await page.goto("http://localhost:3000/prefixes", { waitUntil: "domcontentloaded", timeout: 30_000 })
  console.log("title:", await page.title())
  const bodyLen = await page.evaluate(() => document.body.innerHTML.length)
  console.log("body bytes:", bodyLen)
} finally {
  await browser.close()
}
