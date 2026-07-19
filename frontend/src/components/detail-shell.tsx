import { type ReactNode } from "react"
import { Link, type LinkProps } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DetailActions } from "@/components/detail-actions"
import { useRegisterPresence } from "@/lib/presence-context"

// ─── The canonical detail-page chrome ────────────────────────────────────
//
// Every `/thing/<id>` page shares the same shell: a breadcrumb header bar
// (back link + name + Import/Export/Share + page actions), an optional hero
// strip (title + stats), and a SegmentedTabs strip over scrollable panes.
// DetailShell owns all of it so the ~40 detail routes can't drift on header
// height, tab-strip styling, pane padding, presence, or forget DetailActions.
//
//   <DetailShell
//     backTo="/vlans" backLabel="VLANs"
//     title={<span className="font-mono">{v.vlan_id} · {v.name}</span>}
//     presence={{ type: "vlan", id: v.id }}
//     actions={<>{canEdit && <EditLink/>}{canDelete && <DeleteButton/>}</>}
//     hero={<VlanHero vlan={v} />}
//     tabs={[{ value: "overview", label: "Overview" }, …]}
//     tab={tab} onTabChange={setTab}
//   >
//     <DetailTab value="overview"><VlanOverview/></DetailTab>
//     …
//   </DetailShell>

export interface DetailTabItem {
  value: string
  label: string
  count?: number
}

export function DetailShell({
  backTo,
  backLabel,
  crumbs,
  title,
  presence,
  actions,
  hero,
  tabs,
  tab,
  onTabChange,
  children,
}: {
  backTo: LinkProps["to"]
  backLabel: string
  /** Optional intermediate breadcrumb segment(s) between the back link and the
   * title — e.g. the parent prefix on an IP page. Rendered with a trailing
   * chevron. */
  crumbs?: ReactNode
  /** Current-page name shown in the breadcrumb (wrap in a span for mono, etc). */
  title: ReactNode
  /** Registers "viewing" presence — every detail page should pass this. */
  presence?: { type: string; id: string }
  /** Page-specific action buttons (Edit/Delete/…). Import/Export/Share is
   * added automatically via DetailActions (route-derived). */
  actions?: ReactNode
  /** The title/stat strip under the header — page-specific. */
  hero?: ReactNode
  tabs: DetailTabItem[]
  tab: string
  onTabChange: (value: string) => void
  /** `<DetailTab value=…>` panes. */
  children: ReactNode
}) {
  // Safe when presence is omitted — the hook no-ops on an undefined id.
  useRegisterPresence(presence?.type ?? "", presence?.id, "viewing")

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to={backTo}>
              <ChevronLeft className="h-3 w-3" /> {backLabel}
            </Link>
          </Button>
          {crumbs && (
            <>
              <ChevronRight className="h-3 w-3 opacity-60" />
              {crumbs}
            </>
          )}
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="font-semibold tracking-tight text-foreground">
            {title}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <DetailActions />
          {actions}
        </div>
      </header>

      {hero}

      {/* gap-0 kills the Tabs primitive's default gap-2 — it added an 8px dead
          zone between the tab strip and every pane (glaring on bare panes that
          draw their own sub-bar flush under the strip). */}
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-10 items-center border-b border-border px-4 lg:px-6">
          <SegmentedTabs value={tab} onValueChange={onTabChange} items={tabs} />
        </div>
        {children}
      </Tabs>
    </div>
  )
}

/** One tab pane inside DetailShell — the canonical scrollable, padded body.
 * Pass `bare` for full-bleed content that lays out its own rail/table. */
export function DetailTab({
  value,
  bare = false,
  className,
  children,
}: {
  value: string
  bare?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <TabsContent
      value={value}
      className={cn(
        bare
          ? "m-0 flex min-h-0 flex-1"
          : "m-0 flex-1 overflow-auto p-4 lg:p-6",
        className
      )}
    >
      {children}
    </TabsContent>
  )
}

/** The label/value pair used in a detail hero's stat rail (was copied ~26×). */
export function DetailStat({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13px]">{value}</dd>
    </div>
  )
}
