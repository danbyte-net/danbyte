import type { FloorPlanTile } from "@/lib/api"
import { OpenLink } from "@/components/open-link"

/** "Open device", "Open rack"… for the linked object - the router link the
 * Maps panels share, so the SPA never reloads. */
export function LinkedObjectLink({
  linked,
}: {
  linked: NonNullable<FloorPlanTile["linked"]>
}) {
  const className = "mt-2 w-full"
  const params = { id: linked.id }
  switch (linked.kind) {
    case "rack":
      return (
        <OpenLink to="/racks/$id" params={params} className={className}>
          Open rack
        </OpenLink>
      )
    case "cabinet":
      return (
        <OpenLink to="/cabinets/$id" params={params} className={className}>
          Open cabinet
        </OpenLink>
      )
    case "device":
      return (
        <OpenLink to="/devices/$id" params={params} className={className}>
          Open device
        </OpenLink>
      )
    case "powerpanel":
      return (
        <OpenLink to="/power-panels/$id" params={params} className={className}>
          Open power panel
        </OpenLink>
      )
    case "powerfeed":
      return (
        <OpenLink to="/power-feeds/$id" params={params} className={className}>
          Open power feed
        </OpenLink>
      )
    case "coolingsource":
      return (
        <OpenLink
          to="/cooling-sources/$id"
          params={params}
          className={className}
        >
          Open cooling source
        </OpenLink>
      )
    case "floorplan":
      return (
        <OpenLink to="/floorplans/$id" params={params} className={className}>
          Open plan
        </OpenLink>
      )
  }
}
