import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Rocket, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  AutomationTarget,
  VirtualDisk,
  VirtualDiskWritePayload,
  VirtualMachine,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useSaveObject } from "@/lib/save-object"
import { DeployDialog } from "@/components/deploy-dialog"
import type { DeployResult } from "@/components/deploy-dialog"
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
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"

// ─── Build card ──────────────────────────────────────────────────────────────

/** The VM's build fields - what a runner needs to (re)create it. */
export function VmBuildCard({ vm }: { vm: VirtualMachine }) {
  const rows: KvRow[] = [
    { label: "Intended", value: vm.intended ? "Yes" : "No" },
    {
      label: "Is router",
      value: vm.represents_device ? (
        <Link
          to="/devices/$id"
          params={{ id: vm.represents_device.id }}
          className="link"
        >
          {vm.represents_device.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "VMID",
      value: vm.vmid != null ? <span className="num">{vm.vmid}</span> : dash,
    },
    { label: "CPU type", value: vm.cpu_type ? mono(vm.cpu_type) : dash },
    {
      label: "Sockets",
      value:
        vm.sockets != null ? <span className="num">{vm.sockets}</span> : dash,
    },
    {
      label: "Image",
      value: vm.image ? mono(vm.image) : dash,
      copy: vm.image || undefined,
    },
    { label: "Storage", value: vm.storage ? mono(vm.storage) : dash },
  ]
  return <KvCard title="Build" rows={rows} />
}

/** Whether a VM has anything in its build fields worth a card. */
export function hasBuild(vm: VirtualMachine): boolean {
  return !!(
    vm.intended ||
    vm.represents_device ||
    vm.vmid != null ||
    vm.cpu_type ||
    vm.sockets != null ||
    vm.image ||
    vm.storage
  )
}

// ─── Drift: intended vs observed ─────────────────────────────────────────────

interface DriftChange {
  id: string
  kind: string
  detail: Record<string, unknown>
}
type Pair = { danbyte: unknown; hypervisor: unknown }
interface DriftRow {
  key: string
  field: string
  intended: unknown
  observed: unknown
  /** The review item this row belongs to; `first` on its first row, which
   * carries the item's buttons. */
  change: string
  kind: string
  first: boolean
}

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  vcpus: "vCPUs",
  memory_mb: "Memory MB",
  disk_gb: "Disk GB",
  vmid: "VMID",
  mac_address: "MAC",
  mtu: "MTU",
  vlan_vid: "VLAN",
  index: "Index",
  model: "Model",
  bridge: "Bridge",
}

/** Flatten spec_change and iface_change rows into field / intent / observed. */
export function driftRows(changes: DriftChange[]): DriftRow[] {
  const all: DriftRow[] = []
  for (const c of changes) {
    const out: Omit<DriftRow, "change" | "kind" | "first">[] = []
    if (c.kind === "spec_change") {
      for (const [k, v] of Object.entries(c.detail as Record<string, Pair>))
        out.push({
          key: k,
          field: FIELD_LABEL[k] ?? k,
          intended: v.danbyte,
          observed: v.hypervisor,
        })
    } else if (c.kind === "iface_change") {
      const ifaces =
        (c.detail as { interfaces?: Record<string, Record<string, Pair>> })
          .interfaces ?? {}
      for (const [name, fields] of Object.entries(ifaces))
        for (const [k, v] of Object.entries(fields))
          out.push({
            key: `${name}.${k}`,
            field: `${name} ${FIELD_LABEL[k] ?? k}`,
            intended: v.danbyte,
            observed: v.hypervisor,
          })
    } else if (c.kind === "iface_extra") {
      const names = (c.detail as { names?: string[] }).names ?? []
      for (const n of names)
        out.push({
          key: `${n}.missing`,
          field: n,
          intended: "present",
          observed: "missing",
        })
    }
    out.forEach((r, i) =>
      all.push({ ...r, change: c.id, kind: c.kind, first: i === 0 })
    )
  }
  return all
}

const show = (v: unknown) =>
  v == null || v === "" ? (
    dash
  ) : (
    <span className="font-mono text-xs">{String(v)}</span>
  )

const HELD_COLUMNS: SimpleColumn<DriftRow>[] = [
  { id: "field", header: "Field", cell: (r) => r.field },
  { id: "intended", header: "Danbyte", cell: (r) => show(r.intended) },
  { id: "observed", header: "Hypervisor", cell: (r) => show(r.observed) },
]

const DRIFT_COLUMNS: SimpleColumn<DriftRow>[] = [
  { id: "field", header: "Field", cell: (r) => r.field },
  { id: "intended", header: "Intended", cell: (r) => show(r.intended) },
  { id: "observed", header: "Hypervisor", cell: (r) => show(r.observed) },
]

/** The VM's open drift: where Danbyte and its hypervisor disagree. */
export function useVmDrift(vmId: string, enabled = true): DriftRow[] {
  const q = useQuery({
    queryKey: ["vm-drift", vmId],
    queryFn: () => apiAll<DriftChange>(`/api/virt-changes/?vm=${vmId}`),
    retry: false,
    enabled,
  })
  return driftRows(q.data?.results ?? [])
}

/** Where a VM and its hypervisor disagree, with the two ways to settle
 * each item: take the hypervisor's values into Danbyte, or keep Danbyte's
 * and dismiss it. Hidden when they agree. Nothing here writes to the
 * hypervisor. */
export function VmDriftCard({
  vmId,
  intended = true,
}: {
  vmId: string
  /** An intended VM's own values are its intent; a synced one's are just
   * what Danbyte holds. */
  intended?: boolean
}) {
  const rows = useVmDrift(vmId)
  const { canDo } = useMe()
  const canResolve = canDo("virtchange", "change")
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<DriftRow | null>(null)
  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "ignore" }) =>
      api(`/api/virt-changes/${id}/${action}/`, { method: "POST", body: "{}" }),
    onSuccess: (_, { action }) => {
      toast.success(action === "accept" ? "Change applied" : "Drift ignored")
      qc.invalidateQueries({ queryKey: ["vm-drift", vmId] })
      qc.invalidateQueries({ queryKey: ["virtual-machine", vmId] })
      qc.invalidateQueries({ queryKey: ["virt-changes"] })
      qc.invalidateQueries({ queryKey: ["vm-interfaces", vmId] })
    },
    onError: (e) => apiErrorToast(e),
  })
  if (rows.length === 0) return null
  const removes = (r: DriftRow) => r.kind === "iface_extra"
  const columns: SimpleColumn<DriftRow>[] = [
    ...(intended ? DRIFT_COLUMNS : HELD_COLUMNS),
    ...(canResolve
      ? [
          {
            id: "actions",
            header: "",
            cell: (r: DriftRow) =>
              r.first ? (
                <span className="flex justify-end gap-1 whitespace-nowrap">
                  <Button
                    size="sm"
                    variant={removes(r) ? "destructive" : "outline"}
                    className="h-7 px-2 text-xs"
                    disabled={resolve.isPending}
                    onClick={() =>
                      // Deleting an interface, or overwriting intent,
                      // deserves a beat.
                      removes(r) || intended
                        ? setConfirm(r)
                        : resolve.mutate({ id: r.change, action: "accept" })
                    }
                  >
                    {removes(r) ? "Delete interface" : "Use hypervisor's"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={resolve.isPending}
                    onClick={() =>
                      resolve.mutate({ id: r.change, action: "ignore" })
                    }
                  >
                    {removes(r) ? "Keep" : "Keep Danbyte's"}
                  </Button>
                </span>
              ) : null,
          } satisfies SimpleColumn<DriftRow>,
        ]
      : []),
  ]
  return (
    <>
      <OverviewTable
        title="Drift"
        count={rows.length}
        columns={columns}
        data={rows}
        getRowKey={(r) => r.key}
      />
      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm && removes(confirm)
                ? "Delete these interfaces from Danbyte?"
                : "Replace the intended values?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && removes(confirm)
                ? "The hypervisor doesn't report them, so this removes the Danbyte rows, including anything cabled or addressed on them."
                : "This VM is intended. Its intended values are replaced with the hypervisor's."}{" "}
              Nothing on the hypervisor is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm && removes(confirm) ? "destructive" : "default"}
              onClick={(e) => {
                e.preventDefault()
                if (confirm)
                  resolve.mutate({ id: confirm.change, action: "accept" })
                setConfirm(null)
              }}
            >
              {confirm && removes(confirm)
                ? "Delete in Danbyte"
                : "Use hypervisor's"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ─── Disks ───────────────────────────────────────────────────────────────────

const CONTROLLERS = [
  { value: "scsi", label: "SCSI" },
  { value: "virtio", label: "VirtIO" },
  { value: "ide", label: "IDE" },
  { value: "sata", label: "SATA" },
  { value: "nvme", label: "NVMe" },
]

/** The VM's virtual disks, editable with the virtualdisk grants. */
export function VmDisks({ vm }: { vm: VirtualMachine }) {
  const { canDo } = useMe()
  const canAdd = canDo("virtualdisk", "add")
  const canEdit = canDo("virtualdisk", "change")
  const canDelete = canDo("virtualdisk", "delete")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<VirtualDisk | "new" | null>(null)
  const [deleting, setDeleting] = useState<VirtualDisk | null>(null)
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["virtual-machine", vm.id] })

  const remove = useMutation({
    mutationFn: (d: VirtualDisk) =>
      api<void>(`/api/virtual-disks/${d.id}/`, { method: "DELETE" }),
    onSuccess: (_, d) => {
      toast.success(`Deleted ${d.name || d.key}`)
      setDeleting(null)
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (vm.disks.length === 0 && !canAdd) return null
  const columns: SimpleColumn<VirtualDisk>[] = [
    {
      id: "name",
      header: "Disk",
      cell: (d) => <span className="font-mono text-xs">{d.name || d.key}</span>,
    },
    {
      id: "size",
      header: "Size",
      cell: (d) =>
        d.size_gb != null ? <span className="num">{d.size_gb} GB</span> : dash,
    },
    { id: "storage", header: "Storage", cell: (d) => d.storage || dash },
    {
      id: "controller",
      header: "Controller",
      cell: (d) =>
        d.controller ? <span className="uppercase">{d.controller}</span> : dash,
    },
    ...(canEdit || canDelete
      ? [
          {
            id: "actions",
            header: "",
            align: "right",
            cell: (d) => (
              <span className="inline-flex justify-end gap-0.5">
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => setEditing(d)}
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
                    onClick={() => setDeleting(d)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span className="sr-only">Delete</span>
                  </Button>
                )}
              </span>
            ),
          } satisfies SimpleColumn<VirtualDisk>,
        ]
      : []),
  ]
  return (
    <>
      <OverviewTable
        title="Disks"
        count={vm.disks.length}
        columns={columns}
        data={vm.disks}
        getRowKey={(d) => d.id}
        actions={
          canAdd && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing("new")}
            >
              <Plus className="h-3.5 w-3.5" /> Add disk
            </Button>
          )
        }
      />
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {editing === "new"
                ? "New disk"
                : `Edit ${editing?.name || editing?.key}`}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <DiskForm
              vmId={vm.id}
              disk={editing === "new" ? undefined : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                refresh()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.name || deleting?.key}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleting) remove.mutate(deleting)
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function DiskForm({
  vmId,
  disk,
  onSaved,
  onCancel,
}: {
  vmId: string
  disk?: VirtualDisk
  onSaved: () => void
  onCancel: () => void
}) {
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()
  const [key, setKey] = useState(disk?.key ?? "")
  const [name, setName] = useState(disk?.name ?? "")
  const [size, setSize] = useState(
    disk?.size_gb != null ? String(disk.size_gb) : ""
  )
  const [storage, setStorage] = useState(disk?.storage ?? "")
  const [controller, setController] = useState(disk?.controller ?? "")
  const [format, setFormat] = useState(disk?.disk_format ?? "")
  const [description, setDescription] = useState(disk?.description ?? "")

  const m = useMutation({
    mutationFn: () => {
      const payload: VirtualDiskWritePayload = {
        vm_id: vmId,
        key: key.trim(),
        name: name.trim(),
        size_gb: size.trim() === "" ? null : Number(size),
        storage: storage.trim(),
        controller,
        disk_format: format.trim(),
        description: description.trim(),
      }
      return saveObject<VirtualDisk>({
        objectType: "api.virtualdisk",
        endpoint: "/api/virtual-disks/",
        id: disk?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      toast.success(
        disk
          ? `Updated ${saved.name || saved.key}`
          : `Created ${saved.name || saved.key}`
      )
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
        m.mutate()
      }}
      className="grid gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Key"
          required
          autoFocus={!disk}
          value={key}
          onChange={setKey}
          mono
          placeholder="scsi0"
          error={fieldErrors.key}
        />
        <FormText
          label="Name"
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormText
          label="Size GB"
          type="number"
          min={0}
          value={size}
          onChange={setSize}
          placeholder="32"
          error={fieldErrors.size_gb}
        />
        <FormText
          label="Storage"
          value={storage}
          onChange={setStorage}
          mono
          placeholder="local-lvm"
          error={fieldErrors.storage}
        />
        <FormSelect
          label="Controller"
          value={controller || null}
          onChange={(v) => setController(v ?? "")}
          noneLabel="-"
          options={CONTROLLERS}
          error={fieldErrors.controller}
        />
        <FormText
          label="Format"
          value={format}
          onChange={setFormat}
          mono
          placeholder="raw"
          error={fieldErrors.disk_format}
        />
      </div>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={m.isPending}
        submitLabel={disk ? "Save changes" : "Create disk"}
      />
    </form>
  )
}

// ─── Provision ───────────────────────────────────────────────────────────────

/** Targets that take virtual machines: enabled, and naming the type or "*". */
export function coversVms(t: AutomationTarget): boolean {
  return (
    t.enabled &&
    (t.object_types.includes("virtualmachine") || t.object_types.includes("*"))
  )
}

/** Send an intended VM to an automation runner, or through a pipeline, to
 * be built. The caller shows it only with the provision grant; the server
 * enforces it. */
export function VmProvisionButton({ vm }: { vm: VirtualMachine }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Rocket className="h-3.5 w-3.5" /> Provision
      </Button>
      <DeployDialog
        open={open}
        onOpenChange={setOpen}
        title={`Provision ${vm.name}`}
        objectType="virtualmachine"
        roleIds={[vm.role?.id]}
        verb="Provision"
        submit={(c) =>
          api<DeployResult>(`/api/virtual-machines/${vm.id}/provision/`, {
            method: "POST",
            body: JSON.stringify(
              c.kind === "pipeline"
                ? { pipeline_id: c.id, dry_run: c.dryRun }
                : { target_id: c.id, dry_run: c.dryRun }
            ),
          })
        }
      />
    </>
  )
}
