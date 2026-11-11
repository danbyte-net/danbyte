import type { ColumnDef } from "@tanstack/react-table"

import type { SharedCredential, SharedCredentialKind } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"

// Shared credentials (#451): the one column factory for their table.

export const SHARED_CREDENTIAL_KINDS: {
  value: SharedCredentialKind
  label: string
}[] = [
  { value: "ssh_key", label: "SSH key" },
  { value: "ssh_password", label: "SSH password" },
  { value: "https_login", label: "HTTPS login" },
  { value: "windows_login", label: "Windows login" },
  { value: "proxmox", label: "Proxmox API token" },
  { value: "vmware", label: "VMware login" },
]

export const kindLabel = (k: string) =>
  SHARED_CREDENTIAL_KINDS.find((x) => x.value === k)?.label ?? k

export function scopeSummary(c: SharedCredential): React.ReactNode {
  if (c.all_hosts) return <span className="text-sm">All hosts</span>
  const parts: React.ReactNode[] = [
    ...c.scope.roles.map((r) => (
      <ColorBadge key={r.id} name={r.name} color={r.color || undefined} />
    )),
    ...c.scope.tags.map((t) => (
      <ColorBadge key={t.id} name={t.name} color={t.color || undefined} />
    )),
    ...[...c.scope.sites, ...c.scope.platforms, ...c.scope.device_types].map(
      (x) => (
        <Badge key={x.id} variant="secondary">
          {x.name}
        </Badge>
      )
    ),
  ]
  if (!parts.length)
    return (
      <span className="text-sm text-muted-foreground">Matches nothing</span>
    )
  return <span className="flex flex-wrap gap-1">{parts}</span>
}

export function buildSharedCredentialColumns({
  onEdit,
  onDelete,
}: {
  onEdit?: (c: SharedCredential) => void
  onDelete?: (c: SharedCredential) => void
}): ColumnDef<SharedCredential, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
      meta: { label: "Name" },
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Kind",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {kindLabel(row.original.kind)}
        </span>
      ),
      meta: { label: "Kind" },
    },
    {
      id: "username",
      accessorKey: "username",
      header: "User",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.username ? (
          <span className="font-mono text-xs">{row.original.username}</span>
        ) : (
          dash
        ),
      meta: { label: "User" },
    },
    {
      id: "scope",
      accessorFn: (c) => (c.all_hosts ? "all" : ""),
      header: "Scope",
      enableSorting: false,
      cell: ({ row }) => scopeSummary(row.original),
      meta: { label: "Scope" },
    },
    {
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => <span className="num">{row.original.weight}</span>,
      meta: { label: "Weight" },
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      header: "State",
      enableSorting: false,
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? "success" : "secondary"}>
          {row.original.enabled ? "Enabled" : "Disabled"}
        </Badge>
      ),
      meta: { label: "State" },
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          onEdit={onEdit ? () => onEdit(row.original) : undefined}
          onDelete={onDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
