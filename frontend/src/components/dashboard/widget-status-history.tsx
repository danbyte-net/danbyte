import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQueries } from "@tanstack/react-query"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import type { DeviceTimeline, IpTimeline } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { HISTORY_WINDOWS } from "@/components/monitoring/history-panel"
import { StatusStrip } from "@/components/monitoring/status-strip"

/** One chosen thing on the widget: an address or a device, with the label
 * it was picked under so the row reads without another fetch. */
export interface WatchedTarget {
  kind: "ip" | "device"
  id: string
  label: string
}

export interface StatusHistoryConfig {
  targets?: WatchedTarget[]
  hours?: number
}

const MAX_TARGETS = 12
const DEFAULT_HOURS = 168

function tier(pct: number | null): string {
  if (pct == null) return "text-muted-foreground"
  if (pct >= 99.9) return "text-emerald-600 dark:text-emerald-400"
  if (pct >= 99) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

/** Dashboard widget: the status strip of the addresses and devices you
 * chose, over one window - the same strip and figure as their Monitoring
 * tabs, side by side. Pick them while editing the dashboard; the widget
 * keeps its own list, so several can watch different things. */
export function StatusHistoryWidget({
  config,
  editing,
  onChange,
}: {
  config?: StatusHistoryConfig
  editing?: boolean
  onChange?: (c: StatusHistoryConfig) => void
}) {
  const targets = config?.targets ?? []
  const hours = config?.hours ?? DEFAULT_HOURS
  const [adding, setAdding] = useState<"ip" | "device">("ip")

  const rows = useQueries({
    queries: targets.map((t) => ({
      queryKey: ["monitoring-timeline", `${t.kind}s/${t.id}`, hours],
      queryFn: () =>
        api<IpTimeline | DeviceTimeline>(
          `/api/monitoring/${t.kind}s/${t.id}/timeline/?hours=${hours}`
        ),
      refetchInterval: 60_000,
    })),
  })

  const save = (patch: StatusHistoryConfig) =>
    onChange?.({ targets, hours, ...patch })
  const add = (kind: "ip" | "device", id: string, label: string) => {
    if (targets.some((t) => t.kind === kind && t.id === id)) return
    if (targets.length >= MAX_TARGETS) return
    save({ targets: [...targets, { kind, id, label }] })
  }
  const remove = (t: WatchedTarget) =>
    save({ targets: targets.filter((x) => !(x.kind === t.kind && x.id === t.id)) })

  return (
    <div className="flex h-full min-h-[120px] flex-col gap-2">
      {editing && onChange && (
        <div className="space-y-2 rounded-md border border-dashed border-border p-2">
          <div className="flex items-center gap-2">
            <SegmentedTabs<"ip" | "device">
              value={adding}
              onValueChange={setAdding}
              items={[
                { value: "ip", label: "IP" },
                { value: "device", label: "Device" },
              ]}
            />
            <SegmentedTabs
              value={String(hours)}
              onValueChange={(v) => save({ hours: Number(v) })}
              items={HISTORY_WINDOWS.map((w) => ({
                value: String(w.hours),
                label: w.label,
              }))}
            />
          </div>
          {adding === "ip" ? (
            <IpPicker
              label="Add an address"
              value={null}
              onChange={() => undefined}
              onPickLabel={(id, label) => add("ip", id, label)}
              excludeIds={targets.filter((t) => t.kind === "ip").map((t) => t.id)}
              placeholder={
                targets.length >= MAX_TARGETS
                  ? `${MAX_TARGETS} at most`
                  : "Search address, DNS name…"
              }
              disabled={targets.length >= MAX_TARGETS}
            />
          ) : (
            <DevicePicker
              label="Add a device"
              value={null}
              onChange={() => undefined}
              onPickLabel={(id, label) => add("device", id, label)}
              excludeIds={targets
                .filter((t) => t.kind === "device")
                .map((t) => t.id)}
              disabled={targets.length >= MAX_TARGETS}
            />
          )}
        </div>
      )}
      {!targets.length ? (
        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
          {editing
            ? "Pick the addresses and devices to watch."
            : "Nothing chosen yet - edit the dashboard to pick addresses and devices."}
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {targets.map((t, i) => {
            const tl = rows[i].data
            const pct = tl?.summary.uptime_pct ?? null
            return (
              <li
                key={`${t.kind}:${t.id}`}
                className="flex items-center gap-3 py-1.5 text-[13px]"
              >
                {t.kind === "ip" ? (
                  <Link
                    to="/ips/$id"
                    params={{ id: t.id }}
                    search={{ tab: "monitoring" }}
                    className="link w-40 shrink-0 truncate font-mono"
                  >
                    {t.label}
                  </Link>
                ) : (
                  <Link
                    to="/devices/$id"
                    params={{ id: t.id }}
                    search={{ tab: "monitoring" }}
                    className="link w-40 shrink-0 truncate font-medium"
                  >
                    {t.label}
                  </Link>
                )}
                <div className="min-w-0 flex-1">
                  {tl ? (
                    <StatusStrip
                      segments={tl.rollup}
                      since={tl.since}
                      until={tl.until}
                    />
                  ) : (
                    <div className="h-2 rounded-sm bg-muted/40" />
                  )}
                </div>
                <span className={`num w-14 shrink-0 text-right text-xs ${tier(pct)}`}>
                  {pct == null ? "-" : `${pct.toFixed(pct >= 99.9 ? 2 : 1)}%`}
                </span>
                {editing && onChange && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label={`Remove ${t.label}`}
                    onClick={() => remove(t)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!editing && targets.length > 0 && (
        <div className="mt-auto pt-1 text-right text-[11px] text-muted-foreground">
          last {HISTORY_WINDOWS.find((w) => w.hours === hours)?.label ?? `${hours}h`}
        </div>
      )}
    </div>
  )
}
