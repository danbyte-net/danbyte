import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  Paginated,
  PrtgConnection,
  PrtgPolicy,
  PrtgPolicyScope,
  PrtgSensorProfile,
  TagOption,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"

import { PrtgGroupPicker } from "./group-picker"

export const POLICY_SCOPES: { value: PrtgPolicyScope; label: string }[] = [
  { value: "global", label: "Every device and VM" },
  { value: "region", label: "Region" },
  { value: "site", label: "Site" },
  { value: "location", label: "Location" },
  { value: "platform", label: "Platform" },
  { value: "device_type", label: "Device type" },
  { value: "device_role", label: "Role" },
]

/** The policy field holding each scope's target, and where to list them. */
const TARGETS: Record<
  Exclude<PrtgPolicyScope, "global">,
  { field: keyof PrtgPolicy; api: string }
> = {
  region: { field: "region", api: "/api/regions/" },
  site: { field: "target_site", api: "/api/sites/" },
  location: { field: "location", api: "/api/locations/" },
  platform: { field: "platform", api: "/api/platforms/" },
  device_type: { field: "device_type", api: "/api/device-types/" },
  device_role: { field: "device_role", api: "/api/device-roles/" },
}

function filterSummary(p: PrtgPolicy): string {
  const parts: string[] = []
  if (p.match_name) parts.push(`name ${p.match_name}`)
  if (p.match_tags.length) parts.push(`tags ${p.match_tags.join(", ")}`)
  if (p.match_hardware) parts.push(`hardware ${p.match_hardware}`)
  return parts.join(" · ")
}

/** Which devices and VMs PRTG should have, with which sensors, where.
 * Policies stack; the first matching one by priority picks the group. */
