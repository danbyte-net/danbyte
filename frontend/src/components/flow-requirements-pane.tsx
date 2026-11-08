import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  Application,
  ApplicationFlow,
  FlowDirection,
  FlowProtocol,
  FlowRequirement,
  FlowRequirementGaps,
  FlowRequirementPreview,
  IPRole,
  RequirementAddress,
  RequirementEndKind,
  RequirementFamily,
  RequirementPairing,
  Status,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { FLOW_PROTOCOLS, PORTLESS_PROTOCOLS } from "@/lib/flows"
import {
  REQUIREMENT_ADDRESSES,
  REQUIREMENT_END_KINDS,
  REQUIREMENT_FAMILIES,
  REQUIREMENT_PAIRINGS,
  REQUIREMENTS_ENDPOINT,
  defaultAddress,
  isHostEnd,
  previewText,
} from "@/lib/flow-requirements"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
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
  FormSection,
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
import { TimeCell } from "@/components/cells/time-ago"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  RequirementStateBadge,
  buildFlowRequirementColumns,
} from "@/components/columns/flow-requirement-columns"
import { buildApplicationFlowColumns } from "@/components/columns/application-flow-columns"

// The application page's Requirements tab: the flows the application needs,
// with ends that may be "this application" or "the hosts of another". Saving
// one documents it as generated flows; a row opens its panel - its flows,
// the hosts without an address, the excluded pairs and its change log.

export const requirementsQueryKey = (appId: string) =>
  ["flow-requirements", "application", appId] as const

export function FlowRequirementsPane({ app }: { app: Application }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("applicationflowrequirement", "add")
  const canEdit = canDo("applicationflowrequirement", "change")
  const canDelete = canDo("applicationflowrequirement", "delete")
  const [editing, setEditing] = useState<FlowRequirement | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<FlowRequirement | null>(null)
  const [open, setOpen] = useState<FlowRequirement | null>(null)

  const q = useQuery({
    queryKey: requirementsQueryKey(app.id),
    queryFn: () =>
      apiAll<FlowRequirement>(`${REQUIREMENTS_ENDPOINT}?application=${app.id}`),
  })
  const rows = q.data?.results ?? []
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["flow-requirements"] })
    qc.invalidateQueries({ queryKey: ["application-flows"] })
    qc.invalidateQueries({ queryKey: ["application", app.id] })
  }, [qc, app.id])

  const columns = useMemo(
    () =>
      buildFlowRequirementColumns<FlowRequirement>({
        omit: ["application"],
        onShowFlows: setOpen,
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [canEdit, canDelete]
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add requirement
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No requirements." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="application-flow-requirements"
          embedded
          searchable
          searchPlaceholder="Search requirements…"
          onRowClick={(r) => setOpen(r)}
        />
      )}
      <FlowRequirementDialog
        app={app}
        requirement={editing}
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
      <FlowRequirementPanel
        requirement={open}
        canEdit={canEdit}
        onOpenChange={(o) => !o && setOpen(null)}
        onChanged={invalidate}
      />
      <FlowRequirementDeleteDialog
        requirement={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={invalidate}
      />
    </div>
  )
}

// ─── the dialog ─────────────────────────────────────────────────────────

type EndState = {
  kind: RequirementEndKind
  /** The application of an `app` end, or the address, range or prefix. */
  id: string | null
  address: RequirementAddress
  roleId: string | null
  /** A fixed end the caller may not view (#453): kept as it is. */
  hidden?: boolean
}

function endOf(
  r: FlowRequirement | null,
  side: "source" | "destination"
): EndState {
  if (!r)
    return side === "source"
      ? { kind: "self", id: null, address: "primary", roleId: null }
      : { kind: "app", id: null, address: "service", roleId: null }
  const e = r[side]
  const kind = r[`${side}_kind`]
  return {
    kind,
    id: kind === "app" ? (e.application?.id ?? null) : e.id,
    address: r[`${side}_address`] || defaultAddress(kind),
    roleId: e.address_role?.id ?? null,
    hidden: e.hidden,
  }
}

/** The write keys for one end; none of the references for a hidden end, so
 * the server keeps it. */
export function requirementEndPayload(
  side: "source" | "destination",
  end: EndState
): Record<string, unknown> {
  const out: Record<string, unknown> = { [`${side}_kind`]: end.kind }
  if (end.hidden) return out
  out[`${side}_application_id`] = end.kind === "app" ? end.id : null
  out[`${side}_ip_id`] = end.kind === "ip" ? end.id : null
  out[`${side}_range_id`] = end.kind === "range" ? end.id : null
  out[`${side}_prefix_id`] = end.kind === "prefix" ? end.id : null
  if (isHostEnd(end.kind)) {
    out[`${side}_address`] = end.address
    out[`${side}_address_role_id`] = end.address === "role" ? end.roleId : null
  }
  return out
}

