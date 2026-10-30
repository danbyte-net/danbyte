import { useEffect } from "react"
import { toast } from "sonner"

// Detects a newer deployed build and offers a reload. A long-lived SPA tab
// keeps running the bundle it started with - client-side navigation never
// refetches code - so after a deploy the page silently shows stale UI.
// The entry chunk's hashed filename is the build identity: refetch the shell
// on focus (and every few minutes) and compare.
//
// Not on load: the document just served is the newest build by definition,
// so the first check waits for a focus or the interval. A focus within a
// minute of the last check (or of the load) is skipped - switching to the
// developer tools and back is not a deploy.

const entryOf = (html: string): string | null =>
  /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null

const CHECK_EVERY_MS = 3 * 60_000
const MIN_GAP_MS = 60_000

export function UpdatePrompt() {
  useEffect(() => {
    const current = entryOf(document.documentElement.innerHTML)
    if (!current) return
    let prompted = false
    let last = Date.now()
    const check = async () => {
      if (prompted || document.hidden) return
      if (Date.now() - last < MIN_GAP_MS) return
      last = Date.now()
      try {
        const res = await fetch("/", {
          cache: "no-store",
          headers: { accept: "text/html" },
        })
        if (!res.ok) return
        const latest = entryOf(await res.text())
        if (latest && latest !== current) {
          prompted = true
          toast("Danbyte was updated", {
            id: "build-update",
            duration: Infinity,
            action: { label: "Reload", onClick: () => location.reload() },
          })
        }
      } catch {
        /* offline / transient - try again next focus */
      }
    }
    window.addEventListener("focus", check)
    const iv = setInterval(check, CHECK_EVERY_MS)
    return () => {
      window.removeEventListener("focus", check)
      clearInterval(iv)
    }
  }, [])
  return null
}
