import { createRouter as createTanStackRouter } from "@tanstack/react-router"
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
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,

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
