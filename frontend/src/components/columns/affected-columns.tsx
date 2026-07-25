// Read-only column sets per object type, used to render the *real* table of
// objects a compliance rule currently fails (the genuine prefix/IP/device/…
// columns, all exportable). One module so the rule detail can dispatch on
// object_type.
//
// These are not a second definition of those columns: each set is the entity's
// own `components/columns/*` factory with the interactive bits left off (no
// selection, no row actions, no tag filter to drive), so an affected row reads
// exactly like the same object on its list page.
import { type ColumnDef } from "@tanstack/react-table"

import {
  type Device,
  type IPAddress,
  type Prefix,
  type Site,
  type VLAN,
  type VRF,
} from "@/lib/api"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { buildSiteColumns } from "@/components/columns/site-columns"
import { buildVlanColumns } from "@/components/columns/vlan-columns"
import { buildVrfColumns } from "@/components/columns/vrf-columns"

export function prefixColumns(): ColumnDef<Prefix>[] {
  return buildPrefixColumns({
    // This table leads with utilisation, so it spells the sequence out.
    order: [
      "cidr",
      "status",
      "utilisation",
      "site",
      "vrf",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function ipColumns(): ColumnDef<IPAddress>[] {
  return buildIpColumns<IPAddress>({
    include: [
      "ip",
      "status",
      "role",
      "dns",
      "assigned",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function deviceColumns(): ColumnDef<Device>[] {
  return buildDeviceColumns({
    include: [
      "name",
      "status",
      "role",
      "site",
      "serial",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function vlanColumns(): ColumnDef<VLAN>[] {
  return buildVlanColumns({
    include: [
      "vlan_id",
      "name",
      "site",
      "group",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function vrfColumns(): ColumnDef<VRF>[] {
  return buildVrfColumns({
    include: ["name", "rd", "prefixes", "description", "tags", "updated"],
    plainHeaders: ["rd"],
    zeroCounts: "number",
  })
}

export function siteColumns(): ColumnDef<Site>[] {
  return buildSiteColumns({
    include: ["name", "location", "prefixes", "description", "tags", "updated"],
    plainHeaders: ["location"],
    zeroCounts: "number",
  })
}

// The serialized objects arrive loosely typed (Record<string, unknown>), so the
// dispatcher hands back columns typed to match — the per-type factories above
// are the real, typed source.
type LooseColumns = ColumnDef<Record<string, unknown>>[]
const loose = <T,>(c: ColumnDef<T>[]) => c as unknown as LooseColumns

// object_type slug → its real column set. Returns null for types without a
// dedicated table (the detail page falls back to the generic object list).
export function affectedColumnsFor(objectType: string): LooseColumns | null {
  switch (objectType) {
    case "prefix":
      return loose(prefixColumns())
    case "ipaddress":
      return loose(ipColumns())
    case "device":
      return loose(deviceColumns())
    case "vlan":
      return loose(vlanColumns())
    case "vrf":
      return loose(vrfColumns())
    case "site":
      return loose(siteColumns())
    default:
      return null
  }
}

export const AFFECTED_FLEX_COLUMN = "description"