function RequirementEndField({
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
  const pick = (id: string | null) => onChange({ ...end, id, hidden: false })
  return (
    <div className="grid grid-cols-[12rem_1fr] items-start gap-3">
      <FormSelect
        label={label}
        value={end.kind}
        onChange={(v) => {
          const kind = (v as RequirementEndKind | null) ?? "self"
          onChange({
            kind,
            id: null,
            address: defaultAddress(kind),
            roleId: null,
          })
        }}
        options={REQUIREMENT_END_KINDS}
      />
      {end.hidden ? (
        <div className="pt-6 text-sm text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : "Hidden"}
        </div>
      ) : end.kind === "app" ? (
        <ApplicationPicker value={end.id} onChange={pick} error={error} />
      ) : end.kind === "ip" ? (
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
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : end.kind === "self" ? (
            "Every host it is installed on"
          ) : (
            "Any"
          )}
        </div>
      )}
    </div>
  )
}

function AddressField({
  label,
  end,
  onChange,
  roles,
  error,
}: {
  label: string
  end: EndState
  onChange: (e: EndState) => void
  roles: IPRole[]
  error?: string
}) {
  if (!isHostEnd(end.kind)) return null
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormSelect
        label={label}
        value={end.address}
        onChange={(v) =>
          onChange({
            ...end,
            address:
              (v as RequirementAddress | null) ?? defaultAddress(end.kind),
          })
        }
        options={REQUIREMENT_ADDRESSES}
      />
      {end.address === "role" && (
        <FormCombobox
          label="Role"
          value={end.roleId}
          onChange={(v) => onChange({ ...end, roleId: v })}
          options={roles.map((r) => ({
            value: r.id,
            label: r.name,
            color: r.color,
            badge: true,
          }))}
          placeholder="Select a role…"
          searchPlaceholder="Search roles…"
          emptyText="No roles."
          error={error}
        />
      )}
    </div>
  )
}

