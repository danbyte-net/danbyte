import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { type CableState } from "@/lib/cable-state"
import { cn } from "@/lib/utils"

// Port utilization for high-port-density gear (issue #64): how full is this
// patch panel / switch, and how much is left. Connected = cabled; reserved =
// cabled with a "planned" cable (earmarked, not yet patched); free = open.
// The total is the server's counted ports (api/port_utilization.py):
// physical interfaces and front ports, virtual interfaces only when the
// deployment counts them, never rear ports.

interface KindRow {
  total: number
  connected: number
  reserved: number
  free: number
  /** Undocumented subset of connected (mark_connected, no cable row). */
  marked: number
}

interface Payload {
  /** Physical interfaces. */
  interfaces: KindRow
  /** Absent from a server older than 0.17. */
  virtual?: KindRow
  front_ports: KindRow
  /** Reported, never counted. */
  rear_ports: KindRow
  /** The counted kinds summed - the headline. */
  combined: KindRow
  /** Whether `combined` includes the virtual interfaces. */
  count_virtual: boolean
}

/** The breakdown rows, in card order. */
type RowKind = "interfaces" | "virtual" | "front_ports"

const KIND_LABEL: Record<RowKind, string> = {
  interfaces: "Interfaces",
  virtual: "Virtual interfaces",
  front_ports: "Front ports",
}

export type PortKind = "interfaces" | "front_ports" | "rear_ports"

/** The port list a row opens - virtual interfaces sit with the rest. */
const LIST_OF: Record<RowKind, PortKind> = {
  interfaces: "interfaces",
  virtual: "interfaces",
  front_ports: "front_ports",
}

const NONE: KindRow = {
  total: 0,
  connected: 0,
  reserved: 0,
  free: 0,
  marked: 0,
}

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
  const virtual = d.virtual ?? NONE
  const row = (k: RowKind) => (k === "virtual" ? virtual : d[k])
  const counted: RowKind[] = d.count_virtual
    ? ["interfaces", "virtual", "front_ports"]
    : ["interfaces", "front_ports"]
  const kinds = counted.filter((k) => row(k).total > 0)

  // The kind holding the most ports in a state - the legend click's target.
  const kindFor = (s: CableState): PortKind => {
    const metric = (r: KindRow) =>
      s === "connected"
        ? r.connected - r.marked
        : s === "reserved"
          ? r.reserved
          : s === "marked"
            ? r.marked
            : r.free
    return LIST_OF[
      counted.reduce(
        (best, k) => (metric(row(k)) > metric(row(best)) ? k : best),
        counted[0]
      )
    ]
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
          {!d.count_virtual && virtual.total > 0 && (
            <span className="px-1 py-0.5">
              <span className="num">{virtual.total}</span> virtual · not counted
            </span>
          )}
        </div>
        {kinds.length > 1 && (
          <div className="mt-3 grid gap-1 border-t border-border pt-2 text-[12px]">
            {kinds.map((k) => {
              const r = row(k)
              const body = (
                <>
                  <span className="text-muted-foreground">{KIND_LABEL[k]}</span>
                  <span className="num">
                    {r.connected + r.reserved}/{r.total}
                  </span>
                </>
              )
              return onPick ? (
                <button
                  key={k}
                  type="button"
                  className="flex items-baseline justify-between rounded-[4px] px-1 py-0.5 hover:bg-muted"
                  title="Open this port list"
                  onClick={() => onPick(null, LIST_OF[k])}
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
