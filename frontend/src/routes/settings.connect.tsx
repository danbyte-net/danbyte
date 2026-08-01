import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"
import { Info, Plug } from "lucide-react"

import { api } from "@/lib/api"
import type {
  ConnectProtocol,
  ConnectProtocolWritePayload,
  Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { getLucideIcon } from "@/components/dynamic-icon"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { QueryError } from "@/components/query-error"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormIcon,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { IdMultiSelect } from "@/components/cells/id-multi-select"

export const Route = createFileRoute("/settings/connect")({
  component: ConnectProtocolsSettingsPage,
})

/** The (i) tip that explains the template placeholders — kept out of the page
 * body so the prose doesn't clutter the table (CLAUDE.md: explain via (i)). */
function PlaceholderTip() {
  return (
    <HoverCard openDelay={100} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 text-xs leading-relaxed text-muted-foreground">
        <p>
          A launch URL with placeholders filled in per device when someone picks
          it from the device Connect menu:
        </p>
        <ul className="mt-2 space-y-1">
          <li>
            <code className="font-mono">{"{host}"}</code> — the device's primary
            IP (then OOB IP, then its name), mask stripped
          </li>
          <li>
            <code className="font-mono">{"{username}"}</code> — chosen at launch
            time
          </li>
          <li>
            <code className="font-mono">{"{port}"}</code> — the default port
            below, if set
          </li>
          <li>
            <code className="font-mono">{"{name}"}</code> — the device name
          </li>
        </ul>
        <p className="mt-2">
          e.g. <code className="font-mono">ssh://{"{username}"}@{"{host}"}</code>
          , <code className="font-mono">rdp://{"{host}"}</code>,{" "}
          <code className="font-mono">https://{"{host}"}</code>
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}

function ConnectProtocolsSettingsPage() {
  const { canDo, isLoading: meLoading } = useMe()
  const canView = canDo("connectprotocol", "view")
  const canAdd = canDo("connectprotocol", "add")
  const canEdit = canDo("connectprotocol", "change")
  const canDelete = canDo("connectprotocol", "delete")

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ConnectProtocol | null>(null)
  const [deleting, setDeleting] = useState<ConnectProtocol | null>(null)

  const list = useQuery({
    queryKey: ["connect-protocols", "catalog"],
    queryFn: () =>
      api<Paginated<ConnectProtocol>>(
        "/api/monitoring/connect-protocols/?page_size=200"
      ),
    enabled: canView,
  })
  const rows = list.data?.results ?? []

  const columns = useMemo<ColumnDef<ConnectProtocol>[]>(
    () =>
      buildColumns({
        canEdit,
        canDelete,
        onEdit: setEditing,
        onDelete: setDeleting,
      }),
    [canEdit, canDelete]
  )

  if (meLoading) return null
  if (!canView)
    return (
      <p className="text-sm text-muted-foreground">
        You don't have permission to view connect protocols.
      </p>
    )

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          Connect protocols <PlaceholderTip />
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Launch actions offered from a device's Connect menu. Each is a URL
          template handed to the operator's OS (ssh://, rdp://, https://, …).
        </p>
      </div>

      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plug className="h-3.5 w-3.5" /> Add protocol
          </Button>
        </div>
      )}

      {list.isError ? (
        <QueryError error={list.error} />
      ) : list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No connect protocols yet. Add one — for example{" "}
          <code className="font-mono">ssh://{"{username}"}@{"{host}"}</code> — so
          it appears on every device's Connect menu.
        </p>
      ) : (
        <DataTable data={rows} columns={columns} flexColumn="url_template" />
      )}

      <ProtocolDialog
        protocol={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
      <DeleteDialog
        protocol={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function buildColumns({
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  canEdit: boolean
  canDelete: boolean
  onEdit: (p: ConnectProtocol) => void
  onDelete: (p: ConnectProtocol) => void
}): ColumnDef<ConnectProtocol>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const Icon = getLucideIcon(row.original.icon) ?? Plug
        return (
          <span className="inline-flex items-center gap-2 font-medium">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            {row.original.name}
          </span>
        )
      },
    },
    {
      id: "url_template",
      accessorKey: "url_template",
      header: "Template",
      cell: ({ row }) => (
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {row.original.url_template}
        </span>
      ),
    },
    {
      id: "default_port",
      accessorKey: "default_port",
      header: ({ column }) => <SortHeader column={column} label="Port" />,
      cell: ({ row }) =>
        row.original.default_port != null ? (
          <span className="num text-xs">{row.original.default_port}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      header: "Enabled",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="outline">Disabled</Badge>
        ),
    },
    {
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
    },
    timeAgoColumn<ConnectProtocol>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          onEdit={canEdit ? () => onEdit(row.original) : undefined}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

