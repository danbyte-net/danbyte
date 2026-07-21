import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"

import appCss from "../styles.css?url"
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { ThemeProvider } from "@/components/theme-provider"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { PresenceProvider } from "@/lib/presence-context"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { useEffect } from "react"
import { useMe } from "@/lib/use-me"
import { setUnauthorizedHandler } from "@/lib/api"

const queryClient = new QueryClient({
  // Any successful write can produce an audit entry, so invalidate the
  // change-log queries after every mutation. Without this, a detail page's
  // History tab (or the global audit log) keeps serving its cached result for
  // the 30s staleTime window and looks like the change wasn't recorded.
  mutationCache: new MutationCache({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["changelog"] })
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't retry on auth/permission failures — they won't fix themselves
      // with another fetch and they make every page sit on "Loading…" for
      // 6+ seconds. Other errors still get the default 3 retries.
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | undefined)?.status
        if (status === 401 || status === 403 || status === 404) return false
        return failureCount < 3
      },
    },
  },
})

// A server-side 401 (session expired) → re-resolve auth; the layout guard
// below then redirects to /login. Registered once, module-side.
setUnauthorizedHandler(() => {
  queryClient.invalidateQueries({ queryKey: ["me"] })
})

// FOUC fix: this script runs SYNCHRONOUSLY in the document <head> before
// any paint. Reads localStorage and writes `class="dark"` on <html>
// before React ever renders, so the saved theme is in effect from the
// first paint. Without this, SSR sends class="" → user sees a light
// flash → React mounts → adds .dark → repaint. With this, the html tag
// already has the right class server-side and client-side.
const THEME_BOOT_SCRIPT = `(function(){try{
  var t = localStorage.getItem("danbyte-theme");
  if (t !== "dark" && t !== "light") {
    t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (t === "dark") document.documentElement.classList.add("dark");
}catch(e){}})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Danbyte" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Default brand favicon (the blue Danbyte "D"). A custom favicon set in
      // Admin → Identity overrides the <link> href at runtime (see AppLayout).
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      {
        rel: "icon",
        type: "image/png",
        href: "/favicon-32.png",
        sizes: "32x32",
      },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.json" },
    ],
    scripts: [
      // No `src` → inline script in <head>; no defer/async → blocking,
      // exactly what we want for a pre-paint theme class.
      { children: THEME_BOOT_SCRIPT },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="mt-2 text-muted-foreground">
        The requested page could not be found.
      </p>
    </main>
  ),
  shellComponent: RootDocument,
  component: AppLayout,
})

// AppLayout — every page hangs off this. Sidebar + header + outlet.
// The SidebarProvider exposes a context that SidebarTrigger consumes,
// so the toggle button in the header collapses/expands the sidebar.
function AppLayout() {
  // Brand the browser tab from the admin "deployment name" setting (falls back
  // to Danbyte). useMe is cached, so this is a no-op fetch after first load.
  const { me, isLoading } = useMe()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Routes reachable without a session — rendered bare, no sidebar, and the
  // auth guard never bounces them to /login. (Public share links were removed;
  // no /share/* exemption remains — every data route requires a session.)
  const isPublic = pathname === "/login" || pathname === "/set-password"

  useEffect(() => {
    document.title = me.deployment_name?.trim() || "Danbyte"
  }, [me.deployment_name])

  // Swap the browser-tab icon to the admin's custom favicon when one is set
  // (Admin → Identity), else restore the shipped Danbyte defaults. Mirrors the
  // deployment-name → tab-title branding above. Only the `rel="icon"` links are
  // managed here; `apple-touch-icon` / `manifest` are left as declared.
  useEffect(() => {
    if (typeof document === "undefined") return
    const head = document.head
    head
      .querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
      .forEach((l) => l.remove())
    const add = (attrs: Record<string, string>) => {
      const link = document.createElement("link")
      link.rel = "icon"
      Object.entries(attrs).forEach(([k, v]) => link.setAttribute(k, v))
      head.appendChild(link)
    }
    if (me.favicon_url) {
      add({ href: me.favicon_url })
    } else {
      add({ href: "/favicon.ico", sizes: "any" })
      add({ href: "/favicon-32.png", type: "image/png", sizes: "32x32" })
    }
  }, [me.favicon_url])

  // Auth guard: once /api/me/ resolves, send anonymous visitors to the login
  // page (remembering where they were headed). Public routes render bare,
  // outside this sidebar chrome.
  useEffect(() => {
    if (!isLoading && !me.is_authenticated && !isPublic) {
      navigate({
        to: "/login",
        search: { redirect: pathname },
        replace: true,
      })
    }
  }, [isLoading, me.is_authenticated, isPublic, pathname, navigate])

  // Public routes (login, set-password) render bare (no sidebar chrome).
  if (isPublic) return <Outlet />

  // SECURITY: never render an app page until we *know* the caller is
  // authenticated. While /api/me/ is in flight, or when it comes back
  // anonymous (we're mid-redirect to /login), render only a neutral splash —
  // no sidebar, no route Outlet, no data. This prevents any flash of real
  // content to a signed-out visitor. The API enforces auth independently;
  // this just keeps the UI from ever leaking a page it shouldn't.
  if (isLoading || !me.is_authenticated) return <AuthSplash />

  return (
    // `h-svh` on SidebarProvider is load-bearing. Default shadcn ships
    // `min-h-svh` (allows growth past viewport) which breaks any nested
    // `min-h-0` + `overflow-auto` chain. By bounding the outer wrapper to
    // the viewport, every nested `flex-1 min-h-0` propagates correctly so
    // both the filter rail and the table area get their own scrollbars.
    <SidebarProvider
      className="h-svh"
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <PresenceProvider>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <SiteHeader />
          {/* min-w-0 is load-bearing on mobile: without it a wide table/tab
              strip forces this column past the viewport and SidebarInset's
              overflow-hidden clips it (unreachable). With it, the width is
              capped and the page's own overflow-x-auto containers scroll. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
        </SidebarInset>
      </PresenceProvider>
    </SidebarProvider>
  )
}

// Neutral full-screen splash shown while auth is being resolved or while a
// signed-out visitor is being bounced to /login. Deliberately content-free —
// no nav, no data — so a page is never flashed to someone not signed in.
function AuthSplash() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <span className="sr-only">Loading…</span>
      <Spinner className="size-5 text-zinc-400 dark:text-zinc-500" />
    </div>
  )
}

// RootDocument wraps the whole page including the ThemeProvider so the
// class toggling on <html> can happen before paint.
function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider delayDuration={200}>
              {children}
              <Toaster richColors closeButton />
            </TooltipProvider>
          </QueryClientProvider>
        </ThemeProvider>
        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
