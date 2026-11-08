import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { SoftwareVersionRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import {
  SOFTWARE_TARGET_LABELS,
  SOFTWARE_VERSION_SOURCE_LABELS,
} from "@/components/cells/software-version-cell"
import type { KnownVersionSource } from "@/components/cells/software-version-cell"

// The one source of truth for "a table of software versions" (#451): one row
// per platform and version from GET /api/lifecycle/versions/, each count
// linking to the device or VM list filtered to it. The Lifecycle page's
// Versions view builds its columns here.

/** The list filters a row's count links carry besides its own platform and
 * version: the sites and roles the view is narrowed to. */
export interface VersionLinkScope {
  site?: string
  role?: string
}

const NONE = "__none__"

/** The device / VM list facets for one row: `?platform=&software_version=`,
 * plus the view's site and role. */
export function versionRowSearch(
  row: SoftwareVersionRow,
  scope: VersionLinkScope = {}
): Record<string, string> {
  const out: Record<string, string> = {
    platform: row.platform?.id ?? NONE,
    software_version: row.version || NONE,
  }
  if (scope.site) out.site = scope.site
  if (scope.role) out.role = scope.role
  return out
}

const SOURCE_ORDER: (KnownVersionSource | "none")[] = [
  "snmp",
  "virtualization",
  "oxidized",
  "import",
  "manual",
  "none",
]

/** "SNMP 3 · Manual 1" - the row's objects by where their version came
 * from. */
export function sourcesLabel(sources: SoftwareVersionRow["sources"]): string {
  return SOURCE_ORDER.filter((s) => sources[s])
    .map(
      (s) =>
        `${s === "none" ? "No source" : SOFTWARE_VERSION_SOURCE_LABELS[s]} ${sources[s]}`
    )
    .join(" · ")
}

function CountLink({
  n,
  to,
  search,
}: {
  n: number
  to: "/devices" | "/virtual-machines"
  search: Record<string, string>
}) {
  if (!n) return <span className="num text-muted-foreground">0</span>
  return (
    <Link to={to} search={search as never} className="num link">
      {n}
    </Link>
  )
}

export function buildSoftwareVersionColumns<T extends SoftwareVersionRow>(
  opts: { scope?: VersionLinkScope } = {}
): ColumnDef<T, unknown>[] {
  const scope = opts.scope ?? {}
  return [
    {
      id: "platform",
      accessorFn: (r) => r.platform?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => {
        const p = row.original.platform
        return p ? (
          <Link to="/platforms/$id" params={{ id: p.id }} className="link">
            {p.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">No platform</span>
        )
      },
    },
    {
      id: "version",
      accessorFn: (r) => r.version,
      header: ({ column }) => <SortHeader column={column} label="Version" />,
      cell: ({ row }) =>
        row.original.version ? (
          <span className="font-mono text-xs">{row.original.version}</span>
        ) : (
          <span className="text-muted-foreground">No version</span>
        ),
    },
    {
      id: "devices",
      accessorFn: (r) => r.devices,
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <CountLink
          n={row.original.devices}
          to="/devices"
          search={versionRowSearch(row.original, scope)}
        />
      ),
    },
    {
      id: "virtual_machines",
      accessorFn: (r) => r.virtual_machines,
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => (
        <CountLink
          n={row.original.virtual_machines}
          to="/virtual-machines"
          search={versionRowSearch(row.original, scope)}
        />
      ),
    },
    {
      id: "target",
      accessorFn: (r) => r.platform?.target_version ?? "",
      header: ({ column }) => <SortHeader column={column} label="Target" />,
      cell: ({ row }) => {
        const r = row.original
        if (r.on_target === null) return dash
        return (
          <Badge variant={r.on_target ? "success" : "warning"}>
            {SOFTWARE_TARGET_LABELS[r.on_target ? "on" : "off"]}
          </Badge>
        )
      },
    },
    {
      id: "sources",
      accessorFn: (r) => sourcesLabel(r.sources),
      header: "Source",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {sourcesLabel(row.original.sources) || dash}
        </span>
      ),
    },
  ]
}
