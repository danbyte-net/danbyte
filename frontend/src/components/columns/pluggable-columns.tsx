import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { accessoryKindLabel } from "@/lib/api"
import type { AccessoryType } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import { Badge } from "@/components/ui/badge"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

/**
 * The Pluggables list's columns (docs/dcim/pluggables.md): one factory for
 * the transceivers, plugs and cords model packs bring (`AccessoryType`).
 * Kind, connector, fits, pack and "in use" are the rail's facets.
 */
export type PluggableColumnId =
  | "name"
  | "kind"
  | "connector"
  | "fits"
  | "standard"
  | "wavelength"
  | "parts"
  | "in_use"
  | "pack"

export const PLUGGABLE_COLUMNS: PluggableColumnId[] = [
  "name",
  "kind",
  "connector",
  "fits",
  "standard",
  "wavelength",
  "parts",
  "in_use",
  "pack",
]

const dashCell = <span className="text-muted-foreground">-</span>

export function packLabel(p: AccessoryType["pack_import"]): string {
  if (!p?.pack.name) return ""
  return [p.pack.name, p.pack.version].filter(Boolean).join(" ")
}

export function buildPluggableColumns({
  include = PLUGGABLE_COLUMNS,
  actions,
}: {
  include?: PluggableColumnId[]
  actions?: {
    canEdit: boolean
    onDelete?: (r: AccessoryType) => void
  }
} = {}): ColumnDef<AccessoryType, unknown>[] {
  const byId: Record<
    PluggableColumnId,
    () => ColumnDef<AccessoryType, unknown>
  > = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/pluggables/$id"
          params={{ id: row.original.id }}
          className="link font-mono font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    kind: () => ({
      id: "kind",
      accessorFn: (r) => accessoryKindLabel(r.kind),
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ getValue }) => (
        <span className="text-xs">{getValue<string>()}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: AccessoryType) => r.kind,
          formatValue: (v) => ({
            label: accessoryKindLabel(v),
          }),
        },
      },
    }),
    connector: () => ({
      id: "connector",
      accessorFn: (r) => r.connector,
      header: "Connector",
      cell: ({ row }) =>
        row.original.connector ? (
          <span className="font-mono text-xs">{row.original.connector}</span>
        ) : (
          dashCell
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Connector",
          get: (r: AccessoryType) => r.connector || "__none__",
          formatValue: (v) => ({ label: v === "__none__" ? "None" : v }),
        },
      },
    }),
    fits: () => ({
      id: "fits",
      accessorFn: (r) => r.fits.join(" "),
      header: "Fits",
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.fits.map((f) => (
            <Badge key={f} variant="outline" className="font-mono">
              {f}
            </Badge>
          ))}
        </span>
      ),
      meta: {
        facet: {
          kind: "tags",
          label: "Fits",
          get: (r: AccessoryType) => r.fits.map((f) => ({ slug: f, name: f })),
        },
      },
    }),
    standard: () => ({
      id: "standard",
      accessorFn: (r) => r.standard,
      header: "Standard",
      cell: ({ row }) =>
        row.original.standard ? (
          <span className="text-xs">{row.original.standard}</span>
        ) : (
          dashCell
        ),
    }),
    wavelength: () => ({
      id: "wavelength",
      accessorFn: (r) => r.wavelength_nm ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Wavelength" />,
      cell: ({ row }) =>
        row.original.wavelength_nm != null ? (
          <span className="num text-xs">{row.original.wavelength_nm} nm</span>
        ) : (
          dashCell
        ),
    }),
    parts: () => ({
      id: "parts",
      accessorFn: (r) => r.parts.length,
      header: ({ column }) => <SortHeader column={column} label="Parts" />,
      cell: ({ row }) => {
        const parts = row.original.parts
        if (!parts.length) return dashCell
        return (
          <HoverCard openDelay={150}>
            <HoverCardTrigger asChild>
              <span className="num cursor-default text-xs underline decoration-dotted underline-offset-2">
                {parts.length}
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-auto max-w-72">
              <ul className="space-y-0.5 font-mono text-xs">
                {parts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </HoverCardContent>
          </HoverCard>
        )
      },
      meta: {
        export: { value: (r: AccessoryType) => r.parts.join(", ") },
      },
    }),
    in_use: () => ({
      id: "in_use",
      accessorFn: (r) => r.in_use ?? 0,
      header: ({ column }) => <SortHeader column={column} label="In use" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.in_use ?? 0}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "In use",
          get: (r: AccessoryType) => (r.in_use ? "yes" : "no"),
          formatValue: (v) => ({ label: v === "yes" ? "In use" : "Unused" }),
        },
      },
    }),
    pack: () => ({
      id: "pack",
      accessorFn: (r) => packLabel(r.pack_import),
      header: "Pack",
      cell: ({ getValue }) =>
        getValue<string>() ? (
          <span className="text-xs text-muted-foreground">
            {getValue<string>()}
          </span>
        ) : (
          dashCell
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Pack",
          get: (r: AccessoryType) => r.pack_import?.pack.name || "__none__",
          formatValue: (v) => ({ label: v === "__none__" ? "None" : v }),
        },
      },
    }),
  }
  return [
    ...include.map((id) => byId[id]()),
    ...(actions
      ? [
          actionsColumn<AccessoryType>({
            editTo: actions.canEdit ? "/pluggables/$id/edit" : undefined,
            editParams: (r) => ({ id: r.id }),
            onDelete: actions.onDelete,
            canDelete: (r) => !r.in_use,
          }),
        ]
      : []),
  ]
}
