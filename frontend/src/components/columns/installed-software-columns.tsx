import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { InstalledSoftware, InstalledSoftwareSource } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { EolBadge, eolColumn } from "@/components/cells/eol-cell"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of installed software" (#436): the
// device and VM Software tabs and the application's Installed on tab build
// here.

export type InstalledSoftwareColumnId =
  | "application"
  | "parent"
  | "version"
  | "cycle"
  | "service"
  | "group"
  | "license"
  | "purl"
  | "cpe"
  | "eol"
  | "lifetime"
  | "source"
  | "last_seen"
  | "description"

const CANONICAL_ORDER: InstalledSoftwareColumnId[] = [
  "application",
  "parent",
  "version",
  "cycle",
  "service",
  "group",
  "license",
  "purl",
  "cpe",
  "eol",
  "lifetime",
  "source",
  "last_seen",
  "description",
]

export const SOFTWARE_SOURCE_LABELS: Record<InstalledSoftwareSource, string> = {
  manual: "Manual",
  import: "Import",
  discovery: "Discovery",
  group: "Group",
}

export interface InstalledSoftwareColumnOpts<
  T extends InstalledSoftware = InstalledSoftware,
> {
  omit?: InstalledSoftwareColumnId[]
  include?: InstalledSoftwareColumnId[]
  selection?: boolean
  /** End-of-life status column (#8) - pass `useEolSettings().enabled`. */
  eol?: boolean
  /** The end-of-life warning window, which colours the bar. */
  warningDays?: number | null
  /** Show the Cycle column by default (the application's Installed on tab). */
  showCycle?: boolean
  actions?: ActionsColumnOpts<T>
}

export function buildInstalledSoftwareColumns<
  T extends InstalledSoftware = InstalledSoftware,
