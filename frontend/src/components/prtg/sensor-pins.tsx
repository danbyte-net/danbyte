import { createContext, useContext } from "react"
import type { ReactNode } from "react"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Pin, PinOff, X } from "lucide-react"

import { ApiError, api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import type {
  PrtgChannel,
  PrtgChannels,
  PrtgHistory,
  PrtgSensor,
  PrtgSensorPin,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { formatGaugeValue } from "@/components/gauge"
import { Loading } from "@/components/loading"
import { Sparkline } from "@/components/sparkline"
import {
  ChannelReading,
  channelText,
  isNumeric,
  pickChannel,
  seriesFor,
  trendOf,
} from "./channel-view"
import type { PrtgParent } from "./sensors-tab"

// Sensors and channels pinned to an object's Overview - the sensor's device
// or VM, or the address, interface or service it watches: the toggles on a
// sensor card, the sensor panel's header and a channel card, and the
// Overview's Sensors card that draws them.

/** The object a pin sits on. Only a sensor linked to an address, interface
 * or service may be pinned on it; the server says so otherwise. */
export type PinParent =
  | PrtgParent
  | { ip_address: string }
  | { interface: string }
  | { vm_interface: string }
  | { service: string }

function parentEntry(parent: PinParent): [string, string] {
  return Object.entries(parent)[0]
}

function parentQuery(parent: PinParent): string {
  const [key, value] = parentEntry(parent)
  return `${key}=${encodeURIComponent(value)}`
}

/** "this address's", for an object other than a device or VM. */
const OWN_OVERVIEW: Record<string, string> = {
  ip_address: "this address's Overview",
  interface: "this interface's Overview",
  vm_interface: "this interface's Overview",
  service: "this service's Overview",
}

/** The toggle's label on a parent: plain "Overview" on a device or VM. */
export function pinLabel(parent: PinParent | null, pinned: boolean): string {
  const where = (parent && OWN_OVERVIEW[parentEntry(parent)[0]]) || "Overview"
  return pinned ? `Unpin from ${where}` : `Pin to ${where}`
}

const PinScope = createContext<PinParent | null>(null)

/** Inside an address's, interface's or service's sensors section: the
 * toggles pin to that object instead of the sensor's device or VM. */
export function PinScopeProvider({
  scope,
  children,
}: {
  scope: PinParent | null
  children: ReactNode
}) {
  return <PinScope.Provider value={scope}>{children}</PinScope.Provider>
}

/** The device or VM a sensor belongs to. */
export function sensorParent(s: PrtgSensor): PrtgParent | null {
  if (s.device) return { device: s.device.id }
  if (s.virtual_machine) return { virtual_machine: s.virtual_machine.id }
  return null
}

/** The object's pins in order. Empty while the integration is off or the
 * caller has no grant on pins - the Overview simply shows no card. */
export function usePins(parent: PinParent | null) {
  const qs = parent ? parentQuery(parent) : ""
  return useQuery({
    queryKey: ["prtg-pins", qs],
    queryFn: async () => {
      try {
        return (await apiAll<PrtgSensorPin>(`/api/prtg/sensor-pins/?${qs}`))
          .results
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403))
          return [] as PrtgSensorPin[]
        throw e
      }
    },
    enabled: !!parent,
    staleTime: 60_000,
  })
}

