import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { QueryError } from "@/components/query-error"
import { DevicePicker } from "@/components/device-picker"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
} from "@/components/forms"

// Port-utilization alert rules: warn when a device's port fill crosses a
// line, or when a scoped device has no ports at all. Fired by the same
// utilization sweep as prefix alerts, through the tenant's channels.

interface PortRule {
  id: string
  name: string
  enabled: boolean
  condition: "above" | "below" | "no_ports"
  threshold_pct: number | null
  device: { id: string; name: string } | null
  device_type: { id: string; name: string } | null
  role: { id: string; name: string; color: string } | null
}

const CONDITION_LABEL: Record<PortRule["condition"], string> = {
  above: "Used ≥",
  below: "Used ≤",
  no_ports: "No ports at all",
}

function scopeSummary(r: PortRule): string {
  const parts = [
    r.device && `device ${r.device.name}`,
    r.device_type && `type ${r.device_type.name}`,
    r.role && `role ${r.role.name}`,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "every device"
}

export function PortRulesList() {
  const { canDo } = useMe()
  const canAdd = canDo("portutilizationrule", "add")
  const canEdit = canDo("portutilizationrule", "change")
  const canDelete = canDo("portutilizationrule", "delete")
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["port-utilization-rules"],
    queryFn: () =>
      api<Paginated<PortRule>>("/api/monitoring/port-utilization-rules/"),
  })
  const [editing, setEditing] = useState<PortRule | null | "new">(null)
  const rows = q.data?.results ?? []

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/port-utilization-rules/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["port-utilization-rules"] })
      toast.success("Rule deleted")
    },
    onError: apiErrorToast,
  })

  const columns: ColumnDef<PortRule>[] = [
    {
      id: "rule",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <>
          <button
            type="button"
            onClick={() => canEdit && setEditing(row.original)}
            className="link font-medium"
          >
            {row.original.name}
          </button>
          {!row.original.enabled && (
            <Badge variant="outline" className="ml-2 h-4 px-1.5 text-[10px]">
              off
            </Badge>
          )}
        </>
      ),
    },
    {
      id: "condition",
      enableSorting: false,
      header: "Condition",
      cell: ({ row }) => (
        <span className="text-[12px]">
          {CONDITION_LABEL[row.original.condition]}
          {row.original.condition !== "no_ports" && (
            <span className="num"> {row.original.threshold_pct}%</span>
          )}
        </span>
      ),
    },
    {
      id: "scope",
      enableSorting: false,
      header: "Scope",
      cell: ({ row }) => (
        <span className="text-[12px] text-muted-foreground">
          {scopeSummary(row.original)}
        </span>
      ),
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: "",
      cell: ({ row }) => (
        <RowActions
          onEdit={canEdit ? () => setEditing(row.original) : undefined}
          onDelete={canDelete ? () => del.mutate(row.original.id) : undefined}
        />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div>
          <h3 className="text-sm font-semibold">Port utilization rules</h3>
          <p className="text-sm text-muted-foreground">
            Warn when a device's port fill crosses a line - or when a device has
            no ports at all. Scope by device, type, or role.
          </p>
        </div>
        {canAdd && (
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setEditing("new")}
          >
            <Plus className="h-3.5 w-3.5" /> New rule
          </Button>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
          No port rules yet.
        </div>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="rule"
          tableId="port-utilization-rules"
        />
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "New port rule" : "Edit port rule"}
            </DialogTitle>
          </DialogHeader>
          {editing !== null && (
            <PortRuleForm
              rule={editing === "new" ? undefined : editing}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PortRuleForm({
  rule,
  onDone,
}: {
  rule?: PortRule
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(rule?.name ?? "")
  const [condition, setCondition] = useState<PortRule["condition"]>(
    rule?.condition ?? "above"
  )
  const [threshold, setThreshold] = useState(
    rule?.threshold_pct != null ? String(rule.threshold_pct) : "90"
  )
  const [deviceId, setDeviceId] = useState<string | null>(
    rule?.device?.id ?? null
  )
  const [typeId, setTypeId] = useState<string | null>(
    rule?.device_type?.id ?? null
  )
  const [roleId, setRoleId] = useState<string | null>(rule?.role?.id ?? null)
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)

  const types = useQuery({
    queryKey: ["device-types-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-types/?picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?picker=1"
      ),
    staleTime: 5 * 60_000,
  })

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        condition,
        threshold_pct:
          condition === "no_ports" ? null : Number(threshold || "0"),
        device_id: deviceId,
        device_type_id: typeId,
        role_id: roleId,
        enabled,
      }
      return rule
        ? api(`/api/monitoring/port-utilization-rules/${rule.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/monitoring/port-utilization-rules/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["port-utilization-rules"] })
      toast.success(rule ? "Rule updated" : "Rule created")
      onDone()
    },
    // Wrapped: apiErrorToast's optional 2nd param would otherwise be
    // inferred as the mutation's variables type.
    onError: (e) => apiErrorToast(e),
  })

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
        autoFocus={!rule}
        value={name}
        onChange={setName}
        placeholder="Panels near capacity"
      />
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Condition"
          value={condition}
          onChange={(v) => setCondition(v as PortRule["condition"])}
          options={[
            { value: "above", label: "Used at or above…" },
            { value: "below", label: "Used at or below…" },
            { value: "no_ports", label: "No ports at all" },
          ]}
        />
        {condition !== "no_ports" && (
          <Field label="Threshold (%)">
            <Input
              type="number"
              min={0}
              max={100}
              required
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="num"
            />
          </Field>
        )}
      </div>
      <DevicePicker
        label="Device"
        hint="optional"
        value={deviceId}
        onChange={setDeviceId}
        noneLabel="Any device"
      />
      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Device type"
          hint="optional"
          value={typeId}
          onChange={setTypeId}
          options={(types.data?.results ?? []).map((t) => ({
            value: t.id,
            label: t.name,
          }))}
          noneLabel="Any type"
          placeholder="Any type"
        />
        <FormCombobox
          label="Role"
          hint="optional"
          value={roleId}
          onChange={setRoleId}
          options={(roles.data?.results ?? []).map((r) => ({
            value: r.id,
            label: r.name,
          }))}
          noneLabel="Any role"
          placeholder="Any role"
        />
      </div>
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={rule ? "Save changes" : "Create rule"}
      />
    </form>
  )
}
