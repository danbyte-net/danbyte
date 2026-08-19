import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Unlink } from "lucide-react"

import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * The `↔ eth0` chip on a port that's been linked to a discovered SNMP name -
 * and the way back out. Without an unlink here the mapping was a one-way door:
 * visible, but only re-linking to some other port could change it.
 *
 * Rendered wherever interfaces are listed, so the undo sits on the thing it
 * undoes rather than in a field buried in the edit form.
 */
export function SnmpLinkBadge({
  iface,
}: {
  iface: { id: string; snmp_name: string; device: { id: string } }
}) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const unlink = useMutation({
    mutationFn: () =>
      api(`/api/interfaces/${iface.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ snmp_name: "" }),
      }),
    onSuccess: () => {
      toast.success(`Unlinked ${iface.snmp_name}`)
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["device-interfaces", iface.device.id] })
      qc.invalidateQueries({ queryKey: ["device-snmp-drift", iface.device.id] })
      setOpen(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const chip = (
    <Badge
      variant="outline"
      className="h-4 px-1.5 font-mono text-[10px]"
      title={`Discovered over SNMP as "${iface.snmp_name}"`}
    >
      ↔ {iface.snmp_name}
    </Badge>
  )

  if (!canWrite) return chip

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          title={`Discovered over SNMP as "${iface.snmp_name}" - click to unlink`}
        >
          {chip}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2 p-3">
        <p className="text-[13px]">
          This port is linked to{" "}
          <span className="font-mono">{iface.snmp_name}</span>.
        </p>
        <p className="text-[11px] text-muted-foreground">
          Unlink it and discovery goes back to reporting the pair as one new and
          one missing interface, until you link them again.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate()}
        >
          <Unlink className="h-3.5 w-3.5" />
          {unlink.isPending ? "Unlinking..." : "Unlink"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
