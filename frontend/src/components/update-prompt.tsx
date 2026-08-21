import { useEffect } from "react"
import { toast } from "sonner"

// Detects a newer deployed build and offers a reload. A long-lived SPA tab
// keeps running the bundle it started with - client-side navigation never
// refetches code - so after a deploy the page silently shows stale UI.
// The entry chunk's hashed filename is the build identity: refetch the shell
// on focus (and every few minutes) and compare.

const entryOf = (html: string): string | null =>
  /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null

export function UpdatePrompt() {
  useEffect(() => {
    const current = entryOf(document.documentElement.innerHTML)
    if (!current) return
    let prompted = false
    const check = async () => {
      if (prompted || document.hidden) return
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
    const iv = setInterval(check, 3 * 60_000)
    check()
    return () => {
      window.removeEventListener("focus", check)
      clearInterval(iv)
    }
  }, [])
  return null
}
