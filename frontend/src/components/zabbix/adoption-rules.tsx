import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, ZabbixAdoptionRule, ZabbixConnection } from "@/lib/api"
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
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { DeviceTypePicker } from "@/components/device-type-picker"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"

/**
 * Where an adopted Zabbix host lands, by what it looks like.
 *
 * The connection's defaults put every adopted host at one site; an estate
 * with a Zabbix per region and a host per town needs more. A rule matches the
 * host's name, one of its groups or its address and names the site - and
 * optionally the role and type - the device is made with. First match wins
 * in weight order, and a rule sets only what it names. The same matcher the
 * VM placement rules use.
 */
export function ZabbixAdoptionRules({
  connection,
  canManage,
}: {
  connection: ZabbixConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ZabbixAdoptionRule | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ZabbixAdoptionRule | null>(null)

  const rules = useQuery({
    queryKey: ["zabbix-adoption-rules", connection.id],
    queryFn: () =>
      api<Paginated<ZabbixAdoptionRule>>(
        `/api/zabbix/adoption-rules/?connection=${connection.id}`
      ),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/adoption-rules/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule deleted")
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ["zabbix-adoption-rules"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
    },
    onError: apiErrorToast,
  })

  const rows = rules.data?.results ?? []

  const columns = useMemo<ColumnDef<ZabbixAdoptionRule>[]>(
    () => [
      {
        id: "weight",
        accessorKey: "weight",
        header: ({ column }) => <SortHeader column={column} label="Order" />,
        cell: ({ row }) => (
          <span className="num text-xs text-muted-foreground">
            {row.original.weight}
          </span>
        ),
      },
      {
        id: "match",
        accessorKey: "pattern",
        header: ({ column }) => <SortHeader column={column} label="Matches" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-xs">{row.original.pattern}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.scope_display.toLowerCase()}
            </span>
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Matches",
            get: (r: ZabbixAdoptionRule) => r.scope_display,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
      {
        id: "site",
        accessorKey: "site_name",
        header: ({ column }) => <SortHeader column={column} label="Site" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.site_name}</span>
        ),
      },
      {
        id: "role",
        accessorKey: "role_name",
        header: ({ column }) => <SortHeader column={column} label="Role" />,
        cell: ({ row }) =>
          row.original.role_name || (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "type",
        accessorKey: "device_type_name",
        header: ({ column }) => (
          <SortHeader column={column} label="Device type" />
        ),
        cell: ({ row }) =>
          row.original.device_type_name || (
            <span className="text-muted-foreground">-</span>
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
            } as ColumnDef<ZabbixAdoptionRule>,
          ]
        : []),
    ],
    [canManage]
  )

  return (
    <Section
      title="Adoption rules"
      count={rows.length}
      actions={
        canManage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
        )
      }
    >
      {rules.isLoading ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No rules">
          Adopted hosts land at the connection&apos;s default site. A rule sends{" "}
          <span className="font-mono">kbh-*</span> somewhere else.
        </EmptyState>
      ) : (
        <DataTable
          tableId="zabbix-adoption-rules"
          data={rows}
          total={rules.data?.count}
          columns={columns}
          flexColumn="match"
        />
      )}

      <RuleDialog
        connection={connection}
        rule={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this rule?"
        description="Devices already adopted stay where they are; new proposals fall through to the next rule or the defaults."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Section>
  )
}

function RuleDialog({
  connection,
  rule,
  open,
  onOpenChange,
}: {
  connection: ZabbixConnection
  rule: ZabbixAdoptionRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "Add rule"}</DialogTitle>
        </DialogHeader>
        {open && (
          <RuleForm
            connection={connection}
            rule={rule}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const SCOPES = [
  { value: "name", label: "Host name" },
  { value: "group", label: "Host group" },
  { value: "ip", label: "Address" },
]

const PLACEHOLDER: Record<string, string> = {
  name: "kbh-*",
  group: "Linux servers*",
  ip: "10.7.0.0/24",
}

function RuleForm({
  connection,
  rule,
  onDone,
}: {
  connection: ZabbixConnection
  rule: ZabbixAdoptionRule | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [scope, setScope] = useState<string | null>(rule?.scope ?? "name")
  const [pattern, setPattern] = useState(rule?.pattern ?? "")
  const [site, setSite] = useState<string | null>(rule?.site ?? null)
  const [role, setRole] = useState<string | null>(rule?.role ?? null)
  const [type, setType] = useState<string | null>(rule?.device_type ?? null)
  const [weight, setWeight] = useState(String(rule?.weight ?? 100))
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)

  const sites = useQuery({
    queryKey: ["zabbix-adopt-sites"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?page_size=500"),
    staleTime: 60_000,
  })
  const roles = useQuery({
    queryKey: ["zabbix-adopt-roles"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?page_size=500"
      ),
    staleTime: 60_000,
  })
  const asOptions = (rows?: { id: string; name: string }[]) =>
    (rows ?? []).map((r) => ({ value: r.id, label: r.name }))

  const save = useMutation({
    mutationFn: () =>
      api<ZabbixAdoptionRule>(
        rule
          ? `/api/zabbix/adoption-rules/${rule.id}/`
          : "/api/zabbix/adoption-rules/",
        {
          method: rule ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            scope,
            pattern: pattern.trim(),
            site,
            role,
            device_type: type,
            weight: Number(weight) || 100,
            enabled,
          }),
        }
      ),
    onSuccess: () => {
      toast.success(rule ? "Rule saved" : "Rule added")
      void qc.invalidateQueries({ queryKey: ["zabbix-adoption-rules"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
      onDone()
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
        if (pattern.trim() && site) save.mutate()
      }}
      className="grid gap-4"
    >
      <FormSelect
        label="Matches"
        value={scope}
        onChange={setScope}
        options={SCOPES}
        error={fieldErrors.scope}
      />
      <FormText
        label="Pattern"
        hint="glob; regex: for a regular expression"
        info="A glob such as kbh-* or *-core?. Prefix with regex: for a regular expression. An address rule may be a CIDR, which reaches inside an octet where a glob cannot."
        value={pattern}
        onChange={setPattern}
        placeholder={PLACEHOLDER[scope ?? "name"]}
        error={fieldErrors.pattern}
        required
      />
      <FormSelect
        label="Site"
        value={site}
        onChange={setSite}
        options={asOptions(sites.data?.results)}
        error={fieldErrors.site}
      />
      <FormSelect
        label="Role"
        hint="blank keeps the default"
        value={role}
        onChange={setRole}
        options={asOptions(roles.data?.results)}
        noneLabel="Default"
        error={fieldErrors.role}
      />
      <DeviceTypePicker
        value={type}
        onChange={setType}
        hint="blank keeps the inventory model or the default"
      />
      <FormText
        label="Order"
        type="number"
        hint="lower runs first"
        value={weight}
        onChange={setWeight}
        error={fieldErrors.weight}
      />
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={rule ? "Save rule" : "Add rule"}
      />
    </form>
  )
}
