import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ApplicationFlow,
  FlowDirection,
  FlowEndKind,
  FlowProtocol,
  FlowSide,
  IPAddress,
  Paginated,
  Service,
  Status,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { FLOW_PROTOCOLS, PORTLESS_PROTOCOLS } from "@/lib/flows"
import { useSaveObject } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { FormStatusSelect } from "@/components/forms/status-select"
import { ApplicationPicker } from "@/components/application-picker"
import { IpPicker } from "@/components/ip-picker"
import { IpRangePicker } from "@/components/ip-range-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import {
  buildApplicationFlowColumns,
  FLOW_DIRECTION_LABELS,
} from "@/components/columns/application-flow-columns"

// The Flows tab (#163) on applications, devices, VMs, addresses and
// prefixes: the traffic each application needs, from one end to another.
// A device's or VM's tab lists the flows of its addresses and of the
// prefixes and ranges that hold them. Add and edit in a dialog; delete one
// or many through the shared safe bulk-delete bar.

export type FlowScope = {
  kind: "application" | "device" | "vm" | "ip" | "prefix"
  id: string
}

export const flowsQueryKey = (s: FlowScope) =>
  ["application-flows", s.kind, s.id] as const

const ENDPOINT = "/api/application-flows/"

export function ApplicationFlowPane({ scope }: { scope: FlowScope }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("applicationflow", "add")
  const canEdit = canDo("applicationflow", "change")
  const canDelete = canDo("applicationflow", "delete")
  const [editing, setEditing] = useState<ApplicationFlow | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ApplicationFlow | null>(null)
  const [selected, setSelected] = useState<ApplicationFlow[]>([])

  const q = useQuery({
    queryKey: flowsQueryKey(scope),
    queryFn: () =>
      api<Paginated<ApplicationFlow>>(`${ENDPOINT}?${scope.kind}=${scope.id}`),
  })
  const rows = q.data?.results ?? []
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["application-flows"] })
    qc.invalidateQueries({ queryKey: ["application"] })
    qc.invalidateQueries({ queryKey: ["applications"] })
  }, [qc])

  const columns = useMemo(
    () =>
      buildApplicationFlowColumns<ApplicationFlow>({
        omit: scope.kind === "application" ? ["application"] : [],
        selection: canDelete,
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [scope.kind, canEdit, canDelete]
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add flow
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No flows recorded." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="application-flows"
          embedded
          searchable
          searchPlaceholder="Search flows…"
          onSelectedRowsChange={setSelected}
          selectedRows={selected}
        />
      )}
      <ApplicationFlowDialog
        scope={scope}
        flow={editing}
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
      <ApplicationFlowDeleteDialog
        flow={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={invalidate}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={["flow", "flows"]}
        invalidate={[["application-flows"], ["application"], ["applications"]]}
        onCleared={() => setSelected([])}
        canDelete={canDelete}
      />
    </div>
  )
}

const END_KINDS: { value: FlowEndKind; label: string }[] = [
  { value: "ip", label: "Address" },
  { value: "range", label: "Range" },
  { value: "prefix", label: "Prefix" },
  { value: "any", label: "Any" },
]

const DIRECTIONS: { value: FlowDirection; label: string }[] = [
  { value: "one-way", label: FLOW_DIRECTION_LABELS["one-way"] },
  { value: "both", label: FLOW_DIRECTION_LABELS.both },
]

type EndState = { kind: FlowEndKind; id: string | null }

function endOf(flow: ApplicationFlow | null, side: FlowSide): EndState {
  const e = flow?.[side]
  return e ? { kind: e.kind, id: e.id } : { kind: "ip", id: null }
}

/** The write keys for one end: the chosen kind's id, the others cleared. */
export function endPayload(side: FlowSide, end: EndState) {
  return {
    [`${side}_ip_id`]: end.kind === "ip" ? end.id : null,
    [`${side}_range_id`]: end.kind === "range" ? end.id : null,
    [`${side}_prefix_id`]: end.kind === "prefix" ? end.id : null,
    [`${side}_any`]: end.kind === "any",
  }
}

/** One end: what kind it is, then the address, range or prefix. */
function FlowEndField({
  label,
  end,
  onChange,
  error,
}: {
  label: string
  end: EndState
  onChange: (e: EndState) => void
  error?: string
}) {
  const pick = (id: string | null) => onChange({ ...end, id })
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3">
      <FormSelect
        label={label}
        value={end.kind}
        onChange={(v) =>
          onChange({ kind: (v as FlowEndKind | null) ?? "ip", id: null })
        }
        options={END_KINDS}
      />
      {end.kind === "ip" ? (
        <IpPicker
          label="Address"
          value={end.id}
          onChange={pick}
          error={error}
        />
      ) : end.kind === "range" ? (
        <IpRangePicker
          label="Range"
          value={end.id}
          onChange={pick}
          error={error}
        />
      ) : end.kind === "prefix" ? (
        <PrefixPicker
          label="Prefix"
          value={end.id}
          onChange={pick}
          error={error}
        />
      ) : (
        <div className="pt-6 text-sm text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : "Any"}
        </div>
      )}
    </div>
  )
}

/** Add or edit one flow. A tab's own address or prefix starts as the
 * source of a new flow; the application tab fixes the application. */
