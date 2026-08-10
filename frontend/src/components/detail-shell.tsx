import { type ReactNode } from "react"
import { Link, type LinkProps } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Pin } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DetailActions } from "@/components/detail-actions"
import { useRegisterPresence } from "@/lib/presence-context"
import { PlanFromObject } from "@/components/planning/plan-from-object"
import { useDefaultTabPref } from "@/lib/use-url-tab"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
//     hero={
//       <DetailHero
//         title={`VLAN ${v.vlan_id}`} mono
//         badges={<StatusBadge status={v.status} />}
//         tags={<TagList tags={v.tags} />}
//         description={v.description}
//         stats={<DetailStat label="Prefixes" value={v.prefix_count} />}
//       />
//     }
//     tabs={[{ value: "overview", label: "Overview" }, …]}
//     tab={tab} onTabChange={setTab}
//   >
//     <DetailTab value="overview"><VlanOverview/></DetailTab>
//     …
//   </DetailShell>

export interface DetailTabItem {
  value: string
  /** Node, not string: a tab may carry a marker (e.g. a drift dot) beside its
   * name without every caller reaching into SegmentedTabs. */
  label: React.ReactNode
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
    <div className="flex h-full min-w-0 flex-1 flex-col">
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
          {/* Route-derived like DetailActions: renders only on a detail page
              whose type can be planned. */}
          <PlanFromObject />
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
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-10 min-w-0 items-center gap-2 border-b border-border px-4 lg:px-6">
          <SegmentedTabs value={tab} onValueChange={onTabChange} items={tabs} />
          <DefaultTabPin current={tab} />
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
          ? "m-0 flex min-h-0 min-w-0 flex-1"
          : "m-0 min-w-0 flex-1 overflow-auto p-4 lg:p-6",
        className
      )}
    >
      {children}
    </TabsContent>
  )
}

/** How many columns the stat rail lays its `DetailStat`s out in. `3` stays
 * two-up on narrow viewports. */
export type DetailStatCols = 1 | 2 | 3

const STAT_COLS: Record<DetailStatCols, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
}

/**
 * The hero strip under the breadcrumb header — pass it to `DetailShell`'s
 * `hero`. It owns the section wrapper, the page's single `<h1>` and its size,
 * and the stat rail, so a detail page only supplies content.
 *
 * The title is **always** an `<h1>` at `text-2xl font-semibold tracking-tight`.
 * This was hand-rolled 42× and had drifted to four sizes (`text-lg` …
 * `text-3xl`) and three elements (`div`/`span`/`h1`) for the same role; one
 * page had no title at all. Don't reintroduce a size override — if a title
 * needs the mono face (IP, CIDR, ASN, interface, circuit ID) pass `mono`, and
 * if it needs to *be* a coloured catalog badge pass the `ColorBadge` as
 * `title`: the badge sizes itself, and the `<h1>` still lands in the outline.
 *
 * Slots render top-to-bottom in the left column — title row (title + inline
 * `badges`), `subtitle`, `tags`, `description`, `children` — with `stats` in
 * the right-hand rail.
 */
export function DetailHero({
  title,
  mono = false,
  badges,
  subtitle,
  tags,
  description,
  stats,
  statCols = 2,
  children,
}: {
  /** The object's identity. Rendered as the page's `<h1>`. */
  title: ReactNode
  /** Mono face for the title — identifiers, not names. */
  mono?: boolean
  /** Status/state chips inline after the title (they wrap with it). */
  badges?: ReactNode
  /** One secondary line under the title: a parent link, a facility ID, ports,
   * a second row of chips. Muted 13px — wrap in your own span/Link to override
   * the face or colour. */
  subtitle?: ReactNode
  /** `<TagList tags={…} />`. */
  tags?: ReactNode
  /** Free-text description. Falsy (including `""`) renders nothing. */
  description?: ReactNode
  /** `<DetailStat/>`s for the rail — the `<dl>` is the primitive's. */
  stats?: ReactNode
  /** Rail column count. Defaults to 2. */
  statCols?: DetailStatCols
  /** Anything else belonging in the left column, below the description. */
  children?: ReactNode
}) {
  return (
    <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1
            className={cn(
              "text-2xl font-semibold tracking-tight",
              mono && "font-mono"
            )}
          >
            {title}
          </h1>
          {badges}
        </div>
        {/* `empty:hidden` on every optional row: a slot often holds a
            component that decides for itself whether it has anything to draw
            (a prefix's masters chain, a flags array), and without it a
            null-rendering slot still spent its margin. */}
        {subtitle && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground empty:hidden">
            {subtitle}
          </div>
        )}
        {tags && <div className="mt-2 empty:hidden">{tags}</div>}
        {description && (
          <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground empty:hidden">
            {description}
          </p>
        )}
        {children && <div className="mt-3 empty:hidden">{children}</div>}
      </div>
      {stats && (
        <dl
          className={cn(
            "ml-auto grid gap-x-8 gap-y-3 text-[13px]",
            STAT_COLS[statCols]
          )}
        >
          {stats}
        </dl>
      )}
    </section>
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

/** Pin/unpin the current tab as the default starting tab for this page type
 * (#5). Stored per-user in localStorage keyed by the route pattern, and read by
 * `useUrlTab` when a page is opened without an explicit `?tab=`. */
function DefaultTabPin({ current }: { current: string }) {
  const { pinned, setPinned } = useDefaultTabPref()
  const isPinned = pinned === current
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "ml-auto shrink-0 self-center",
            isPinned ? "text-foreground" : "text-muted-foreground/60"
          )}
          aria-label={
            isPinned ? "Unpin this default tab" : "Make this the default tab"
          }
          aria-pressed={isPinned}
          onClick={() => setPinned(isPinned ? null : current)}
        >
          <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        {isPinned
          ? "This tab opens by default — click to unpin"
          : "Open this tab by default on this kind of page"}
      </TooltipContent>
    </Tooltip>
  )
}
