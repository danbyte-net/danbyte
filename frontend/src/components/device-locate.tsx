import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Lightbulb, LightbulbOff, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceLeds } from "@/lib/led-state"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Locate = DeviceLeds["locate"]

/**
 * The device page's Locate toggle (docs/dcim/devices.md → Locate): lights
 * the device's blue BEACON LED in the 3D room, the viewers and on its
 * rack-face images for 30 minutes, so whoever stands in the hall can find
 * it. On, it says until when and offers Renew and Off. Each switch is in the
 * device's change log; the server holds the user to change on the device.
 */
export function DeviceLocateButton({
  deviceId,
  locate,
  canChange,
}: {
  deviceId: string
  locate: Locate | undefined
  canChange: boolean
}) {
  const qc = useQueryClient()
  const { formatTime } = useDateFormat()
  const set = useMutation({
    mutationFn: (on: boolean) =>
      api<{ locate: Locate }>(`/api/devices/${deviceId}/locate/`, {
        method: "POST",
        body: JSON.stringify({ on }),
      }),
    onSuccess: (r) => {
      qc.setQueryData<{ locate?: Locate }>(["device", deviceId], (d) =>
        d ? { ...d, locate: r.locate } : d
      )
      void qc.invalidateQueries({ queryKey: ["device", deviceId] })
      void qc.invalidateQueries({ queryKey: ["device-leds"] })
      if (r.locate)
        toast.success(`Locating until ${formatTime(r.locate.until)}`)
      else toast.success("Locate off")
    },
    onError: (err) => apiErrorToast(err, "Couldn't switch the locate beacon"),
  })
  const on = !!locate && new Date(locate.until).getTime() > Date.now()
  if (!on) {
    if (!canChange) return null
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={set.isPending}
        onClick={() => set.mutate(true)}
      >
        <Lightbulb className="h-3.5 w-3.5" />
        {set.isPending ? "Locating…" : "Locate"}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          disabled={set.isPending}
          data-locate-on
        >
          <Lightbulb className="h-3.5 w-3.5 text-blue-500" />
          Locating
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        <DropdownMenuLabel className="font-normal whitespace-nowrap text-muted-foreground">
          Until {formatTime(locate.until)}
          {locate.by ? ` · ${locate.by}` : ""}
        </DropdownMenuLabel>
        {canChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => set.mutate(true)}>
              <RefreshCw className="h-3.5 w-3.5" /> Renew 30 min
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => set.mutate(false)}>
              <LightbulbOff className="h-3.5 w-3.5" /> Locate off
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
