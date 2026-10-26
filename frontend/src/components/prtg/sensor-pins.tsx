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
import { TimeCell } from "@/components/cells/time-ago"
import { StatePill } from "@/components/monitoring/mixed-status-badge"
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
import { TileCorner } from "./tile-corner"

// Sensors and channels pinned to a device's or VM's Overview: the toggles on
// a sensor card, the sensor panel's header and a channel card, and the
// Overview's Sensors card that draws them.

function parentQuery(parent: PrtgParent): string {
  return "device" in parent
    ? `device=${parent.device}`
    : `virtual_machine=${parent.virtual_machine}`
}

/** The device or VM a sensor belongs to. */
export function sensorParent(s: PrtgSensor): PrtgParent | null {
  if (s.device) return { device: s.device.id }
  if (s.virtual_machine) return { virtual_machine: s.virtual_machine.id }
  return null
}

/** The object's pins in order. Empty while the integration is off or the
 * caller has no grant on pins - the Overview simply shows no card. */
export function usePins(parent: PrtgParent | null) {
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

function usePinMutations(parent: PrtgParent | null) {
  const qc = useQueryClient()
  const key = ["prtg-pins", parent ? parentQuery(parent) : ""]
  const done = () => qc.invalidateQueries({ queryKey: key })
  const pin = useMutation({
    mutationFn: (body: { sensor: string; channel_id?: string }) =>
      api<PrtgSensorPin>("/api/prtg/sensor-pins/", {
        method: "POST",
        body: JSON.stringify(body),
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
 * Hidden without the grant; the server checks it again. */
export function PinToggle({
  sensor,
  channelId = "",
}: {
  sensor: PrtgSensor
  /** The channel's PRTG id; blank for the whole sensor. */
  channelId?: string
}) {
  const { canDo } = useMe()
  const parent = sensorParent(sensor)
  const pins = usePins(parent)
  const { pin, unpin } = usePinMutations(parent)
  if (!parent || !canDo("prtgsensorpin", "change")) return null
  const mine = (pins.data ?? []).find(
    (p) => p.sensor === sensor.id && p.channel_id === channelId
  )
  const busy = pin.isPending || unpin.isPending || pins.isLoading
  const label = mine ? "Unpin from Overview" : "Pin to Overview"
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
/** A pinned sensor's one state, PRTG's own word in the shared tooltip. */
function PinState({ pin: p }: { pin: PrtgSensorPin }) {
  const info = p.sensor_info
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" data-testid="prtg-sensor-state">
          <StatePill state={info.paused ? "paused" : info.state} />
        </span>
      </TooltipTrigger>
      <TooltipContent variant="default">
        {info.status || "Unknown"} in PRTG
      </TooltipContent>
    </Tooltip>
  )
}

/** The room the unpin button needs in a tile's corner: an empty 24px slot
 * the pill slides away from. The button itself sits over it, outside the
 * tile's link. */
const UNPIN_SLOT = <span aria-hidden className="size-6" />

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
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{info.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {info.kind_label}
          </p>
        </div>
        <TileCorner
          className="-mt-1 -mr-1"
          state={<PinState pin={p} />}
          controls={inset ? [UNPIN_SLOT] : []}
        />
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
  parent: PrtgParent
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
              className="group/tile relative h-[136px] min-w-0"
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
                    <div className="flex min-w-0 items-start gap-1">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium">
                        {c?.name ?? p.sensor_info.name}
                      </p>
                      <TileCorner
                        className="-mt-1 -mr-1"
                        state={
                          c?.status ? (
                            <CheckStatusBadge status={c.state} />
                          ) : (
                            <PinState pin={p} />
                          )
                        }
                        controls={canUnpin ? [UNPIN_SLOT] : []}
                      />
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
                      className="absolute top-1 right-1 opacity-0 transition-opacity duration-150 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
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
