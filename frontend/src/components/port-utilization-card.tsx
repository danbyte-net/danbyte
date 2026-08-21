import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

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

export function PortUtilizationCard({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-port-utilization", deviceId],
    queryFn: () => api<Payload>(`/api/devices/${deviceId}/port-utilization/`),
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
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="num">{d.combined.connected}</span> connected
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-500" />
            <span className="num">{d.combined.reserved}</span> reserved
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full border border-border bg-muted" />
            <span className="num">{d.combined.free}</span> free
          </span>
          {d.combined.marked > 0 && (
            <span
              className="flex items-center gap-1"
              title="Marked connected without a documented cable"
            >
              <span className="num">{d.combined.marked}</span> undocumented
            </span>
          )}
        </div>
        {kinds.length > 1 && (
          <div className="mt-3 grid gap-1 border-t border-border pt-2 text-[12px]">
            {kinds.map((k) => {
              const row = d[k as keyof Payload]
              return (
                <div key={k} className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">{KIND_LABEL[k]}</span>
                  <span className="num">
                    {row.connected + row.reserved}/{row.total}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