function ProtocolDialog({
  protocol,
  open,
  onOpenChange,
}: {
  protocol: ConnectProtocol | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const isEdit = !!protocol
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState("")
  const [urlTemplate, setUrlTemplate] = useState("")
  const [icon, setIcon] = useState("")
  const [port, setPort] = useState("")
  const [weight, setWeight] = useState("100")
  const [enabled, setEnabled] = useState(true)
  const [description, setDescription] = useState("")
  const [deviceTypeIds, setDeviceTypeIds] = useState<string[]>([])
  const [roleIds, setRoleIds] = useState<string[]>([])

  // Reseed the fields whenever the dialog opens (edit → prefill, add → blank).
  useEffect(() => {
    if (!open) return
    setName(protocol?.name ?? "")
    setUrlTemplate(protocol?.url_template ?? "")
    setIcon(protocol?.icon ?? "")
    setPort(protocol?.default_port != null ? String(protocol.default_port) : "")
    setWeight(protocol ? String(protocol.weight) : "100")
    setEnabled(protocol?.enabled ?? true)
    setDescription(protocol?.description ?? "")
    setDeviceTypeIds((protocol?.device_types_detail ?? []).map((d) => d.id))
    setRoleIds((protocol?.roles_detail ?? []).map((r) => r.id))
    reset()
  }, [open, protocol, reset])

  // Targeting pickers — only fetched while the dialog is open.
  const dtOptQ = useQuery({
    queryKey: ["device-types-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; model: string }>>(
        "/api/device-types/?picker=1&page_size=500"
      ),
    enabled: open,
  })
  const roleOptQ = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?picker=1&page_size=500"
      ),
    enabled: open,
  })
  const dtOptions = (dtOptQ.data?.results ?? []).map((o) => ({
    id: o.id,
    name: o.model,
  }))
  const roleOptions = (roleOptQ.data?.results ?? []).map((o) => ({
    id: o.id,
    name: o.name,
  }))

  const mutation = useMutation({
    mutationFn: () => {
      const payload: ConnectProtocolWritePayload = {
        name: name.trim(),
        url_template: urlTemplate.trim(),
        icon: icon.trim(),
        default_port: port.trim() === "" ? null : Number(port),
        weight: weight.trim() === "" ? 100 : Number(weight),
        enabled,
        description: description.trim(),
        device_type_ids: deviceTypeIds,
        role_ids: roleIds,
      }
      if (isEdit)
        return api<ConnectProtocol>(
          `/api/monitoring/connect-protocols/${protocol.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<ConnectProtocol>("/api/monitoring/connect-protocols/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["connect-protocols"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${protocol.name}` : "Add connect protocol"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="SSH"
            error={fieldErrors.name}
          />
          <FormText
            label="URL template"
            required
            mono
            value={urlTemplate}
            onChange={setUrlTemplate}
            placeholder="ssh://{username}@{host}"
            hint="Placeholders: {host} {username} {port} {name}"
            error={fieldErrors.url_template}
          />
          <FormIcon
            label="Icon"
            value={icon}
            onChange={setIcon}
            error={fieldErrors.icon}
          />
          <FormRow>
            <FormText
              label="Default port"
              type="number"
              value={port}
              onChange={setPort}
              placeholder="22"
              error={fieldErrors.default_port}
            />
            <FormText
              label="Weight"
              type="number"
              value={weight}
              onChange={setWeight}
              hint="Lower sorts first"
              error={fieldErrors.weight}
            />
          </FormRow>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <Field
            label="Applies to"
            info="Leave empty to offer this protocol on every device. Restricting by device type and/or role limits which devices show it in the Connect menu — a device matches when its type is in the list OR its role is."
          >
            <div className="space-y-2">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  Device types
                </span>
                <IdMultiSelect
                  options={dtOptions}
                  value={deviceTypeIds}
                  onChange={setDeviceTypeIds}
                  placeholder="Any device type"
                  searchPlaceholder="Search device types…"
                  emptyText="No device types."
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Roles</span>
                <IdMultiSelect
                  options={roleOptions}
                  value={roleIds}
                  onChange={setRoleIds}
                  placeholder="Any role"
                  searchPlaceholder="Search roles…"
                  emptyText="No roles."
                />
              </div>
            </div>
          </Field>
          <FormCheckbox
            label="Enabled"
            hint="Offered on the device Connect menu"
            checked={enabled}
            onChange={setEnabled}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Create protocol"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({
  protocol,
  onOpenChange,
}: {
  protocol: ConnectProtocol | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/connect-protocols/${protocol!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${protocol!.name}`)
      qc.invalidateQueries({ queryKey: ["connect-protocols"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!protocol} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {protocol?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It will no longer appear on any device's Connect menu. This can't be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