/** Add or edit one requirement, with a preview of what saving documents. */
export function FlowRequirementDialog({
  app,
  requirement,
  open,
  onOpenChange,
  onSaved,
}: {
  app: Application
  requirement: FlowRequirement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: FlowRequirement) => void
}) {
  const isEdit = !!requirement
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState("")
  const [source, setSource] = useState<EndState>(endOf(null, "source"))
  const [destination, setDestination] = useState<EndState>(
    endOf(null, "destination")
  )
  const [protocol, setProtocol] = useState<FlowProtocol>("tcp")
  const [ports, setPorts] = useState("")
  const [direction, setDirection] = useState<FlowDirection>("one-way")
  const [statusId, setStatusId] = useState<string | null>(null)
  const [family, setFamily] = useState<RequirementFamily>("any")
  const [pairing, setPairing] = useState<RequirementPairing>("all")
  const [description, setDescription] = useState("")

  useEffect(() => {
    if (!open) return
    setName(requirement?.name ?? "")
    setSource(endOf(requirement, "source"))
    setDestination(endOf(requirement, "destination"))
    setProtocol(requirement?.protocol ?? "tcp")
    setPorts(requirement?.ports ?? "")
    setDirection(requirement?.direction ?? "one-way")
    setStatusId(requirement?.status?.id ?? null)
    setFamily(requirement?.family ?? "any")
    setPairing(requirement?.pairing ?? "all")
    setDescription(requirement?.description ?? "")
    reset()
  }, [open, requirement, reset])

  const statuses = useQuery({
    queryKey: ["statuses", "applicationflow"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=applicationflow&picker=1"),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  useEffect(() => {
    if (!open || isEdit || statusId) return
    const d = statuses.data?.results.find((s) =>
      s.default_for.includes("applicationflow")
    )
    if (d) setStatusId(d.id)
  }, [open, isEdit, statusId, statuses.data])
  const needsRoles = source.address === "role" || destination.address === "role"
  const roles = useQuery({
    queryKey: ["ip-roles", "picker"],
    queryFn: () => apiAll<IPRole>("/api/ip-roles/"),
    enabled: open && needsRoles,
    staleTime: 5 * 60_000,
  })

  const portless = PORTLESS_PROTOCOLS.has(protocol)
  const payload = useMemo(
    () => ({
      application_id: app.id,
      name: name.trim(),
      ...requirementEndPayload("source", source),
      ...requirementEndPayload("destination", destination),
      protocol,
      ports: portless ? "" : ports.trim(),
      direction,
      status_id: statusId,
      family,
      pairing,
      description: description.trim(),
    }),
    [
      app.id,
      name,
      source,
      destination,
      protocol,
      ports,
      portless,
      direction,
      statusId,
      family,
      pairing,
      description,
    ]
  )

  // The preview runs a moment after the last change, once the ends name
  // what they need.
  const [previewKey, setPreviewKey] = useState("")
  useEffect(() => {
    if (!open) return
    const t = setTimeout(
      () =>
        setPreviewKey(
          JSON.stringify({
            ...payload,
            name: payload.name || "preview",
            description: "",
          })
        ),
      400
    )
    return () => clearTimeout(t)
  }, [open, payload])
  const ready = (e: EndState) =>
    e.hidden || e.kind === "self" || e.kind === "any" || !!e.id
  const preview = useQuery({
    queryKey: ["flow-requirement-preview", requirement?.id ?? "", previewKey],
    queryFn: () =>
      api<FlowRequirementPreview>(`${REQUIREMENTS_ENDPOINT}preview/`, {
        method: "POST",
        body: JSON.stringify({
          ...JSON.parse(previewKey),
          ...(requirement ? { id: requirement.id } : {}),
        }),
      }),
    enabled: open && !!previewKey && ready(source) && ready(destination),
    retry: false,
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: () =>
      api<FlowRequirement>(
        requirement
          ? `${REQUIREMENTS_ENDPOINT}${requirement.id}/`
          : REQUIREMENTS_ENDPOINT,
        {
          method: requirement ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        }
      ),
    onSuccess: (saved) => {
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const endError = (side: "source" | "destination", end: EndState) =>
    fieldErrors[`${side}_kind`] ||
    fieldErrors[side] ||
    fieldErrors[
      end.kind === "app" ? `${side}_application_id` : `${side}_${end.kind}_id`
    ]
  const p = preview.data

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit requirement" : "Add requirement"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            value={name}
            onChange={setName}
            placeholder="WMS to Broker"
            error={fieldErrors.name}
          />
          <RequirementEndField
            label="Source"
            end={source}
            onChange={setSource}
            error={endError("source", source)}
          />
          <RequirementEndField
            label="Destination"
            end={destination}
            onChange={setDestination}
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
              placeholder={portless ? "" : "5672"}
              error={fieldErrors.ports}
            />
            <FormSelect
              label="Direction"
              value={direction}
              onChange={(v) =>
                setDirection((v as FlowDirection | null) ?? "one-way")
              }
              options={[
                { value: "one-way", label: "One way" },
                { value: "both", label: "Both ways" },
              ]}
              error={fieldErrors.direction}
            />
          </div>
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
          <FormSection
            title="More"
            collapsible
            hasValues={
              family !== "any" ||
              pairing !== "all" ||
              source.address !== defaultAddress(source.kind) ||
              destination.address !== defaultAddress(destination.kind)
            }
          >
            <div className="grid gap-3">
              <AddressField
                label="Source address"
                end={source}
                onChange={setSource}
                roles={roles.data?.results ?? []}
                error={fieldErrors.source_address_role_id}
              />
              <AddressField
                label="Destination address"
                end={destination}
                onChange={setDestination}
                roles={roles.data?.results ?? []}
                error={fieldErrors.destination_address_role_id}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormSelect
                  label="Family"
                  value={family}
                  onChange={(v) =>
                    setFamily((v as RequirementFamily | null) ?? "any")
                  }
                  options={REQUIREMENT_FAMILIES}
                />
                <FormSelect
                  label="Pairing"
                  value={pairing}
                  onChange={(v) =>
                    setPairing((v as RequirementPairing | null) ?? "all")
                  }
                  options={REQUIREMENT_PAIRINGS}
                />
              </div>
            </div>
          </FormSection>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <div
            className="min-h-5 text-sm text-muted-foreground"
            data-testid="requirement-preview"
          >
            {p ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {p.refused ? (
                  <Badge variant="destructive">Too many</Badge>
                ) : p.warn ? (
                  <Badge variant="warning">Many flows</Badge>
                ) : null}
                {previewText(p)}
              </span>
            ) : null}
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add requirement"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── the panel ──────────────────────────────────────────────────────────

/** One requirement: its flows, the hosts without an address (hosts the
 * reader can't view are counted, never named), the excluded pairs with
 * Restore, Re-resolve and its change log. */
export function FlowRequirementPanel({
  requirement,
  canEdit,
  onOpenChange,
  onChanged,
}: {
  requirement: FlowRequirement | null
  canEdit: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<"flows" | "gaps" | "excluded" | "history">(
    "flows"
  )
  const id = requirement?.id
  useEffect(() => setTab("flows"), [id])
  const detail = useQuery({
    queryKey: ["flow-requirements", "detail", id],
    queryFn: () => api<FlowRequirement>(`${REQUIREMENTS_ENDPOINT}${id}/`),
    enabled: !!id,
  })
  const gaps = useQuery({
    queryKey: ["flow-requirements", "gaps", id],
    queryFn: () =>
      api<FlowRequirementGaps>(`${REQUIREMENTS_ENDPOINT}${id}/gaps/`),
    enabled: !!id && tab === "gaps",
  })
  const flows = useQuery({
    queryKey: ["application-flows", "requirement", id],
    queryFn: () =>
      apiAll<ApplicationFlow>(`/api/application-flows/?requirement=${id}`),
    enabled: !!id && tab === "flows",
  })
  const flowColumns = useMemo(
    () =>
      buildApplicationFlowColumns<ApplicationFlow>({
        omit: ["application", "origin", "description"],
      }),
    []
  )
  const resolve = useMutation({
    mutationFn: () =>
      api<{ job?: string; created?: number; removed?: number }>(
        `${REQUIREMENTS_ENDPOINT}${id}/resolve/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(r.job ? "Re-resolve queued" : "Re-resolved")
      onChanged()
    },
    onError: (err) => apiErrorToast(err),
  })
  const restore = useMutation({
    mutationFn: (eid: string) =>
      api<void>(`${REQUIREMENTS_ENDPOINT}${id}/exclusions/${eid}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Restored")
      onChanged()
    },
    onError: (err) => apiErrorToast(err),
  })
  const r = detail.data ?? requirement

  return (
    <Dialog open={!!requirement} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {r?.name}
            {r && <RequirementStateBadge state={r.state} />}
          </DialogTitle>
        </DialogHeader>
        {r && (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                {r.state_detail ||
                  `${r.generated_count} flow${r.generated_count === 1 ? "" : "s"}`}
              </span>
              {r.resolved_at && (
                <span className="text-xs">
                  · <TimeCell iso={r.resolved_at} />
                </span>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {resolve.isPending ? "Re-resolving…" : "Re-resolve"}
                </Button>
              )}
            </div>
            <SegmentedTabs
              value={tab}
              onValueChange={setTab}
              items={[
                { value: "flows", label: "Flows", count: r.generated_count },
                { value: "gaps", label: "Missing", count: r.gap_count },
                {
                  value: "excluded",
                  label: "Excluded",
                  count: r.exclusions.length,
                },
                { value: "history", label: "Change log" },
              ]}
            />
            <div className="max-h-[60vh] overflow-auto">
              {tab === "flows" &&
                (flows.isLoading ? (
                  <Loading />
                ) : flows.isError ? (
                  <QueryError error={flows.error} />
                ) : (flows.data?.results.length ?? 0) === 0 ? (
                  <EmptyState title="No flows." />
                ) : (
                  <DataTable
                    data={flows.data!.results}
                    columns={flowColumns}
                    tableId="application-flow-requirement-flows"
                    embedded
                    searchable
                    searchPlaceholder="Search flows…"
                  />
                ))}
              {tab === "gaps" &&
                (gaps.isLoading ? (
                  <Loading />
                ) : gaps.isError ? (
                  <QueryError error={gaps.error} />
                ) : gaps.data &&
                  gaps.data.gaps.length === 0 &&
                  gaps.data.hidden === 0 ? (
                  <EmptyState title="Every host has an address." />
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {gaps.data?.gaps.map((g) => (
                      <li
                        key={`${g.side}:${g.host.id}`}
                        className="flex items-center gap-2"
                      >
                        <span className="font-medium">{g.host.name}</span>
                        <Badge variant="warning">{g.reason}</Badge>
                      </li>
                    ))}
                    {gaps.data && gaps.data.hidden > 0 && (
                      <li className="text-muted-foreground">
                        {gaps.data.hidden} more
                      </li>
                    )}
                  </ul>
                ))}
              {tab === "excluded" &&
                (r.exclusions.length === 0 ? (
                  <EmptyState title="No excluded pairs." />
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {r.exclusions.map((x) => (
                      <li key={x.id} className="flex items-center gap-2">
                        <span>{x.label}</span>
                        <span className="text-xs text-muted-foreground">
                          <TimeCell iso={x.created_at} />
                        </span>
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            disabled={restore.isPending}
                            onClick={() => restore.mutate(x.id)}
                          >
                            Restore
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ))}
              {tab === "history" && (
                <ChangeLogPanel
                  objectType="api.applicationflowrequirement"
                  objectId={r.id}
                />
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FlowRequirementDeleteDialog({
  requirement,
  onOpenChange,
  onDeleted,
}: {
  requirement: FlowRequirement | null
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api<void>(`${REQUIREMENTS_ENDPOINT}${requirement!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${requirement!.name}`)
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!requirement} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {requirement?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its generated flows go; edited ones stay as hand-made flows.
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
