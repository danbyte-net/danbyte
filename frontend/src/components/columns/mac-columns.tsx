import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { SortHeader } from "@/components/data-table"
import { TagList } from "@/components/cells/tag-list"
import { LearnedAtCell } from "@/components/learned-macs-cell"
import type { MacEntry, Tag } from "@/lib/api"

/**
 * The recorded MAC list (`/api/macs/`): one row per MAC Danbyte records on an
 * interface, an IP or a MAC object. The learned sightings have their own
 * factory (`learned-mac-columns.tsx`).
 */
export type MacColumnId =
  | "mac"
  | "vendor"
  | "location"
  | "interfaces"
  | "ips"
  | "tags"
  | "description"

export const MAC_COLUMNS: MacColumnId[] = [
  "mac",
  "vendor",
  "location",
  "interfaces",
  "ips",
  "tags",
  "description",
]

/** All distinct non-empty object descriptions, joined - so a row that matched a
 * search on any object's description always shows the matched text. */
export function allDescriptions(m: MacEntry): string {
  const seen = new Set<string>()
  for (const o of m.objects) if (o.description) seen.add(o.description)
  return [...seen].join(" · ")
}

/** Union of tags across a MAC's objects, de-duplicated by id. */
function unionTags(m: MacEntry): Tag[] {
  const seen = new Map<number, Tag>()
  for (const o of m.objects) for (const t of o.tags) seen.set(t.id, t)
  return [...seen.values()]
}

/** Sort key for the Location column: site, location, switch, port. */
export function learnedAtKey(m: MacEntry): string {
  const l = m.location
  if (!l) return ""
  return [
    l.site?.name ?? "",
    l.location?.name ?? "",
    l.device.name,
    l.interface?.name ?? l.port_name,
  ].join(" ")
}

export function buildMacColumns<T extends MacEntry>({
  include = MAC_COLUMNS,
}: { include?: MacColumnId[] } = {}): ColumnDef<T>[] {
  const byId: Record<MacColumnId, () => ColumnDef<T>> = {
    mac: () => ({
      id: "mac",
      header: "MAC address",
      cell: ({ row }) => (
        <Link
          to="/macs/$mac"
          params={{ mac: row.original.mac }}
          className="link font-mono text-[13px] font-medium"
        >
          {row.original.mac}
        </Link>
      ),
    }),
    vendor: () => ({
      id: "vendor",
      header: "Vendor",
      cell: ({ row }) =>
        row.original.vendor ? (
          <span
            className={
              row.original.vendor.source === "local"
                ? "text-xs text-muted-foreground"
                : "text-xs"
            }
          >
            {row.original.vendor.name}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Vendor",
          get: (r: MacEntry) => r.vendor?.name ?? "__none__",
          formatValue: (v) => ({ label: v === "__none__" ? "Unknown" : v }),
        },
      },
    }),
    // Where the network learned the MAC (#344) - the MAC page's Location.
    location: () => ({
      id: "location",
      accessorFn: (r) => (r.location ? learnedAtKey(r) : undefined),
      header: ({ column }) => <SortHeader column={column} label="Location" />,
      sortUndefined: "last",
      cell: ({ row }) => <LearnedAtCell loc={row.original.location} />,
      meta: {
        label: "Location",
        facet: {
          kind: "enum",
          label: "Learned at site",
          get: (r: MacEntry) =>
            r.location ? (r.location.site?.name ?? "__nosite__") : "__none__",
          formatValue: (v) => ({
            label:
              v === "__none__"
                ? "Not learned"
                : v === "__nosite__"
                  ? "No site"
                  : v,
          }),
        },
      },
    }),
    interfaces: () => ({
      id: "interfaces",
      header: "Interfaces",
      cell: ({ row }) => {
        const ifs = row.original.interfaces
        const vifs = row.original.vm_interfaces
        if (ifs.length === 0 && vifs.length === 0)
          return <span className="text-muted-foreground">-</span>
        return (
          <div className="flex flex-wrap items-center gap-1">
            {ifs.map((i) => (
              <Link
                key={i.id}
                to="/interfaces/$id"
                params={{ id: i.id }}
                className="link rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
              >
                {i.device.name}:{i.name}
              </Link>
            ))}
            {vifs.map((i) => (
              <Link
                key={i.id}
                to="/virtual-machines/$id"
                params={{ id: i.vm.id }}
                search={{ tab: "components" }}
                className="link rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
              >
                {i.vm.name}:{i.name}
              </Link>
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Interface",
          get: (r: MacEntry) =>
            r.interfaces.length > 0 || r.vm_interfaces.length > 0
              ? "yes"
              : "no",
          formatValue: (v) => ({
            label: v === "yes" ? "Has interface" : "No interface",
          }),
        },
      },
    }),
    ips: () => ({
      id: "ips",
      header: "Paired IPs",
      cell: ({ row }) => {
        const ips = row.original.ips
        if (ips.length === 0)
          return <span className="text-muted-foreground">-</span>
        return (
          <div className="flex flex-wrap items-center gap-1">
            {ips.map((ip) => (
              <Link
                key={ip.id}
                to="/ips/$id"
                params={{ id: ip.id }}
                className="link rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
              >
                {ip.ip_address}
              </Link>
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "IP",
          get: (r: MacEntry) => (r.ips.length > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has IP" : "No IP",
          }),
        },
      },
    }),
    tags: () => ({
      id: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = unionTags(row.original)
        if (tags.length === 0)
          return <span className="text-muted-foreground">-</span>
        return <TagList tags={tags} inline />
      },
    }),
    description: () => ({
      id: "description",
      header: "Description",
      accessorFn: (r) => allDescriptions(r),
      cell: ({ row }) => {
        const desc = row.getValue<string>("description")
        return desc ? (
          <span className="text-[13px]">{desc}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "MAC object",
          get: (r: MacEntry) => (r.objects.length > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has object" : "No object",
          }),
        },
      },
    }),
  }
  return include.map((id) => byId[id]())
}