function usePinMutations(parent: PinParent | null) {
  const qc = useQueryClient()
  const key = ["prtg-pins", parent ? parentQuery(parent) : ""]
  const done = () => qc.invalidateQueries({ queryKey: key })
  // A device or VM pin names no object: the server takes the sensor's own.
  const target =
    parent && !("device" in parent) && !("virtual_machine" in parent)
      ? parent
      : {}
  const pin = useMutation({
    mutationFn: (body: { sensor: string; channel_id?: string }) =>
      api<PrtgSensorPin>("/api/prtg/sensor-pins/", {
        method: "POST",
        body: JSON.stringify({ ...body, ...target }),
      }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e, "Could not pin to the Overview"),
  })
  const unpin = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/sensor-pins/${id}/`, { method: "DELETE" }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e, "Could not unpin from the Overview"),
  })
  return { pin, unpin }
}

/** "Pin to Overview" on a channel card in the sensor panel, or - without a
 * channel - on a sensor card and the panel's header, for the whole sensor.
 * It pins to the scope it is rendered in: `scope`, else the nearest
 * `PinScopeProvider` (an address's, interface's or service's sensors), else
 * the sensor's device or VM. Hidden without the grant; the server checks it
 * again. */
export function PinToggle({
  sensor,
  channelId = "",
  scope,
}: {
  sensor: PrtgSensor
  /** The channel's PRTG id; blank for the whole sensor. */
  channelId?: string
  scope?: PinParent | null
}) {
  const { canDo } = useMe()
  const provided = useContext(PinScope)
  const parent = scope ?? provided ?? sensorParent(sensor)
  const pins = usePins(parent)
  const { pin, unpin } = usePinMutations(parent)
  if (!parent || !canDo("prtgsensorpin", "change")) return null
  const mine = (pins.data ?? []).find(
    (p) => p.sensor === sensor.id && p.channel_id === channelId
  )
  const busy = pin.isPending || unpin.isPending || pins.isLoading
  const label = pinLabel(parent, !!mine)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={!!mine}
          disabled={busy}
          data-testid={channelId ? "prtg-pin-toggle" : "prtg-sensor-pin-toggle"}
          className={cn(!mine && "text-muted-foreground")}
          onClick={(e) => {
            // On a sensor card: toggle the pin, do not open the panel.
            e.stopPropagation()
            if (mine) unpin.mutate(mine.id)
            else
              pin.mutate(
                channelId
                  ? { sensor: sensor.id, channel_id: channelId }
                  : { sensor: sensor.id }
              )
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {mine ? <PinOff /> : <Pin />}
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The primary channel's value as the tile's big number: the number and
 * its unit apart, a lookup's label, a text's text. */
function PrimaryValue({
  channel: c,
  fallback,
}: {
  channel: PrtgChannel | undefined
  fallback: string
}) {
  if (c && isNumeric(c) && c.value_raw != null)
    return (
      <p className="truncate leading-none" data-testid="prtg-sensor-tile-value">
        <span className="num text-2xl font-semibold tracking-tight">
          {formatGaugeValue(c.value_raw)}
        </span>
        {c.unit && (
          <span className="ml-1 text-sm text-muted-foreground">{c.unit}</span>
        )}
      </p>
    )
  const text = c ? channelText(c) : fallback
  return text ? (
    <p
      className="truncate text-lg leading-tight font-semibold"
      data-testid="prtg-sensor-tile-value"
    >
      {text}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">No value</p>
  )
}

/**
 * A whole sensor on the Overview: its name and kind, the state pill, the
 * primary channel's value as the big number with the hour's sparkline under
 * it (none when the value held still), and the last check.
 */
function SensorTile({
  pin: p,
  channels,
  history,
  inset,
}: {
  pin: PrtgSensorPin
  channels: PrtgChannels | undefined
  history: PrtgHistory | undefined
  /** Room for the unpin button in the corner. */
  inset: boolean
}) {
  const info = p.sensor_info
  const c = pickChannel(channels?.rows, "")
  const trend = c ? trendOf(c, seriesFor(history, c.id)) : null
  return (
    <div
      className="flex h-full flex-col gap-1 rounded-md border border-border p-2 transition-colors hover:bg-muted/40"
      data-testid="prtg-sensor-tile"
    >
      <div className={cn("flex min-w-0 items-start gap-1", inset && "pr-5")}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{info.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {info.kind_label}
          </p>
        </div>
        {info.paused ? (
          <Badge variant="outline">Paused</Badge>
        ) : (
          <CheckStatusBadge status={info.state} />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1">
        <PrimaryValue channel={c} fallback={info.last_value} />
        {trend?.kind === "line" && (
          <Sparkline
            values={trend.values}
            label={`${c!.name}, last 1h`}
            fill
            height={20}
          />
        )}
      </div>
      {info.last_check_at && (
        <p className="truncate text-[11px] whitespace-nowrap text-muted-foreground">
          checked <TimeCell iso={info.last_check_at} />
        </p>
      )}
    </div>
  )
}

/**
 * The Overview's Sensors card: every pinned sensor and channel as a small
 * tile in one responsive grid of equal-height tiles. A sensor tile shows the
 * sensor at a glance (see `SensorTile`); a channel tile the channel's
 * reading, its name and its sensor. A tile opens the sensor's panel; unpin
 * sits in its corner on hover. Absent when nothing is pinned.
 */
export function PinnedSensorsCard({
  parent,
  sensorLink,
}: {
  parent: PinParent
  /** Wraps a tile in a link to the Sensors tab with that sensor's panel. */
  sensorLink: (sensorId: string, children: ReactNode) => ReactNode
}) {
  const { canDo } = useMe()
  const pins = usePins(parent)
  const { unpin } = usePinMutations(parent)
  const rows = pins.data ?? []
  const sensorIds = [...new Set(rows.map((p) => p.sensor))]
  const wholeIds = [
    ...new Set(rows.filter((p) => !p.channel_id).map((p) => p.sensor)),
  ]
  // The hour's history, for the sparkline on a whole sensor's tile.
  const histories = useQueries({
    queries: wholeIds.map((id) => ({
      queryKey: ["prtg-history", id, "1h"],
      queryFn: () =>
        api<PrtgHistory>(`/api/prtg/sensors/${id}/history/?range=1h`),
      staleTime: 60_000,
      refetchInterval: 2 * 60_000,
      retry: false,
    })),
  })
  const channels = useQueries({
    queries: sensorIds.map((id) => ({
      queryKey: ["prtg-channels", id],
      queryFn: () => api<PrtgChannels>(`/api/prtg/sensors/${id}/channels/`),
      staleTime: 60_000,
      refetchInterval: 2 * 60_000,
      retry: false,
    })),
  })
  if (rows.length === 0) return null
  const bySensor = new Map(sensorIds.map((id, i) => [id, channels[i]]))
  const historyOf = new Map(wholeIds.map((id, i) => [id, histories[i]]))
  const canUnpin = canDo("prtgsensorpin", "change")
  return (
    <section
      className="rounded-lg border border-border bg-card px-4 py-3"
      data-testid="prtg-pinned-sensors"
    >
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Sensors
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {rows.map((p) => {
          const q = bySensor.get(p.sensor)
          const c = pickChannel(q?.data?.rows, p.channel_id)
          return (
            <div
              key={p.id}
              className="group relative h-[136px] min-w-0"
              data-testid="prtg-pin-tile"
              data-whole={p.channel_id ? undefined : ""}
            >
              {sensorLink(
                p.sensor,
                !p.channel_id ? (
                  <SensorTile
                    pin={p}
                    channels={q?.data}
                    history={historyOf.get(p.sensor)?.data}
                    inset={canUnpin}
                  />
                ) : (
                  <div className="flex h-full flex-col gap-1 rounded-md border border-border p-2 transition-colors hover:bg-muted/40">
                    <div
                      className={cn(
                        "flex min-w-0 items-start gap-1",
                        canUnpin && "pr-5"
                      )}
                    >
                      <p className="min-w-0 flex-1 truncate text-xs font-medium">
                        {c?.name ?? p.sensor_info.name}
                      </p>
                      {p.sensor_info.state !== "up" && (
                        <CheckStatusBadge status={p.sensor_info.state} />
                      )}
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      {q?.isLoading ? (
                        <Loading className="min-h-0" />
                      ) : c ? (
                        <ChannelReading
                          channel={c}
                          display={p.display}
                          compact
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No data
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {p.sensor_info.name}
                    </p>
                  </div>
                )
              )}
              {canUnpin && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Unpin from Overview"
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      disabled={unpin.isPending}
                      onClick={() => unpin.mutate(p.id)}
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent variant="default">
                    Unpin from Overview
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * The Sensors card on an address's, interface's or service's Overview: the
 * same tiles, each opening the sensor's panel on the page's Sensors tab
 * through `onOpen`. Absent when nothing is pinned.
 */
export function ObjectPinnedSensors({
  parent,
  onOpen,
}: {
  parent: PinParent
  onOpen: (sensorId: string) => void
}) {
  return (
    <PinnedSensorsCard
      parent={parent}
      sensorLink={(sensor, children) => (
        <div
          role="button"
          tabIndex={0}
          className="block h-full cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => onOpen(sensor)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onOpen(sensor)
            }
          }}
        >
          {children}
        </div>
      )}
    />
  )
}
