import type { ColumnDef } from "@tanstack/react-table"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"

import { api } from "@/lib/api"
import type { PrtgDeviceState } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { PrtgRollup } from "@/components/prtg/links"

// What PRTG says about a device, as a list column: the roll-up of its
// sensors as the state pill, the down and warning sensor counts beside it,
// and a link to the device's page in PRTG. Hidden until ticked.

const RANK: Record<string, number> = {
  down: 4,
  degraded: 3,
  up: 2,
  unknown: 1,
}

/** The device list's PRTG roll-ups, fetched once per table and only while
 * the integration is on. */
export function usePrtgDeviceStates():
  Record<string, PrtgDeviceState> | undefined {
  return usePrtgStates("device-states")
}

/** The same for the VM list. */
export function usePrtgVmStates(): Record<string, PrtgDeviceState> | undefined {
  return usePrtgStates("vm-states")
}

function usePrtgStates(
  path: "device-states" | "vm-states"
): Record<string, PrtgDeviceState> | undefined {
  const toggles = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
  })
  const on = !!toggles.data?.prtg
  const states = useQuery({
    queryKey: [`prtg-${path}`],
    queryFn: () => api<Record<string, PrtgDeviceState>>(`/api/prtg/${path}/`),
    enabled: on,
    staleTime: 60_000,
  })
  return on ? states.data : undefined
}

export function prtgColumn<T extends { id: string }>(
  states: Record<string, PrtgDeviceState>
): ColumnDef<T, unknown> {
  return {
    id: "prtg",
    accessorFn: (r) => RANK[states[r.id]?.state ?? ""] ?? 0,
    header: ({ column }) => <SortHeader column={column} label="PRTG" />,
    cell: ({ row }) => {
      const s = states[row.original.id]
      if (!s) return dash
      return (
        <span className="inline-flex items-center gap-1.5">
          <PrtgRollup state={s.state} down={s.down} warning={s.warning} />
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Open ${s.name || "device"} in PRTG`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </span>
      )
    },
    meta: { defaultHidden: true },
  }
}