export function ApplicationFlowDialog({
  scope,
  flow,
  open,
  onOpenChange,
  onSaved,
}: {
  scope: FlowScope
  flow: ApplicationFlow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: ApplicationFlow) => void
}) {
  const isEdit = !!flow
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [source, setSource] = useState<EndState>({ kind: "ip", id: null })
  const [destination, setDestination] = useState<EndState>({
    kind: "ip",
    id: null,
  })
  const [protocol, setProtocol] = useState<FlowProtocol>("tcp")
  const [ports, setPorts] = useState("")
  const [direction, setDirection] = useState<FlowDirection>("one-way")
  const [statusId, setStatusId] = useState<string | null>(null)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [description, setDescription] = useState("")

  useEffect(() => {
    if (!open) return
    setApplicationId(
      flow?.application.id ?? (scope.kind === "application" ? scope.id : null)
    )
    setName(flow?.name ?? "")
    setSource(
      flow
        ? endOf(flow, "source")
        : scope.kind === "ip" || scope.kind === "prefix"
          ? { kind: scope.kind, id: scope.id }
          : { kind: "ip", id: null }
    )
    setDestination(endOf(flow, "destination"))
    setProtocol(flow?.protocol ?? "tcp")
    setPorts(flow?.ports ?? "")
    setDirection(flow?.direction ?? "one-way")
    setStatusId(flow?.status?.id ?? null)
    setServiceId(flow?.service?.id ?? null)
    setDescription(flow?.description ?? "")
    reset()
  }, [open, flow, scope.kind, scope.id, reset])

  const statuses = useQuery({
    queryKey: ["statuses", "applicationflow"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=applicationflow&picker=1"
      ),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  // A new flow starts at the catalog's default status.
  useEffect(() => {
    if (!open || isEdit || statusId) return
    const d = statuses.data?.results.find((s) =>
      s.default_for.includes("applicationflow")
    )
    if (d) setStatusId(d.id)
  }, [open, isEdit, statusId, statuses.data])

  // The service list: the destination address's device or VM's services.
  const destIp = useQuery({
    queryKey: ["ip", destination.id],
    queryFn: () => api<IPAddress>(`/api/ips/${destination.id}/`),
    enabled: open && destination.kind === "ip" && !!destination.id,
  })
  const host = destIp.data?.assigned_device
    ? `device=${destIp.data.assigned_device.id}`
    : destIp.data?.assigned_vm
      ? `vm=${destIp.data.assigned_vm.id}`
      : null
  const services = useQuery({
    queryKey: ["services", host],
    queryFn: () => api<Paginated<Service>>(`/api/services/?${host}`),
    enabled: open && destination.kind === "ip" && !!host,
  })
  const showService = destination.kind === "ip" && !!host

  const portless = PORTLESS_PROTOCOLS.has(protocol)

  const save = useMutation({
    mutationFn: () =>
      saveObject<ApplicationFlow>({
        objectType: "api.applicationflow",
        endpoint: ENDPOINT,
        id: flow?.id,
        payload: {
          application_id: applicationId,
          name: name.trim(),
          ...endPayload("source", source),
          ...endPayload("destination", destination),
          protocol,
          // A protocol without ports sends none, whatever was typed before.
          ports: portless ? "" : ports.trim(),
          direction,
          status_id: statusId,
          service_id: showService ? serviceId : null,
          description: description.trim(),
        },
      }),
    onSuccess: (saved) => {
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const endError = (side: FlowSide, end: EndState) =>
    fieldErrors[side] ?? fieldErrors[`${side}_${end.kind}_id`]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit flow" : "Add flow"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          {scope.kind !== "application" && (
            <ApplicationPicker
              required
              value={applicationId}
              onChange={setApplicationId}
              error={fieldErrors.application_id}
            />
          )}
          <FormText
            label="Name"
            required
            value={name}
            onChange={setName}
            placeholder="web to database"
            error={fieldErrors.name}
          />
          <FlowEndField
            label="Source"
            end={source}
            onChange={setSource}
            error={endError("source", source)}
          />
          <FlowEndField
            label="Destination"
            end={destination}
            onChange={(e) => {
              setDestination(e)
              setServiceId(null)
            }}
            error={endError("destination", destination)}
          />
          <div className="grid grid-cols-3 gap-3">
            <FormSelect
              label="Protocol"
              value={protocol}
              onChange={(v) => setProtocol((v as FlowProtocol | null) ?? "tcp")}
              options={FLOW_PROTOCOLS}
              error={fieldErrors.protocol}
            />
            <FormText
              label="Ports"
              value={portless ? "" : ports}
              onChange={setPorts}
              mono
              disabled={portless}
              placeholder={portless ? "" : "443, 8000-8100"}
              error={fieldErrors.ports}
            />
            <FormSelect
              label="Direction"
              value={direction}
              onChange={(v) =>
                setDirection((v as FlowDirection | null) ?? "one-way")
              }
              options={DIRECTIONS}
              error={fieldErrors.direction}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              error={fieldErrors.status_id}
            />
            {showService && (
              <FormCombobox
                label="Service"
                hint="optional"
                value={serviceId}
                onChange={setServiceId}
                options={(services.data?.results ?? []).map((s) => ({
                  value: s.id,
                  label: s.name,
                }))}
                noneLabel="No service"
                placeholder="Select a service…"
                searchPlaceholder="Search services…"
                emptyText="No services here."
                error={fieldErrors.service_id}
              />
            )}
          </div>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add flow"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ApplicationFlowDeleteDialog({
  flow,
  onOpenChange,
  onDeleted,
}: {
  flow: ApplicationFlow | null
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api<void>(`${ENDPOINT}${flow!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${flow!.name}`)
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!flow} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {flow?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can&apos;t be undone.
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
