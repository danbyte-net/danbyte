import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { PrtgDeviceLink, PrtgSensor } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Acknowledge, pause and resume a PRTG sensor - or pause and resume a whole
// PRTG device - from Danbyte. The server makes the call to PRTG, updates the
// row and journals it on the device or VM; here every surface that shows a
// sensor or a count is refreshed so the pill and the strips follow.

/** How long a pause lasts: minutes, or until resumed. */
const PAUSES: { label: string; minutes: number | null }[] = [
  { label: "Pause for 1 hour", minutes: 60 },
  { label: "Pause for 24 hours", minutes: 24 * 60 },
  { label: "Pause until resumed", minutes: null },
]

/** Down in PRTG and not yet acknowledged. */
export function canAcknowledge(s: PrtgSensor): boolean {
  return !!s.ackable && !s.acknowledged && !s.paused
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    for (const key of [
      "prtg-sensors",
      "prtg-sensor-summary",
      "prtg-links",
      "prtg-pins",
      "prtg-widget-sensor",
      "prtg-widget-alarms",
      "monitoring-bar",
    ])
      void qc.invalidateQueries({ queryKey: [key] })
  }
}

type SensorAct =
  | { kind: "acknowledge"; note: string }
  | { kind: "pause"; minutes: number | null }
  | { kind: "resume" }

function sensorCall(id: string, act: SensorAct) {
  const body =
    act.kind === "acknowledge"
      ? { note: act.note }
      : act.kind === "pause"
        ? { minutes: act.minutes }
        : {}
  return api<PrtgSensor>(`/api/prtg/sensors/${id}/${act.kind}/`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function doneText(act: SensorAct, name: string): string {
  if (act.kind === "acknowledge") return `Acknowledged ${name}`
  if (act.kind === "resume") return `Resumed ${name}`
  return `Paused ${name}`
}

/** The actions on one or many sensors, with one toast for the lot. */
export function useSensorActions() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async ({
      sensors,
      act,
    }: {
      sensors: PrtgSensor[]
      act: SensorAct
    }) => {
      const results = await Promise.allSettled(
        sensors.map((s) => sensorCall(s.id, act))
      )
      const failed = results.filter((r) => r.status === "rejected")
      if (failed.length === sensors.length) throw failed[0].reason
      return { sensors, act, failed: failed.length }
    },
    onSuccess: ({ sensors, act, failed }) => {
      const name =
        sensors.length === 1 ? sensors[0].name : `${sensors.length} sensors`
      if (failed)
        toast.warning(
          `${doneText(act, `${sensors.length - failed} of ${sensors.length} sensors`)}; ${failed} failed`
        )
      else toast.success(doneText(act, name))
    },
    onError: (e) => apiErrorToast(e, "PRTG did not take it"),
    onSettled: refresh,
  })
}

/** Pause or resume a whole PRTG device. */
export function useLinkActions() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({
      link,
      minutes,
      resume,
    }: {
      link: PrtgDeviceLink
      minutes?: number | null
      resume?: boolean
    }) =>
      api<PrtgDeviceLink>(
        `/api/prtg/links/${link.id}/${resume ? "resume" : "pause"}/`,
        {
          method: "POST",
          body: JSON.stringify(resume ? {} : { minutes: minutes ?? null }),
        }
      ),
    onSuccess: (link, { resume }) => {
      toast.success(
        `${resume ? "Resumed" : "Paused"} ${link.name || "the PRTG device"}`
      )
    },
    onError: (e) => apiErrorToast(e, "PRTG did not take it"),
    onSettled: refresh,
  })
}

/** A note for PRTG, then acknowledge. Shared by a card, the panel and the
 * Alarms tab's selection bar. */
