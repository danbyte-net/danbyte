import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Radar, Trash2 } from "lucide-react"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import {
  api,
  ApiError,
  type Paginated,
  type Service,
  type ServiceProtocol,
  type ServiceWritePayload,
  type ServiceTemplate,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DataTable, SortHeader } from "@/components/data-table"
import { IpPicker } from "@/components/ip-picker"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

type Parent = { kind: "device" | "vm"; id: string }

/** Parse a free-text "443, 8443 22" field into a deduped, valid port list. */
export function parsePorts(input: string): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const tok of input.split(/[,\s]+/)) {
    if (tok === "") continue
    const n = Number(tok)
    if (!Number.isInteger(n) || n < 1 || n > 65535) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** "TCP 443, 8443" — protocol uppercase + comma-joined ports. */
function formatProtocolPorts(svc: Service): string {
  return `${svc.protocol.toUpperCase()} ${svc.ports.join(", ")}`
}

export function ServicesPane({
  parent,
  parentHasPrimaryIp,
}: {
  parent: Parent
  /** Whether the parent device/VM has a primary IP. When false, a service with
   * no IP of its own can't resolve a target, so Monitor is disabled. Undefined
   * (caller can't tell) keeps Monitor enabled and falls back to the error toast. */
  parentHasPrimaryIp?: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Service | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<Service | null>(null)

  const queryParam = parent.kind === "device" ? "device" : "vm"
  const q = useQuery({
    queryKey: ["services", parent.kind, parent.id],
    queryFn: () =>
      api<Paginated<Service>>(`/api/services/?${queryParam}=${parent.id}`),
  })
  const rows = q.data?.results ?? []

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["services", parent.kind, parent.id] })

  // Monitoring is a flag on the service — toggling PATCHes `monitored` and the
  // backend reconciles the per-port checks (monitoring/service_checks.py).
  const toggle = useMutation({
    mutationFn: (svc: Service) =>
      api<Service>(`/api/services/${svc.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ monitored: !svc.monitored }),
      }),
    onSuccess: (saved) => {
      if (saved.monitored && saved.check_count === 0)
        toast.warning(
          `${saved.name} is monitored, but has no target IP yet — set an IP on the service or a primary IP on its device/VM.`
        )
      else if (saved.monitored)
        toast.success(
          `Monitoring ${saved.check_count} port(s) on ${saved.name}`
        )
      else toast.success(`Stopped monitoring ${saved.name}`)
      invalidate()
      qc.invalidateQueries({ queryKey: ["prefix-checks"] })
      qc.invalidateQueries({ queryKey: ["ip-mon-status"] })
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError && err.body && typeof err.body === "object"
          ? String((err.body as { detail?: unknown }).detail ?? err.message)
          : (err as Error).message
      toast.error(detail)
    },
  })

  const columns = useMemo<ColumnDef<Service>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "ports",
        header: "Protocol / Ports",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {formatProtocolPorts(row.original)}
          </span>
        ),
      },
      {
        id: "ip",
        header: "IP",
        cell: ({ row }) =>
          row.original.ip_address ? (
            <span className="font-mono text-xs">
              {row.original.ip_address.ip_address}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "monitored",
        header: "Monitoring",
        cell: ({ row }) => {
          const svc = row.original
          if (!svc.monitored)
            return <span className="text-muted-foreground">Off</span>
          return svc.check_count > 0 ? (
            <Badge variant="success" title={`${svc.check_count} port check(s)`}>
              Monitored
            </Badge>
          ) : (
            <Badge
              variant="warning"
              title="Monitored, but no target IP yet — set an IP on the service or a primary IP on its device/VM."
            >
              No IP
            </Badge>
          )
        },
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const svc = row.original
          // The backend resolves a target from the service's own IP, falling
          // back to the parent device/VM's primary IP. When neither exists we
          // still allow enabling — it parks as "No IP" until one appears — but
          // hint that in the tooltip.
          const hasTarget = !!svc.ip_address || parentHasPrimaryIp !== false
          return (
            <div className="flex items-center justify-end gap-0.5">
              <Button
                variant={svc.monitored ? "secondary" : "outline"}
                size="sm"
                className="h-7"
                title={
                  svc.monitored
                    ? "Stop monitoring this service"
                    : hasTarget
                      ? "Monitor each port of this service"
                      : "Enable monitoring — activates once the service or its device/VM has an IP"
                }
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(svc)}
              >
                <Radar className="h-3.5 w-3.5" />
                {svc.monitored ? "Monitoring" : "Monitor"}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="Edit"
                onClick={() => setEditing(svc)}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="sr-only">Edit</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                title="Delete"
                onClick={() => setDeleting(svc)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Delete</span>
              </Button>
            </div>
          )
        },
      },
    ],
    [toggle, parentHasPrimaryIp]
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add service
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No services yet.</p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          embedded
        />
      )}

      <ServiceFormDialog
        parent={parent}
        service={editing}
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

      <ServiceDeleteDialog
        service={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={invalidate}
      />
    </div>
  )
}

function ServiceFormDialog({
  parent,
  service,
  open,
  onOpenChange,
  onSaved,
}: {
  parent: Parent
  service: Service | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {service ? `Edit ${service.name}` : "Add service"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <ServiceForm
            parent={parent}
            service={service}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ServiceForm({
  parent,
  service,
  onSaved,
  onCancel,
}: {
  parent: Parent
  service: Service | null
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!service
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [name, setName] = useState(service?.name ?? "")
  const [protocol, setProtocol] = useState<ServiceProtocol>(
    service?.protocol ?? "tcp"
  )
  const [portsText, setPortsText] = useState(service?.ports.join(", ") ?? "")
  const [description, setDescription] = useState(service?.description ?? "")
  const [ipId, setIpId] = useState<string | null>(
    service?.ip_address?.id ?? null
  )
  const [monitored, setMonitored] = useState(service?.monitored ?? false)
  const [templateId, setTemplateId] = useState<string | null>(null)

  // "From template" (create only) — pick a saved ServiceTemplate and stamp its
  // name / protocol / ports / description into the form. A reusable definition
  // ("HTTPS — TCP 443") you apply on a device.
  const templates = useQuery({
    queryKey: ["service-templates", "all"],
    queryFn: () =>
      api<Paginated<ServiceTemplate>>("/api/service-templates/?page_size=200"),
    enabled: !isEdit,
    staleTime: 5 * 60_000,
  })
  const templateOptions = useMemo(
    () =>
      (templates.data?.results ?? []).map((t) => ({
        value: t.id,
        label: `${t.name} · ${t.protocol.toUpperCase()} ${t.ports.join(", ")}`,
      })),
    [templates.data]
  )
  const applyTemplate = (id: string | null) => {
    setTemplateId(id)
    const t = templates.data?.results.find((x) => x.id === id)
    if (!t) return
    setName(t.name)
    setProtocol(t.protocol)
    setPortsText(t.ports.join(", "))
    if (t.description) setDescription(t.description)
  }

  const mutation = useMutation({
    mutationFn: () => {
      const payload: ServiceWritePayload = {
        name: name.trim(),
        protocol,
        ports: parsePorts(portsText),
        description: description.trim(),
        ip_address_id: ipId,
        monitored,
      }
      if (!isEdit) {
        if (parent.kind === "device") payload.device_id = parent.id
        else payload.virtual_machine_id = parent.id
      }
      if (isEdit)
        return api<Service>(`/api/services/${service!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Service>("/api/services/", {
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
      {!isEdit && templateOptions.length > 0 && (
        <FormCombobox
          label="From template"
          hint="optional — prefills the fields below"
          value={templateId}
          onChange={applyTemplate}
          options={templateOptions}
          noneLabel="None"
          placeholder="Start from a saved template…"
          searchPlaceholder="Search templates…"
          emptyText="No templates."
        />
      )}
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        placeholder="HTTPS"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Protocol"
          value={protocol}
          onChange={(v) => setProtocol((v as ServiceProtocol) ?? "tcp")}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
          ]}
          error={fieldErrors.protocol}
        />
        <FormText
          label="Ports"
          value={portsText}
          onChange={setPortsText}
          mono
          placeholder="443, 8443"
          hint="comma-separated"
          error={fieldErrors.ports}
        />
      </div>
      <IpPicker
        label="IP address"
        hint="optional"
        value={ipId}
        onChange={setIpId}
        noneLabel="No IP"
        placeholder="No IP — uses device/VM primary"
        error={fieldErrors.ip_address_id}
      />
      <FormCheckbox
        label="Monitor this service"
        checked={monitored}
        onChange={setMonitored}
        hint="Watch each port with a TCP/UDP check against the target IP"
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create service"}
      />
    </form>
  )
}

function ServiceDeleteDialog({
  service,
  onOpenChange,
  onDeleted,
}: {
  service: Service | null
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/services/${service!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${service!.name}`)
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!service} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {service?.name}?</AlertDialogTitle>
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
