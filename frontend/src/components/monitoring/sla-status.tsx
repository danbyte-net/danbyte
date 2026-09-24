import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { AvailabilityFrame, SlaStatusResponse } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const FRAME_LABEL: Record<AvailabilityFrame, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  mtd: "Month to date",
  qtd: "Quarter to date",
  ytd: "Year to date",
}

const KEY = "danbyte.availability-frame"

function readFrame(): AvailabilityFrame | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && v in FRAME_LABEL ? (v as AvailabilityFrame) : null
  } catch {
    return null
  }
}

/**
 * SLA figures and availability for a list's rows - one POST for the table,
 * like the monitoring roll-up. The frame is the viewer's pick, remembered in
 * this browser, else the tenant's default from monitoring settings.
 */
export function useSlaStatus(
  kind: "device" | "vm" | "ip" | "prefix",
  ids: string[]
) {
  const [picked, setPicked] = useState<AvailabilityFrame | null>(readFrame)
  useEffect(() => {
    try {
      if (picked) localStorage.setItem(KEY, picked)
    } catch {
      // A browser that refuses storage just forgets the pick.
    }
  }, [picked])
  const q = useQuery({
    queryKey: ["sla-status", kind, ids, picked],
    queryFn: () =>
      api<SlaStatusResponse>("/api/monitoring/sla-status/", {
        method: "POST",
        body: JSON.stringify({ kind, ids, frame: picked }),
      }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  })
  return {
    entries: q.data?.results,
    frame: q.data?.frame ?? picked ?? "30d",
    setFrame: setPicked,
  }
}

/** The Availability column's window, for a list page's toolbar. */
export function AvailabilityFramePicker({
  value,
  onChange,
}: {
  value: AvailabilityFrame
  onChange: (v: AvailabilityFrame) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as AvailabilityFrame)}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-auto gap-1.5 text-xs"
        aria-label="Availability window"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(FRAME_LABEL).map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
