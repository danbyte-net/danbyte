import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { getGlobalStartContext } from "@tanstack/react-start"
import { routeTree } from "./routeTree.gen"
import { reloadForNewBuild } from "@/lib/lazy-chunk"

// Recover from stale asset graphs after a redeploy/upgrade.
//
// The built chunk filenames are content-hashed, so a deploy (or an in-app
// upgrade) replaces them. A browser that still holds the previous index.html
// then requests chunk URLs that no longer exist; the dynamic import() rejects
// and - with no handler - the SPA hangs forever on its "Loading…" shell. Vite
// fires `vite:preloadError` for exactly this case, so reload once to pull the
// fresh document (and thus the new asset graph). A short time-based guard stops
// a reload loop if the asset is genuinely missing after the fresh load.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault()
  })
  exposeNonceToPreloads()
}

// Vite's preload helper takes the nonce for the <link rel="modulepreload">
// it adds from the csp-nonce meta's nonce attribute; the router writes the
// value in its content. Chromium lets those preloads through on
// 'strict-dynamic' alone; with the nonce they pass in any browser that
// checks a preload against the policy (#498).
function exposeNonceToPreloads() {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[property="csp-nonce"]'
  )
  if (meta?.content && !meta.nonce) meta.setAttribute("nonce", meta.content)
}

// The per-response script nonce src/server.ts hands to Start (#498). The
// router writes it on every script it renders and in a csp-nonce meta tag,
// where the client router reads it back. Undefined in the browser, and when
// the policy is off.
function requestNonce(): string | undefined {
  try {
    const context = getGlobalStartContext() as { nonce?: string } | undefined
    return context?.nonce
  } catch {
    // Outside a request's middleware scope (a redirect replayed after it).
    return undefined
  }
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    ssr: { nonce: requestNonce() },

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
