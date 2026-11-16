import { Link, useNavigate } from "@tanstack/react-router"
import { CalendarPlus } from "lucide-react"

import type { DependencyImpact } from "@/lib/api"
import { AffectedLevel } from "@/components/affected-panel"
import { BarButton } from "@/components/map-toolbar"
import { PanelSection, PanelShell } from "@/components/map-panel"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

// The Topology map's "What if this fails?" panel (#450): the impact of one
// device's failure, beside the rings it puts on the cards. Down first, then
// reduced redundancy, each a link to its device; Plan maintenance opens a
// new event with these impacts.

export function WhatIfPanel({
  device,
  query,
  onClose,
}: {
  device: { id: string; name: string }
  query: { data?: DependencyImpact; isLoading: boolean; error: unknown }
  onClose: () => void
}) {
  const nav = useNavigate()
  const data = query.data
  const outage = data?.devices.filter((d) => d.level === "outage") ?? []
  const reduced = data?.devices.filter((d) => d.level !== "outage") ?? []
  const rows = (list: DependencyImpact["devices"]) => (
    <ul className="grid gap-0.5">
      {list.map((d) => (
        <li key={d.id} className="flex items-baseline justify-between gap-3">
          <Link
            to="/devices/$id"
            params={{ id: d.id }}
            className="link min-w-0 truncate text-[12px]"
          >
            {d.name}
          </Link>
          <AffectedLevel level={d.level} />
        </li>
      ))}
    </ul>
  )
  return (
    <PanelShell
      label="What if this fails"
      title={`If ${device.name} fails`}
      onClose={onClose}
      footer={
        <BarButton
          onClick={() =>
            nav({
              to: "/maintenance/new",
              search: { affected_kind: "device", affected_id: device.id },
            })
          }
        >
          <CalendarPlus /> Plan maintenance
        </BarButton>
      }
    >
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : data && data.devices.length === 0 ? (
        <p className="text-muted-foreground">Nothing depends on it.</p>
      ) : (
        <>
          {outage.length > 0 && (
            <PanelSection label={`Down · ${outage.length}`}>
              {rows(outage)}
            </PanelSection>
          )}
          {reduced.length > 0 && (
            <PanelSection label={`Reduced redundancy · ${reduced.length}`}>
              {rows(reduced)}
            </PanelSection>
          )}
          {data?.truncated && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Showing the first {data.devices.length}.
            </p>
          )}
        </>
      )}
    </PanelShell>
  )
}
