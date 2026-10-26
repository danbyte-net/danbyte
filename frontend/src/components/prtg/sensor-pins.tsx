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
import type { PrtgChannels, PrtgSensor, PrtgSensorPin } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { Loading } from "@/components/loading"
import { ChannelReading, pickChannel } from "./channel-view"
import type { PrtgParent } from "./sensors-tab"

// Channels pinned to a device's or VM's Overview: the toggle on a channel
// card in the sensor panel, and the Overview's Sensors card that draws them.

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
    mutationFn: (body: { sensor: string; channel_id: string }) =>
      api<PrtgSensorPin>("/api/prtg/sensor-pins/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e, "Could not pin the channel"),
  })
  const unpin = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/sensor-pins/${id}/`, { method: "DELETE" }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e, "Could not unpin the channel"),
  })
  return { pin, unpin }
}

/** "Pin to Overview" on a channel card in the sensor panel. Hidden without
 * the grant; the server checks it again. */
export function PinToggle({
  sensor,
  channelId,
}: {
  sensor: PrtgSensor
  channelId: string
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
          data-testid="prtg-pin-toggle"
          className={cn(!mine && "text-muted-foreground")}
          onClick={() =>
            mine
              ? unpin.mutate(mine.id)
              : pin.mutate({ sensor: sensor.id, channel_id: channelId })
          }
        >
          {mine ? <PinOff /> : <Pin />}
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The Overview's Sensors card: every pinned channel as a small tile - the
 * channel's reading, its name and its sensor - in a responsive grid of
 * equal-height tiles. A tile opens the sensor's panel; unpin sits in its
 * corner on hover. Absent when nothing is pinned.
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
            >
              {sensorLink(
                p.sensor,
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
                      <ChannelReading channel={c} display={p.display} compact />
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