>(opts: InstalledSoftwareColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.eol) omit.add("eol")
  const keep = (id: InstalledSoftwareColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<InstalledSoftwareColumnId, () => ColumnDef<T, unknown>> = {
    application: () => ({
      id: "application",
      accessorFn: (r) => r.application.path || r.application.name,
      header: ({ column }) => (
        <SortHeader column={column} label="Application" />
      ),
      cell: ({ row }) => (
        <Link
          to="/applications/$id"
          params={{ id: row.original.application.id }}
          className="link font-medium"
        >
          {row.original.application.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Application",
          get: (r: T) => r.application.id,
          formatValue: (_v, r) => ({ label: r.application.name }),
        },
      },
    }),
    parent: () => ({
      id: "parent",
      accessorFn: (r) => r.device?.name ?? r.virtual_machine?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Installed on" />
      ),
      cell: ({ row }) => {
        const r = row.original
        if (r.device)
          return (
            <Link
              to="/devices/$id"
              params={{ id: r.device.id }}
              className="link font-mono"
            >
              {r.device.name}
            </Link>
          )
        if (r.virtual_machine)
          return (
            <Link
              to="/virtual-machines/$id"
              params={{ id: r.virtual_machine.id }}
              className="link font-mono"
            >
              {r.virtual_machine.name}
            </Link>
          )
        return dash
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: T) => (r.device ? "device" : "virtualmachine"),
          formatValue: (v) => ({
            label: v === "device" ? "Device" : "Virtual machine",
          }),
        },
      },
    }),
    version: () => ({
      id: "version",
      accessorKey: "version",
      header: ({ column }) => <SortHeader column={column} label="Version" />,
      cell: ({ row }) => {
        const r = row.original
        // A person's install the package inventory reads differently (#451).
        const drift =
          !!r.observed_version &&
          r.source !== "discovery" &&
          r.observed_version !== r.version
        if (!r.version && !drift) return dash
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {r.version ? (
              <span className="font-mono text-xs">{r.version}</span>
            ) : (
              dash
            )}
            {drift && (
              <Badge variant="warning">
                Discovery reads {r.observed_version}
              </Badge>
            )}
          </span>
        )
      },
    }),
    cycle: () => ({
      id: "cycle",
      accessorKey: "cycle",
      header: ({ column }) => <SortHeader column={column} label="Cycle" />,
      cell: ({ row }) =>
        row.original.cycle ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">{row.original.cycle}</span>
            {row.original.cycle_manual && (
              <Badge variant="secondary">manual</Badge>
            )}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Cycle", defaultHidden: !opts.showCycle },
    }),
    service: () => ({
      id: "service",
      accessorFn: (r) => r.service?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Service" />,
      cell: ({ row }) =>
        row.original.service ? (
          <Link
            to="/services/$id"
            params={{ id: row.original.service.id }}
            className="link"
          >
            {row.original.service.name}
          </Link>
        ) : (
          dash
        ),
    }),
    // The application group whose assignment made the install (#436).
    group: () => ({
      id: "group",
      accessorFn: (r) => r.group?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) =>
        row.original.group ? (
          <Link
            to="/application-groups/$id"
            params={{ id: row.original.group.id }}
            className="link"
          >
            {row.original.group.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        label: "Group",
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: T) => r.group?.id ?? "__none__",
          formatValue: (_v, r) => ({ label: r.group?.name ?? "No group" }),
        },
      },
    }),
    // The licence the SBOM reports: the install's own, else the
    // application's.
    license: () => ({
      id: "license",
      accessorKey: "effective_license",
      header: ({ column }) => <SortHeader column={column} label="License" />,
      cell: ({ row }) =>
        row.original.effective_license ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">
              {row.original.effective_license}
            </span>
            {row.original.license && (
              <Badge variant="secondary">override</Badge>
            )}
          </span>
        ) : (
          dash
        ),
      meta: {
        label: "License",
        facet: {
          kind: "enum",
          label: "License",
          get: (r: T) => r.effective_license || "__none__",
          formatValue: (v) => ({
            label: v === "__none__" ? "No license" : String(v),
          }),
        },
      },
    }),
    // What the SBOM writes: the install's own, else the application's
    // template filled in.
    purl: () => ({
      id: "purl",
      accessorKey: "effective_purl",
      header: ({ column }) => (
        <SortHeader column={column} label="Package URL" />
      ),
      cell: ({ row }) =>
        row.original.effective_purl ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs break-all">
              {row.original.effective_purl}
            </span>
            {row.original.purl && <Badge variant="secondary">override</Badge>}
          </span>
        ) : (
          dash
        ),
      meta: { label: "Package URL", defaultHidden: true },
    }),
    // What the SBOM writes: the install's own, else the application's
    // template filled in.
    cpe: () => ({
      id: "cpe",
      accessorKey: "effective_cpe",
      header: ({ column }) => <SortHeader column={column} label="CPE" />,
      cell: ({ row }) =>
        row.original.effective_cpe ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs break-all">
              {row.original.effective_cpe}
            </span>
            {row.original.cpe && <Badge variant="secondary">override</Badge>}
          </span>
        ) : (
          dash
        ),
      meta: { label: "CPE", defaultHidden: true },
    }),
    eol: () => {
      // The status links to the application's End of life card.
      const col = eolColumn<T>({ get: (r) => r.eol })
      return {
        ...col,
        cell: ({ row }) =>
          row.original.eol ? (
            <Link
              to="/applications/$id"
              params={{ id: row.original.application.id }}
              search={{ tab: "overview" }}
              hash="eol"
            >
              <EolBadge info={row.original.eol} />
            </Link>
          ) : (
            dash
          ),
      }
    },
    lifetime: () => ({
      id: "lifetime",
      accessorFn: (r) => r.effective_end ?? "",
      header: ({ column }) => <SortHeader column={column} label="Lifetime" />,
      cell: ({ row }) => (
        <LifetimeBar
          start={row.original.effective_release}
          end={row.original.effective_end}
          warningDays={opts.warningDays}
          source={row.original.effective_source}
        />
      ),
      meta: {
        export: { header: "End", value: (r: T) => r.effective_end ?? "" },
      },
    }),
    source: () => ({
      id: "source",
      accessorFn: (r) => SOFTWARE_SOURCE_LABELS[r.source] ?? r.source,
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      cell: ({ row }) => (
        <Badge variant="secondary">
          {SOFTWARE_SOURCE_LABELS[row.original.source] ?? row.original.source}
        </Badge>
      ),
      meta: { label: "Source", defaultHidden: true },
    }),
    last_seen: () => ({
      ...timeAgoColumn<T>({
        id: "last_seen",
        header: "Last seen",
        get: (r) => r.last_seen,
      }),
      meta: { label: "Last seen", defaultHidden: true },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
