import { Link } from "@tanstack/react-router"

import { ColorBadge } from "@/components/cells/color-badge"

export interface VlanLike {
  id: string
  vlan_id: number
  name: string
  /** The VLAN's zone — Danbyte's colour layer for VLANs. */
  zone?: { name?: string; color: string | null } | null
}

/**
 * A VLAN rendered like zones/tags: a badge in the VLAN's zone colour, linked
 * to the VLAN. Colour is optional — an unzoned VLAN gets the neutral badge.
 */
export function VlanBadge({
  vlan,
  className,
}: {
  vlan: VlanLike
  className?: string
}) {
  return (
    <Link
      to="/vlans/$id"
      params={{ id: vlan.id }}
      className="inline-flex hover:opacity-90"
      title={vlan.zone?.name ? `Zone: ${vlan.zone.name}` : undefined}
    >
      <ColorBadge
        name={`${vlan.vlan_id} · ${vlan.name}`}
        color={vlan.zone?.color || undefined}
        className={className}
      />
    </Link>
  )
}