export function PrtgPolicies({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<PrtgPolicy | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgPolicy | null>(null)

  const policies = useQuery({
    queryKey: ["prtg-policies", connection.id],
    queryFn: () =>
      apiAll<PrtgPolicy>(`/api/prtg/policies/?connection=${connection.id}`),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/policies/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Policy deleted")
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ["prtg-policies"] })
      void qc.invalidateQueries({ queryKey: ["prtg-profiles"] })
    },
    onError: apiErrorToast,
  })
  const rows = policies.data?.results ?? []

  const columns = useMemo<ColumnDef<PrtgPolicy>[]>(
    () => [
      {
        id: "priority",
        accessorKey: "priority",
        header: ({ column }) => <SortHeader column={column} label="Priority" />,
        cell: ({ row }) => (
          <span className="num text-xs text-muted-foreground">
            {row.original.priority}
          </span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "applies",
        accessorFn: (p) => `${p.scope_display} ${p.target_name}`,
        header: ({ column }) => (
          <SortHeader column={column} label="Applies to" />
        ),
        cell: ({ row }) => {
          const p = row.original
          const filters = filterSummary(p)
          return (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span>
                {p.scope === "global" ? p.scope_display : p.target_name}
              </span>
              {p.scope !== "global" && (
                <span className="text-xs text-muted-foreground">
                  {p.scope_display}
                </span>
              )}
              {p.applies_to_devices && (
                <Badge variant="secondary">Devices</Badge>
              )}
              {p.applies_to_vms && <Badge variant="secondary">VMs</Badge>}
              {filters && (
                <span className="text-xs text-muted-foreground">{filters}</span>
              )}
            </span>
          )
        },
      },
      {
        id: "profile",
        accessorKey: "profile_name",
        header: ({ column }) => <SortHeader column={column} label="Profile" />,
        cell: ({ row }) =>
          row.original.profile_name || (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "group",
        accessorKey: "group_path",
        header: ({ column }) => <SortHeader column={column} label="Group" />,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.group_path || row.original.group_id}
          </span>
        ),
      },
      {
        id: "enabled",
        accessorKey: "enabled",
        header: ({ column }) => <SortHeader column={column} label="Enabled" />,
        cell: ({ row }) =>
          row.original.enabled ? (
            <Badge variant="success">On</Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <RowActions
                  onEdit={() => setEditing(row.original)}
                  onDelete={() => setDeleting(row.original)}
                />
              ),
            } as ColumnDef<PrtgPolicy>,
          ]
        : []),
    ],
    [canManage]
  )

  return (
    <Section
      title="Policies"
      count={rows.length}
      actions={
        canManage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add policy
          </Button>
        )
      }
    >
      {policies.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No policies">
          A policy picks devices and VMs and names their sensors and group.
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-policies"
          data={rows}
          total={policies.data?.count}
          columns={columns}
          flexColumn="applies"
        />
      )}

      <Dialog
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit policy" : "Add policy"}</DialogTitle>
          </DialogHeader>
          {(adding || !!editing) && (
            <PolicyForm
              connection={connection}
              policy={editing}
              onDone={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this policy?"
        description="Nothing in PRTG changes; the planned changes it made go at the next plan."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Section>
  )
}

export function PolicyForm({
  connection,
  policy,
  onDone,
}: {
  connection: PrtgConnection
  policy: PrtgPolicy | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const initialScope = policy?.scope ?? "global"
  const [name, setName] = useState(policy?.name ?? "")
  const [scope, setScope] = useState<PrtgPolicyScope>(initialScope)
  const [target, setTarget] = useState<string | null>(
    policy && initialScope !== "global"
      ? ((policy[TARGETS[initialScope].field] as string | null) ?? null)
      : null
  )
  const [tags, setTags] = useState<string[]>(policy?.match_tags ?? [])
  const [matchName, setMatchName] = useState(policy?.match_name ?? "")
  const [hardware, setHardware] = useState(policy?.match_hardware ?? "")
  const [devices, setDevices] = useState(policy?.applies_to_devices ?? true)
  const [vms, setVms] = useState(policy?.applies_to_vms ?? true)
  const [profile, setProfile] = useState<string | null>(policy?.profile ?? null)
  const [groupId, setGroupId] = useState<string | null>(
    policy?.group_id || null
  )
  const [groupPath, setGroupPath] = useState(policy?.group_path ?? "")
  const [priority, setPriority] = useState(String(policy?.priority ?? 100))
  const [enabled, setEnabled] = useState(policy?.enabled ?? true)

  const catalog = scope === "global" ? "" : TARGETS[scope].api
  const options = useQuery({
    queryKey: ["prtg-policy-catalog", catalog],
    queryFn: () =>
      api<Paginated<{ id: string; name?: string; model?: string }>>(
        `${catalog}?page_size=500`
      ),
    enabled: !!catalog,
    staleTime: 10 * 60_000,
  })
  const profiles = useQuery({
    queryKey: ["prtg-profiles", connection.id],
    queryFn: () =>
      apiAll<PrtgSensorProfile>(
        `/api/prtg/profiles/?connection=${connection.id}`
      ),
  })
  const tagQuery = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => apiAll<TagOption>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  // The policy stores slugs; the shared picker works in ids.
  const tagRows = tagQuery.data?.results ?? []
  const pickedIds = tagRows
    .filter((t) => tags.includes(t.slug))
    .map((t) => t.id)
  const onTags = (ids: number[]) =>
    setTags([
      ...tagRows.filter((t) => ids.includes(t.id)).map((t) => t.slug),
      ...tags.filter((slug) => !tagRows.some((t) => t.slug === slug)),
    ])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        connection: connection.id,
        name: name.trim(),
        scope,
        match_tags: tags,
        match_name: matchName.trim(),
        match_hardware: hardware.trim(),
        applies_to_devices: devices,
        applies_to_vms: vms,
        profile,
        group_id: groupId ?? "",
        group_path: groupPath,
        priority: Number(priority) || 100,
        enabled,
      }
      if (scope !== "global") body[TARGETS[scope].field] = target
      return api<PrtgPolicy>(
        policy ? `/api/prtg/policies/${policy.id}/` : "/api/prtg/policies/",
        { method: policy ? "PATCH" : "POST", body: JSON.stringify(body) }
      )
    },
    onSuccess: () => {
      toast.success(policy ? "Policy saved" : "Policy added")
      void qc.invalidateQueries({ queryKey: ["prtg-policies"] })
      void qc.invalidateQueries({ queryKey: ["prtg-profiles"] })
      onDone()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const targetLabel = POLICY_SCOPES.find((s) => s.value === scope)?.label ?? ""
  const targetError =
    scope === "global" ? undefined : fieldErrors[TARGETS[scope].field as string]

  return (
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
        placeholder="Core switches"
        error={fieldErrors.name}
      />
      <FormSelect
        label="Applies to"
        value={scope}
        onChange={(v) => {
          setScope((v ?? "global") as PrtgPolicyScope)
          setTarget(null)
        }}
        options={POLICY_SCOPES}
        error={fieldErrors.scope}
      />
      {scope !== "global" && (
        <FormCombobox
          label={targetLabel}
          required
          value={target}
          onChange={setTarget}
          options={(options.data?.results ?? []).map((o) => ({
            value: o.id,
            label: o.model || o.name || o.id,
          }))}
          searchPlaceholder="Search…"
          emptyText="Nothing found."
          error={targetError}
        />
      )}
      <div className="flex flex-wrap gap-4">
        <FormCheckbox label="Devices" checked={devices} onChange={setDevices} />
        <FormCheckbox label="VMs" checked={vms} onChange={setVms} />
      </div>
      {fieldErrors.applies_to_devices && (
        <p className="text-xs text-destructive">
          {fieldErrors.applies_to_devices}
        </p>
      )}
      <FormText
        label="Name filter"
        hint="glob, e.g. core-*"
        value={matchName}
        onChange={setMatchName}
        placeholder="core-*"
        error={fieldErrors.match_name}
      />
      <Field
        label="Tags"
        hint="all of them"
        info="Every tag must be on the device or VM. Filters narrow what the scope matched; they never widen it."
        error={fieldErrors.match_tags}
      >
        <TagMultiSelect
          options={tagRows}
          value={pickedIds}
          onChange={onTags}
          placeholder="Add a tag…"
        />
      </Field>
      <FormText
        label="Hardware"
        hint="glob, devices only"
        info="One of the device's inventory items or modules must match by name or part number. A VM has no hardware, so a hardware filter leaves VMs out."
        value={hardware}
        onChange={setHardware}
        placeholder="*PSU*"
        error={fieldErrors.match_hardware}
      />
      <FormSelect
        label="Sensor profile"
        required
        value={profile}
        onChange={setProfile}
        options={(profiles.data?.results ?? []).map((p) => ({
          value: p.id,
          label: p.name,
        }))}
        placeholder="Pick a profile"
        error={fieldErrors.profile}
      />
      <PrtgGroupPicker
        connectionId={connection.id}
        value={groupId}
        path={groupPath}
        required
        onChange={(id, path) => {
          setGroupId(id)
          setGroupPath(path)
        }}
        error={fieldErrors.group_id}
      />
      <FormText
        label="Priority"
        type="number"
        hint="lower first; the first match picks the group"
        value={priority}
        onChange={setPriority}
        error={fieldErrors.priority}
      />
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={policy ? "Save policy" : "Add policy"}
      />
    </form>
  )
}