export function AcknowledgeDialog({
  sensors,
  onOpenChange,
  onDone,
}: {
  /** The sensors to acknowledge; empty closes the dialog. */
  sensors: PrtgSensor[]
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const [note, setNote] = useState("")
  const act = useSensorActions()
  const open = sensors.length > 0
  const what =
    sensors.length === 1 ? sensors[0].name : `${sensors.length} sensors`
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setNote("")
        onOpenChange(o)
      }}
    >
      <DialogContent
        size="md"
        data-testid="prtg-ack-dialog"
        // Rendered from inside a clickable card: keep its clicks and keys.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Acknowledge {what}</DialogTitle>
          <DialogDescription>In PRTG, with your name.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note"
          aria-label="Note"
          rows={3}
          maxLength={500}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={act.isPending}
            onClick={() =>
              act.mutate(
                { sensors, act: { kind: "acknowledge", note } },
                {
                  onSuccess: () => {
                    setNote("")
                    onOpenChange(false)
                    onDone?.()
                  },
                }
              )
            }
          >
            {act.isPending ? "Acknowledging…" : "Acknowledge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The icon-only trigger every actions menu here uses. */
function MenuTrigger({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className="text-muted-foreground"
            data-testid="prtg-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Acknowledge, pause and resume one sensor, from its card, its panel's
 * header and its row on the Alarms tab. Hidden without `change` on PRTG
 * sensors; the server checks it again.
 */
export function SensorActionsMenu({ sensor }: { sensor: PrtgSensor }) {
  const { canDo } = useMe()
  const act = useSensorActions()
  const [acking, setAcking] = useState(false)
  if (!canDo("prtgsensor", "change")) return null
  const one = [sensor]
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label="Sensor actions" />
        <DropdownMenuContent
          align="end"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {canAcknowledge(sensor) && (
            <>
              <DropdownMenuItem onSelect={() => setAcking(true)}>
                Acknowledge…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {sensor.paused ? (
            <DropdownMenuItem
              disabled={act.isPending}
              onSelect={() =>
                act.mutate({ sensors: one, act: { kind: "resume" } })
              }
            >
              Resume
            </DropdownMenuItem>
          ) : (
            PAUSES.map((p) => (
              <DropdownMenuItem
                key={p.label}
                disabled={act.isPending}
                onSelect={() =>
                  act.mutate({
                    sensors: one,
                    act: { kind: "pause", minutes: p.minutes },
                  })
                }
              >
                {p.label}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AcknowledgeDialog sensors={acking ? one : []} onOpenChange={setAcking} />
    </>
  )
}

/** Pause and resume the PRTG device behind a link - every sensor on it at
 * once. Hidden without `change` on PRTG links. */
export function LinkActionsMenu({ link }: { link: PrtgDeviceLink }) {
  const { canDo } = useMe()
  const act = useLinkActions()
  if (!canDo("prtgdevicelink", "change")) return null
  const paused = link.paused ?? [7, 8, 9, 12].includes(link.status_raw ?? -1)
  return (
    <DropdownMenu>
      <MenuTrigger label="PRTG device actions" />
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {link.name || "PRTG device"}
        </DropdownMenuLabel>
        {paused ? (
          <DropdownMenuItem
            disabled={act.isPending}
            onSelect={() => act.mutate({ link, resume: true })}
          >
            Resume
          </DropdownMenuItem>
        ) : (
          PAUSES.map((p) => (
            <DropdownMenuItem
              key={p.label}
              disabled={act.isPending}
              onSelect={() => act.mutate({ link, minutes: p.minutes })}
            >
              {p.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The Alarms tab's selection bar: acknowledge, pause or resume every
 * selected sensor. */
export function SensorBulkBar({
  selected,
  onCleared,
}: {
  selected: PrtgSensor[]
  onCleared: () => void
}) {
  const { canDo } = useMe()
  const act = useSensorActions()
  const [acking, setAcking] = useState(false)
  if (selected.length === 0 || !canDo("prtgsensor", "change")) return null
  const ackable = selected.filter(canAcknowledge)
  const paused = selected.filter((s) => s.paused)
  const live = selected.filter((s) => !s.paused)
  const run = (sensors: PrtgSensor[], a: SensorAct) =>
    act.mutate({ sensors, act: a }, { onSuccess: onCleared })
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        <div
          className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
          data-testid="prtg-sensor-bulk-bar"
        >
          <span className="px-2 text-xs font-medium">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={ackable.length === 0 || act.isPending}
            onClick={() => setAcking(true)}
          >
            Acknowledge
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={live.length === 0 || act.isPending}
              >
                Pause
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              {PAUSES.map((p) => (
                <DropdownMenuItem
                  key={p.label}
                  onSelect={() =>
                    run(live, { kind: "pause", minutes: p.minutes })
                  }
                >
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={paused.length === 0 || act.isPending}
            onClick={() => run(paused, { kind: "resume" })}
          >
            Resume
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Clear selection"
                onClick={onCleared}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent variant="default">Clear selection</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <AcknowledgeDialog
        sensors={acking ? ackable : []}
        onOpenChange={setAcking}
        onDone={onCleared}
      />
    </>
  )
}
