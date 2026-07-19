import { Link } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useRegisterPresence } from "@/lib/presence-context"

// Shared shell for every /new and /$id/edit page. Owns the breadcrumb
// header, the centered max-width container, and the title block so each
// route file only needs to render `<EditPageShell>` + the form body.

export interface BreadcrumbCrumb {
  label: React.ReactNode
  to?: string
  params?: Record<string, string>
}

export interface EditPageShellProps {
  /** Crumbs left → right. Last one is rendered as plain text (the current page). */
  crumbs: BreadcrumbCrumb[]
  /** Big heading. */
  title: React.ReactNode
  /** Optional one-line subtitle under the heading. */
  subtitle?: React.ReactNode
  /** When both are set, announces this user as *editing* the object and shows a
   * presence bar — so a second person opening the same form sees it. Omit on
   * /new pages (no object id yet). */
  presenceType?: string
  presenceId?: string
  className?: string
  children: React.ReactNode
}

// Separate component so the hook runs unconditionally even though presence is
// optional on the shell. Announces this user as *editing*; the "someone is
// editing" bar surfaces in the global SiteHeader, so nothing renders here.
function EditPresence({ type, id }: { type: string; id: string }) {
  useRegisterPresence(type, id, "editing")
  return null
}

export function EditPageShell({
  crumbs,
  title,
  subtitle,
  presenceType,
  presenceId,
  className,
  children,
}: EditPageShellProps) {
  const last = crumbs[crumbs.length - 1]
  const lead = crumbs.slice(0, -1)
  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        {lead.map((c, i) => (
          <span
            key={i}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            {c.to ? (
              <Button variant="ghost" size="sm" asChild className="h-6 px-1">
                <Link to={c.to} params={c.params as never}>
                  {i === 0 && <ChevronLeft className="h-3 w-3" />} {c.label}
                </Link>
              </Button>
            ) : (
              <span>{c.label}</span>
            )}
            <ChevronRight className="h-3 w-3 opacity-60" />
          </span>
        ))}
        <span className="text-xs font-semibold tracking-tight text-foreground">
          {last.label}
        </span>
        {presenceType && presenceId && (
          <EditPresence type={presenceType} id={presenceId} />
        )}
      </header>

      {/* This is the scroll container: SidebarInset is `overflow-hidden`, so
          each page owns its own scroll via `min-h-0 flex-1 overflow-y-auto`.
          Without it a form taller than the viewport is clipped and can't
          scroll — invisible on desktop (forms fit) but broken on mobile. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full max-w-2xl px-6 py-6", className)}>
          <div className="mb-5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
