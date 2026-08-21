import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DeviceTypeService,
  type DeviceTypeServiceWritePayload,
  type Paginated,
  type ServiceTemplate,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useRegisterAddActions } from "@/components/device-add-actions"
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
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { dash } from "@/components/cells/dash"
import { useSaveObject } from "@/lib/save-object"
import {
  EMPTY_SERVICE_PORTS,
  parseServicePorts,
  ServicePortsField,
  servicePortsFromApi,
  servicePortsLabel,
  type ServicePortsValue,
} from "@/components/service-ports-field"

const QUERY_KEY = "dt-service-templates"

/** The "Services" tab on a device type - service templates that materialise a
 * Service onto every new device of the type. Ticking Monitor starts those
 * services watched. See docs/architecture/service-monitoring.md. */
// Thrown to abort the save when a port field is wrong: the message is already
// on the field, so onError skips its generic toast.
const CLIENT_INVALID_PORTS = "client-invalid-ports"

export function DeviceTypeServicesSection({
  deviceTypeId,
  canWrite,
}: {
  deviceTypeId: string
  canWrite: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<DeviceTypeService | null>(null)
  const [deleting, setDeleting] = useState<DeviceTypeService | null>(null)

  // Publish the Add button up into the shared sub-tab bar.
  useRegisterAddActions(
    "dt-service",
    canWrite ? [{ label: "Add", onClick: () => setAdding(true) }] : []
  )

  const q = useQuery({
    queryKey: [QUERY_KEY, deviceTypeId],
    queryFn: () =>
      api<Paginated<DeviceTypeService>>(
        `/api/device-type-services/?device_type=${deviceTypeId}`
      ),
  })

  const columns: ColumnDef<DeviceTypeService>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      id: "ports",
      header: "Protocol / Ports",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {servicePortsLabel(
            row.original.protocol_ports,
            row.original.protocol,
            row.original.ports
          )}
        </span>
      ),
    },
    {
      id: "monitor",
      header: "Monitoring",
      cell: ({ row }) =>
        row.original.monitor ? (
          <Badge variant="success">On new devices</Badge>
        ) : (
          <span className="text-muted-foreground">Off</span>
        ),
    },
    {
      id: "description",
      header: "Description",
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-xs text-muted-foreground">
            {row.original.description}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "actions",
      header: "",
      enableHiding: false,
      cell: ({ row }) =>
        canWrite ? (
          <div className="flex justify-end gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setEditing(row.original)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null,
    },
  ]

  const rows = q.data?.results ?? []

  return (
    <section className="space-y-3">
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No service templates. Add the services a device of this type exposes -
          tick Monitor to have every new device watched automatically.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          embedded
        />
      )}

      <ServiceTemplateDialog
        deviceTypeId={deviceTypeId}
        service={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />

      <DeleteDialog
        deviceTypeId={deviceTypeId}
        service={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </section>
  )
}

function ServiceTemplateDialog({
  deviceTypeId,
  service,
  open,
  onOpenChange,
}: {
  deviceTypeId: string
  service: DeviceTypeService | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const editing = !!service
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${service.name}` : "Add service template"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <ServiceTemplateForm
            deviceTypeId={deviceTypeId}
            service={service}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ServiceTemplateForm({
  deviceTypeId,
  service,
  onDone,
}: {
  deviceTypeId: string
  service: DeviceTypeService | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const editing = !!service
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(service?.name ?? "")
  const [ports, setPorts] = useState<ServicePortsValue>(
    service
      ? servicePortsFromApi(
          service.protocol_ports,
          service.protocol,
          service.ports
        )
      : EMPTY_SERVICE_PORTS
  )
  const [portErrors, setPortErrors] = useState<{
    tcp: string | null
    udp: string | null
  }>({ tcp: null, udp: null })
  const [monitor, setMonitor] = useState(service?.monitor ?? false)
  const [description, setDescription] = useState(service?.description ?? "")
  const [templateId, setTemplateId] = useState<string | null>(null)

  // "From template" (create only) - reuse a saved ServiceTemplate ("HTTPS -
  // TCP 443") to stamp its name / protocol / ports / description into the form.
  const templates = useQuery({
    queryKey: ["service-templates", "all"],
    queryFn: () =>
      api<Paginated<ServiceTemplate>>("/api/service-templates/?page_size=200"),
    enabled: !editing,
    staleTime: 5 * 60_000,
  })
  const templateOptions = useMemo(
    () =>
      (templates.data?.results ?? []).map((t) => ({
        value: t.id,
        label: `${t.name} · ${servicePortsLabel(
          t.protocol_ports,
          t.protocol,
          t.ports
        )}`,
      })),
    [templates.data]
  )
  const applyTemplate = (id: string | null) => {
    setTemplateId(id)
    const t = templates.data?.results.find((x) => x.id === id)
    if (!t) return
    setName(t.name)
    setPorts(servicePortsFromApi(t.protocol_ports, t.protocol, t.ports))
    if (t.description) setDescription(t.description)
  }

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = parseServicePorts(ports)
      setPortErrors({ tcp: parsed.errors.tcp, udp: parsed.errors.udp })
      if (parsed.errors.tcp || parsed.errors.udp || parsed.errors.form) {
        if (parsed.errors.form)
          setPortErrors({ tcp: parsed.errors.form, udp: null })
        throw new Error(CLIENT_INVALID_PORTS)
      }
      const payload: DeviceTypeServiceWritePayload = {
        device_type_id: deviceTypeId,
        name: name.trim(),
        protocol: parsed.protocol,
        ports: parsed.ports,
        protocol_ports: parsed.protocol_ports,
        monitor,
        description: description.trim(),
      }
      return saveObject<DeviceTypeService>({
        objectType: "api.devicetypeservice",
        endpoint: "/api/device-type-services/",
        id: editing ? service!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      toast.success(editing ? `Updated ${saved.name}` : `Created ${saved.name}`)
      qc.invalidateQueries({ queryKey: [QUERY_KEY, deviceTypeId] })
      onDone()
    },
    onError: (err) => {
      if ((err as Error).message === CLIENT_INVALID_PORTS) return
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
      {!editing && templateOptions.length > 0 && (
        <FormCombobox
          label="From template"
          hint="optional - prefills the fields below"
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
        autoFocus
        value={name}
        onChange={setName}
        placeholder="HTTPS"
        error={fieldErrors.name}
      />
      <ServicePortsField
        value={ports}
        onChange={(v) => {
          setPorts(v)
          setPortErrors({ tcp: null, udp: null })
        }}
        errors={{
          tcp: portErrors.tcp ?? fieldErrors.ports ?? fieldErrors.protocol_ports,
          udp: portErrors.udp,
        }}
      />
      <FormCheckbox
        label="Monitor on new devices"
        checked={monitor}
        onChange={setMonitor}
        hint="Devices created from this type start watching this service"
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onDone}
        submitting={mutation.isPending}
        submitLabel={editing ? "Save changes" : "Create template"}
      />
    </form>
  )
}

function DeleteDialog({
  deviceTypeId,
  service,
  onOpenChange,
}: {
  deviceTypeId: string
  service: DeviceTypeService | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/device-type-services/${service!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${service!.name}`)
      qc.invalidateQueries({ queryKey: [QUERY_KEY, deviceTypeId] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!service} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {service?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes this service template from the device type. Existing devices
            keep their services - only future devices are affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
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
