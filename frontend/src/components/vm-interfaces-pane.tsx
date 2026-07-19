import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type VLANOption,
  type VMInterface,
  type VMInterfaceWritePayload,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export function VMInterfacesPane({ vmId }: { vmId: string }) {
  const { canDo } = useMe()
  const canAdd = canDo("vminterface", "add")
  const canEdit = canDo("vminterface", "change")
  const canDelete = canDo("vminterface", "delete")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<VMInterface | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<VMInterface | null>(null)
  const [selected, setSelected] = useState<VMInterface[]>([])

  const q = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  const rows = q.data?.results ?? []

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["vm-interfaces", vmId] })

  const columns = useMemo<ColumnDef<VMInterface>[]>(
    () => [
      selectionColumn<VMInterface>(),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => (
          <SortHeader column={column} label="Interface" />
        ),
        cell: ({ row }) => (
          <span className="font-mono font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) =>
          row.original.enabled ? (
            <Badge variant="success">Enabled</Badge>
          ) : (
            <Badge variant="secondary">Disabled</Badge>
          ),
      },
      {
        id: "mac",
        header: "MAC",
        cell: ({ row }) =>
          row.original.mac_address ? (
            <span className="font-mono text-xs">
              {row.original.mac_address}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "mtu",
        header: "MTU",
        cell: ({ row }) =>
          row.original.mtu != null ? (
            <span className="num text-xs">{row.original.mtu}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "vlan",
        header: "VLAN",
        cell: ({ row }) =>
          row.original.vlan ? (
            <Link
              to="/vlans/$id"
              params={{ id: row.original.vlan.id }}
              className="font-mono text-xs text-primary hover:underline"
            >
              {row.original.vlan.vlan_id} · {row.original.vlan.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "vrf",
        header: "VRF",
        cell: ({ row }) =>
          row.original.vrf ? (
            <Link
              to="/vrfs/$id"
              params={{ id: row.original.vrf.id }}
              className="text-xs text-primary hover:underline"
            >
              {row.original.vrf.name}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">Global</span>
          ),
      },
      {
        id: "ips",
        header: "IPs",
        cell: ({ row }) =>
          row.original.ip_addresses.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {row.original.ip_addresses.map((ip) => (
                <Link
                  key={ip.id}
                  to="/ips/$id"
                  params={{ id: ip.id }}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {ip.ip_address}
                </Link>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            {canEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="Edit"
                onClick={() => setEditing(row.original)}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="sr-only">Edit</span>
              </Button>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                title="Delete"
                onClick={() => setDeleting(row.original)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Delete</span>
              </Button>
            )}
          </div>
        ),
      },
    ],
    [canEdit, canDelete]
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add interface
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No interfaces yet.</p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          embedded
          onSelectedRowsChange={setSelected}
        />
      )}
      <ComponentBulkBar
        endpoint="/api/vm-interfaces/"
        kindLabel="VM interface"
        selected={selected}
        onCleared={() => setSelected([])}
        invalidate={[["vm-interfaces", vmId]]}
        fields={[
          { key: "enabled", label: "Enabled", kind: "bool" },
          {
            key: "mode",
            label: "802.1Q mode",
            kind: "choice",
            choices: "interface_modes",
          },
          { key: "vlan_id", label: "Untagged VLAN", kind: "vlan" },
          { key: "vrf_id", label: "VRF", kind: "vrf" },
          { key: "mtu", label: "MTU", kind: "int" },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />

      <VMInterfaceFormDialog
        vmId={vmId}
        iface={editing}
        open={adding || editing != null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          invalidate()
          setAdding(false)
          setEditing(null)
        }}
      />

      <VMInterfaceDeleteDialog
        iface={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={invalidate}
      />
    </div>
  )
}

function VMInterfaceFormDialog({
  vmId,
  iface,
  open,
  onOpenChange,
  onSaved,
}: {
  vmId: string
  iface: VMInterface | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {iface ? `Edit ${iface.name}` : "Add interface"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <VMInterfaceForm
            vmId={vmId}
            iface={iface}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function VMInterfaceForm({
  vmId,
  iface,
  onSaved,
  onCancel,
}: {
  vmId: string
  iface: VMInterface | null
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!iface
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [name, setName] = useState(iface?.name ?? "")
  const [enabled, setEnabled] = useState(iface?.enabled ?? true)
  const [mac, setMac] = useState(iface?.mac_address ?? "")
  const [mtu, setMtu] = useState(iface?.mtu != null ? String(iface.mtu) : "")
  const [description, setDescription] = useState(iface?.description ?? "")
  const [mode, setMode] = useState<string>(iface?.mode ?? "")
  const [vlanId, setVlanId] = useState<string | null>(iface?.vlan?.id ?? null)
  const [taggedVlanIds, setTaggedVlanIds] = useState<string[]>(
    iface?.tagged_vlans.map((v) => v.id) ?? []
  )
  const [vrfId, setVrfId] = useState<string | null>(iface?.vrf?.id ?? null)

  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<{ id: string; name: string }>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: () => {
      const payload: VMInterfaceWritePayload = {
        vm_id: vmId,
        name: name.trim(),
        enabled,
        mac_address: mac.trim(),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        mode,
        vlan_id: vlanId,
        tagged_vlan_ids: mode === "tagged" ? taggedVlanIds : [],
        vrf_id: vrfId,
        description: description.trim(),
      }
      if (isEdit)
        return api<VMInterface>(`/api/vm-interfaces/${iface!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<VMInterface>("/api/vm-interfaces/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
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
        mono
        placeholder="eth0"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="MAC address"
          value={mac}
          onChange={setMac}
          mono
          placeholder="00:1b:44:11:3a:b7"
          error={fieldErrors.mac_address}
        />
        <FormText
          label="MTU"
          type="number"
          value={mtu}
          onChange={setMtu}
          placeholder="1500"
          error={fieldErrors.mtu}
        />
      </div>
      {/* ── L2 switching ── */}
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="802.1Q mode"
          value={mode || null}
          onChange={(v) => setMode(v ?? "")}
          noneLabel="—"
          options={[
            { value: "access", label: "Access" },
            { value: "tagged", label: "Tagged (trunk)" },
            { value: "tagged-all", label: "Tagged (all VLANs)" },
          ]}
          error={fieldErrors.mode}
        />
        <FormSelect
          label={mode === "tagged" ? "Untagged / native VLAN" : "Untagged VLAN"}
          value={vlanId}
          onChange={setVlanId}
          noneLabel="No VLAN"
          options={(vlans.data?.results ?? []).map((v) => ({
            value: v.id,
            label: `${v.vlan_id} · ${v.name}`,
          }))}
          error={fieldErrors.vlan_id}
        />
      </div>
      {mode === "tagged" && (
        <Field label="Tagged VLANs (trunk)" error={fieldErrors.tagged_vlan_ids}>
          <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2">
            {(vlans.data?.results ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No VLANs yet.</p>
            ) : (
              (vlans.data?.results ?? []).map((v) => (
                <label
                  key={v.id}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <input
                    type="checkbox"
                    className="ck"
                    checked={taggedVlanIds.includes(v.id)}
                    onChange={(e) =>
                      setTaggedVlanIds((cur) =>
                        e.target.checked
                          ? [...cur, v.id]
                          : cur.filter((id) => id !== v.id)
                      )
                    }
                  />
                  <span className="font-mono">
                    {v.vlan_id} · {v.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </Field>
      )}

      {/* ── L3 routing ── */}
      <FormCombobox
        label="VRF"
        value={vrfId}
        onChange={setVrfId}
        noneLabel="Global (no VRF)"
        placeholder="Global (no VRF)"
        searchPlaceholder="Search VRFs…"
        emptyText="No VRFs."
        options={(vrfs.data?.results ?? []).map((v) => ({
          value: v.id,
          label: v.name,
        }))}
        error={fieldErrors.vrf_id}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create interface"}
      />
    </form>
  )
}

function VMInterfaceDeleteDialog({
  iface,
  onOpenChange,
  onDeleted,
}: {
  iface: VMInterface | null
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/vm-interfaces/${iface!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${iface!.name}`)
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!iface} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {iface?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can&apos;t be undone.
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
