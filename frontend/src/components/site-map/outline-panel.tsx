import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SiteMapOutline, SiteMapOutlineDrilldown } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { OpenLink } from "@/components/open-link"
import { QueryError } from "@/components/query-error"

import { outlineColor } from "./outlines-layer"

/** An outline clicked while viewing: its location, what stands in it, and
 * its floor plans - the map → building → floor plan drill-down. */
export function OutlinePanel({
  outline,
  onClose,
}: {
  outline: SiteMapOutline
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ["site-map-outline-drilldown", outline.id],
    queryFn: () =>
      api<SiteMapOutlineDrilldown>(
        `/api/site-map-outlines/${outline.id}/drilldown/`
      ),
    staleTime: 30_000,
  })
  const loc = outline.location
  const name = outline.display_label || loc?.name || "Outline"
  const d = q.data
  return (
    <PanelShell
      label={loc ? "Location" : "Outline"}
      title={
        <ColorBadge
          name={name}
          color={outlineColor(outline)}
          className="max-w-64"
        />
      }
      titleText={name}
      onClose={onClose}
      footer={
        d?.open_floor_id || loc ? (
          <>
            {d?.open_floor_id && (
              <OpenLink to="/floorplans/$id" params={{ id: d.open_floor_id }}>
                Open floor plan
              </OpenLink>
            )}
            {loc && (
              <OpenLink to="/locations/$id" params={{ id: loc.id }}>
                Open location
              </OpenLink>
            )}
          </>
        ) : undefined
      }
    >
      {loc && (
        <>
          {loc.name !== name && (
            <PanelRow label="Location">{loc.name}</PanelRow>
          )}
          {loc.location_type && (
            <PanelRow label="Type">
              <ColorBadge
                name={loc.location_type.name}
                color={loc.location_type.color || undefined}
              />
            </PanelRow>
          )}
          {loc.code && (
            <PanelRow label="Code">
              <span className="font-mono">{loc.code}</span>
            </PanelRow>
          )}
        </>
      )}
      {!loc && (
        <p className="text-muted-foreground">Not linked to a location.</p>
      )}
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {d?.counts && (
        <PanelSection label="Inside">
          <PanelRow label="Sub-locations">
            <span className="num">{d.counts.locations}</span>
          </PanelRow>
          <PanelRow label="Rooms">
            <span className="num">{d.counts.rooms}</span>
          </PanelRow>
          <PanelRow label="Racks">
            <span className="num">{d.counts.racks}</span>
          </PanelRow>
          <PanelRow label="Devices">
            <span className="num">{d.counts.devices}</span>
          </PanelRow>
        </PanelSection>
      )}
      {d && d.floor_plans.length > 0 && (
        <PanelSection label="Floor plans">
          <ul className="grid gap-0.5">
            {d.floor_plans.map((p) => (
              <li key={p.id} className="flex items-baseline gap-2">
                {p.first_floor_id ? (
                  <Link
                    to="/floorplans/$id"
                    params={{ id: p.first_floor_id }}
                    className="link min-w-0 truncate"
                  >
                    {p.name}
                  </Link>
                ) : (
                  <Link
                    to="/floorplans/stacks/$id"
                    params={{ id: p.id }}
                    className="link min-w-0 truncate"
                  >
                    {p.name}
                  </Link>
                )}
                <span className="ml-auto shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                  {p.site_wide
                    ? "Site-wide"
                    : `${p.floor_count} floor${p.floor_count === 1 ? "" : "s"}`}
                </span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
    </PanelShell>
  )
}
