import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  ModelPack,
  ModelPackFinding,
  ModelPackPart,
  ModelPackStatus,
  ModelPackType,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader } from "@/components/data-table"

// 3D model packs (Settings → Device library): the one column factory for the
// pack list, and the two for a pack's page - the types it changed and the
// checker's findings.

const STATUS_LABEL: Record<ModelPackStatus, string> = {
  checking: "Checking",
  checked: "Checked",
  refused: "Refused",
  installing: "Installing",
  installed: "Installed",
  failed: "Failed",
  replaced: "Replaced",
}

export function ModelPackStatusBadge({ status }: { status: ModelPackStatus }) {
  const variant =
    status === "installed"
      ? "success"
      : status === "failed" || status === "refused"
        ? "destructive"
        : status === "checking" || status === "installing"
          ? "warning"
          : "secondary"
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>
}

export function packLabel(p: Pick<ModelPack, "name" | "slug" | "filename">) {
  return p.name || p.slug || p.filename || "Pack"
}

export function buildModelPackColumns(): ColumnDef<ModelPack, unknown>[] {
  return [
    {
      id: "name",
      accessorFn: (p) => packLabel(p),
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/settings/device-library/packs/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {packLabel(row.original)}
        </Link>
      ),
      meta: { label: "Name" },
    },
    {
      id: "version",
      accessorKey: "version",
      header: "Version",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.version || dash}
        </span>
      ),
      meta: { label: "Version" },
    },
    {
      id: "license",
      accessorKey: "license",
      header: "Licence",
      enableSorting: false,
      cell: ({ row }) => row.original.license || dash,
      meta: { label: "Licence" },
    },
    {
      id: "author",
      accessorKey: "author",
      header: "Author",
      enableSorting: false,
      cell: ({ row }) => row.original.author || dash,
      meta: { label: "Author" },
    },
    {
      id: "types",
      accessorKey: "types",
      header: ({ column }) => <SortHeader column={column} label="Types" />,
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.types}</span>
      ),
      meta: { label: "Types" },
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => <ModelPackStatusBadge status={row.original.status} />,
      meta: { label: "Status" },
    },
    {
      id: "installed_at",
      accessorKey: "installed_at",
      header: ({ column }) => <SortHeader column={column} label="Installed" />,
      cell: ({ row }) =>
        row.original.installed_at ? (
          <TimeCell iso={row.original.installed_at} />
        ) : (
          dash
        ),
      meta: { label: "Installed" },
    },
    {
      id: "installed_by",
      accessorKey: "installed_by",
      header: "By",
      enableSorting: false,
      cell: ({ row }) => row.original.installed_by || dash,
      meta: { label: "By" },
    },
  ]
}

const ACTION_VARIANT = {
  created: "success",
  matched: "secondary",
  error: "destructive",
} as const

const KIND_LABEL: Record<ModelPackType["kind"], string> = {
  "device-type": "Device type",
  "module-type": "Module type",
  "accessory-type": "Accessory",
  "rack-kit": "Rack kit",
  "rack-type": "Rack type",
}

export function buildModelPackTypeColumns(): ColumnDef<
  ModelPackType,
  unknown
