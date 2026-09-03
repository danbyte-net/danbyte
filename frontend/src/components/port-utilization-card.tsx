import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { type CableState } from "@/lib/cable-state"
import { cn } from "@/lib/utils"

// Port utilization for high-port-density gear (issue #64): how full is this
// patch panel / switch, and how much is left. Connected = cabled; reserved =
// cabled with a "planned" cable (earmarked, not yet patched); free = open.

interface KindRow {
  total: number
  connected: number
  reserved: number
  free: number
  /** Undocumented subset of connected (mark_connected, no cable row). */
  marked: number
}

interface Payload {
  interfaces: KindRow
  front_ports: KindRow
  rear_ports: KindRow
  combined: KindRow
}

const KIND_LABEL: Record<string, string> = {
  interfaces: "Interfaces",
  front_ports: "Front ports",
  rear_ports: "Rear ports",
}

export type PortKind = "interfaces" | "front_ports" | "rear_ports"

export function PortUtilizationCard({
  deviceId,
  vcId,
  onHoverState,
  onPick,
}: {
  deviceId?: string
  /** A whole stack instead of one device - the members' ports summed. */
  vcId?: string
  /** Hovering a legend entry - lights matching ports on the panel. */
  onHoverState?: (s: CableState | null) => void
  /** Clicking a legend entry (state + the kind holding most of it) or a
   * per-kind row (kind only). */
  onPick?: (s: CableState | null, kind: PortKind) => void
}) {
  const q = useQuery({
    queryKey: vcId
      ? ["vc-port-utilization", vcId]
      : ["device-port-utilization", deviceId],
    queryFn: () =>
      api<Payload>(
        vcId
          ? `/api/virtual-chassis/${vcId}/port-utilization/`
          : `/api/devices/${deviceId}/port-utilization/`
      ),
    enabled: !!(vcId || deviceId),
    staleTime: 60_000,
  })
  const d = q.data
  if (!d || d.combined.total === 0) return null
  const used = d.combined.connected + d.combined.reserved
  const pct = Math.round((used / d.combined.total) * 100)
  const w = (n: number) => `${(n / d.combined.total) * 100}%`
  const kinds = (Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).filter(
    (k) => d[k as keyof Payload].total > 0
  )

  // The kind holding the most ports in a state - the legend click's target.
  const kindFor = (s: CableState): PortKind => {
    const metric = (row: KindRow) =>
      s === "connected"
        ? row.connected - row.marked
        : s === "reserved"
          ? row.reserved
          : s === "marked"
            ? row.marked
            : row.free
    return (["interfaces", "front_ports", "rear_ports"] as PortKind[]).reduce(
      (best, k) => (metric(d[k]) > metric(d[best]) ? k : best),
      "interfaces" as PortKind
    )
  }
  const legend = (s: CableState, body: React.ReactNode, extra?: string) =>
    onPick ? (
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-[4px] px-1 py-0.5",
          "hover:bg-muted hover:text-foreground"
        )}
        title="Click to list these ports; hovering highlights them on the panel"
        onMouseEnter={() => onHoverState?.(s)}
        onMouseLeave={() => onHoverState?.(null)}
        onFocus={() => onHoverState?.(s)}
        onBlur={() => onHoverState?.(null)}
        onClick={() => onPick(s, kindFor(s))}
      >
        {body}
      </button>
    ) : (
      <span className="flex items-center gap-1.5 px-1 py-0.5" title={extra}>
        {body}
      </span>
    )

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Port utilization
      </h2>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between text-sm">
          <span>
            <span className="num font-medium">{used}</span>{" "}
            <span className="text-muted-foreground">of</span>{" "}
            <span className="num">{d.combined.total}</span>{" "}
            <span className="text-muted-foreground">ports used</span>
          </span>
          <span className="num text-muted-foreground">{pct}%</span>
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted">
          <span
            className="bg-emerald-500"
            style={{ width: w(d.combined.connected) }}
          />
          <span
            className="bg-amber-500"
            style={{ width: w(d.combined.reserved) }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {legend(
            "connected",
            <>
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="num">{d.combined.connected}</span> connected
            </>
          )}
          {legend(
            "reserved",
            <>
              <span className="size-2 rounded-full bg-amber-500" />
              <span className="num">{d.combined.reserved}</span> reserved
            </>
          )}
          {legend(
            "free",
            <>
              <span className="size-2 rounded-full border border-border bg-muted" />
              <span className="num">{d.combined.free}</span> free
            </>
          )}
          {d.combined.marked > 0 &&
            legend(
              "marked",
              <>
                <span className="num">{d.combined.marked}</span> undocumented
              </>,
              "Marked connected without a documented cable"
            )}
        </div>
        {kinds.length > 1 && (
          <div className="mt-3 grid gap-1 border-t border-border pt-2 text-[12px]">
            {kinds.map((k) => {
              const row = d[k as keyof Payload]
              const body = (
                <>
                  <span className="text-muted-foreground">{KIND_LABEL[k]}</span>
                  <span className="num">
                    {row.connected + row.reserved}/{row.total}
                  </span>
                </>
              )
              return onPick ? (
                <button
                  key={k}
                  type="button"
                  className="flex items-baseline justify-between rounded-[4px] px-1 py-0.5 hover:bg-muted"
                  title="Open this port list"
                  onClick={() => onPick(null, k as PortKind)}
                >
                  {body}
                </button>
              ) : (
                <div
                  key={k}
                  className="flex items-baseline justify-between px-1 py-0.5"
                >
                  {body}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
