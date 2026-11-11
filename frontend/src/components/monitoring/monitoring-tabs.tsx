import { createContext, useContext, type ReactNode } from "react"

import { SegmentedTabs, type SegmentedTab } from "@/components/segmented-tabs"
import { EngineHealthBanner } from "./engine-health-banner"

/**
 * The frame every Monitoring page shares: the page's one row of tabs (the
 * tabbed-list strip, h-10, above the shell - none on a page with one view),
 * the dead-Outpost banner, then the view. A view that brings its own shell
 * (`ListPageShell`, the policy rail) fills the frame; a dashboard pads and
 * scrolls in it.
 */
export function MonitoringTabs<V extends string>({
  label,
  items,
  value,
  onValueChange,
  padded = false,
  banner = true,
  crumb = true,
  children,
}: {
  /** What the tabs switch between, for screen readers ("Status views"). */
  label: string
  items?: readonly SegmentedTab<V>[]
  value?: V
  onValueChange?: (value: V) => void
  /** Pad and scroll the body (a dashboard), rather than fill it. */
  padded?: boolean
  /** The engine-health banner; off where engines are not the subject. */
  banner?: boolean
  /** Lists on this page lead their title with "Monitoring ›"; off on
   * /monitoring itself. */
  crumb?: boolean
  children: ReactNode
}) {
  return (
    <CrumbContext.Provider value={crumb}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {items && items.length > 1 && value !== undefined && onValueChange && (
          <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
            <SegmentedTabs
              label={label}
              value={value}
              onValueChange={onValueChange}
              items={items}
            />
          </div>
        )}
        {banner && <EngineHealthBanner />}
        <div
          className={
            padded
              ? "min-h-0 flex-1 overflow-auto p-4 lg:p-6"
              : "flex min-h-0 min-w-0 flex-1 flex-col"
          }
        >
          {children}
        </div>
      </div>
    </CrumbContext.Provider>
  )
}

const CrumbContext = createContext(false)

/** The `backTo`/`backLabel` a list on a Monitoring page hands its
 * `ListPageShell`: "Monitoring ›" before its title, on every page under
 * /monitoring but the Status page itself. */
export function useMonitoringCrumb(): {
  backTo?: "/monitoring"
  backLabel?: string
} {
  return useContext(CrumbContext)
    ? { backTo: "/monitoring", backLabel: "Monitoring" }
    : {}
}