>[] {
  return [
    {
      id: "name",
      accessorFn: (t) => t.name || t.path,
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => {
        const t = row.original
        const label = t.name || t.path
        // Accessory types and rack kits have no page of their own.
        if (!t.id || t.kind === "accessory-type" || t.kind === "rack-kit")
          return <span className="font-medium">{label}</span>
        if (t.kind === "rack-type")
          return (
            <Link
              to="/rack-types/$id"
              params={{ id: t.id }}
              className="link font-medium"
            >
              {label}
            </Link>
          )
        return t.kind === "module-type" ? (
          <Link
            to="/module-types/$id"
            params={{ id: t.id }}
            className="link font-medium"
          >
            {label}
          </Link>
        ) : (
          <Link
            to="/device-types/$id"
            params={{ id: t.id }}
            className="link font-medium"
          >
            {label}
          </Link>
        )
      },
      meta: { label: "Type" },
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Kind",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {KIND_LABEL[row.original.kind]}
        </span>
      ),
      meta: { label: "Kind" },
    },
    {
      id: "action",
      accessorKey: "action",
      header: "Action",
      enableSorting: false,
      cell: ({ row }) => (
        <Badge variant={ACTION_VARIANT[row.original.action]}>
          {row.original.action === "created"
            ? "Created"
            : row.original.action === "matched"
              ? "Matched"
              : "Skipped"}
        </Badge>
      ),
      meta: { label: "Action" },
    },
    {
      id: "notes",
      accessorFn: (t) => t.notes.join(" "),
      header: "Notes",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.notes.length ? (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {row.original.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          dash
        ),
      meta: { label: "Notes" },
    },
  ]
}

export function buildModelPackFindingColumns(): ColumnDef<
  ModelPackFinding,
  unknown
>[] {
  return [
    {
      id: "level",
      accessorKey: "level",
      header: ({ column }) => <SortHeader column={column} label="Level" />,
      cell: ({ row }) => (
        <Badge
          variant={row.original.level === "error" ? "destructive" : "warning"}
        >
          {row.original.level === "error" ? "Error" : "Warning"}
        </Badge>
      ),
      meta: { label: "Level" },
    },
    {
      id: "path",
      accessorKey: "path",
      header: ({ column }) => <SortHeader column={column} label="File" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs break-all">{row.original.path}</span>
      ),
      meta: { label: "File" },
    },
    {
      id: "message",
      accessorKey: "message",
      header: "Finding",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm">{row.original.message}</span>
      ),
      meta: { label: "Finding" },
    },
  ]
}

const num = (n: number | null) =>
  n == null ? dash : <span className="tabular-nums">{n.toLocaleString()}</span>
const mb = (n: number | null) =>
  n == null ? (
    dash
  ) : (
    <span className="tabular-nums">{(n / (1024 * 1024)).toFixed(2)}</span>
  )

export function buildModelPackPartColumns(): ColumnDef<
  ModelPackPart,
  unknown
>[] {
  const count = (
    id: "bays" | "ports" | "leds" | "errors" | "warnings",
    label: string
  ): ColumnDef<ModelPackPart, unknown> => ({
    id,
    accessorKey: id,
    header: ({ column }) => <SortHeader column={column} label={label} />,
    cell: ({ row }) => num(row.original[id]),
    meta: { label },
  })
  return [
    {
      id: "part",
      accessorFn: (p) => p.part || p.path,
      header: ({ column }) => <SortHeader column={column} label="Part" />,
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.part || row.original.path}
        </span>
      ),
      meta: { label: "Part" },
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Kind",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.kind === "module-type"
          ? "Module"
          : row.original.kind === "accessory-type"
            ? "Accessory"
            : row.original.kind === "rack-kit"
              ? "Rack kit"
              : row.original.kind === "rack-type"
                ? "Rack type"
                : "Device",
      meta: { label: "Kind" },
    },
    {
      id: "triangles",
      accessorKey: "triangles",
      header: ({ column }) => <SortHeader column={column} label="Triangles" />,
      cell: ({ row }) => num(row.original.triangles),
      meta: { label: "Triangles" },
    },
    {
      id: "far_triangles",
      accessorKey: "far_triangles",
      header: "Far",
      enableSorting: false,
      cell: ({ row }) => num(row.original.far_triangles),
      meta: { label: "Far" },
    },
    {
      id: "bytes",
      accessorKey: "bytes",
      header: "MB",
      enableSorting: false,
      cell: ({ row }) => mb(row.original.bytes),
      meta: { label: "MB" },
    },
    count("bays", "Bays"),
    count("ports", "Ports"),
    count("leds", "LEDs"),
    count("errors", "Errors"),
    count("warnings", "Warnings"),
  ]
}
