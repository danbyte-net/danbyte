import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SnmpDriftItem, SnmpDriftRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { DriftDescription, driftKey } from "@/components/drift-detail"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

// The SNMP drift list's status pill (#419). Hovering "N drifted" shows what
// differs - fetched when the card opens, never per row on render, and from
// the same query the device page uses, so a visit there reads it from cache.

const SHOWN = 12

export function SnmpDriftStatusBadge({ row }: { row: SnmpDriftRow }) {
  if (row.status === "unreachable")
    return <Badge variant="secondary">Unreachable</Badge>
  if (row.status === "in_sync") return <Badge variant="success">In sync</Badge>
  return <DriftHover row={row} />
}

function DriftHover({ row }: { row: SnmpDriftRow }) {
  const [open, setOpen] = useState(false)
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200}>
      <HoverCardTrigger asChild>
        <Link
          to="/devices/$id"
          params={{ id: row.device }}
          search={{ tab: "snmp" }}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex"
        >
          <Badge variant="warning">{row.drift_count} drifted</Badge>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-96 max-w-[90vw]">
        {open && <DriftList deviceId={row.device} />}
      </HoverCardContent>
    </HoverCard>
  )
}

function DriftList({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-snmp-drift", deviceId],
    queryFn: () =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/drift/`
      ),
    staleTime: 60_000,
  })
  if (q.isLoading) return <Loading className="min-h-16" />
  if (q.isError) return <QueryError error={q.error} />
  const items = q.data?.drift ?? []
  if (items.length === 0)
    return <p className="text-xs text-muted-foreground">In sync now.</p>
  const more = items.length - SHOWN
  return (
    <ul className="space-y-1.5 text-[12px]">
      {items.slice(0, SHOWN).map((it) => (
        <li key={driftKey(it)}>
          <DriftDescription item={it} />
        </li>
      ))}
      {more > 0 && <li className="text-muted-foreground">+{more} more</li>}
    </ul>
  )
}
