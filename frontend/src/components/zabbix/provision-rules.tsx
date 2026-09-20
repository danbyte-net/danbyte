import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  ZabbixConnection,
  ZabbixServerTemplates,
  ZabbixProvisionRule,
  ZabbixProvisionScopes,
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
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"

/**
 * What a kind of device carries in Zabbix (#162 phase 3).
 *
 * A host with no template collects nothing, and a host in the wrong groups is
 * invisible to the permissions, dashboards and actions built on them. Both are
 * questions about what the device *is*, which is the one Danbyte exists to
 * answer. Rules stack, so this reads as a short list of statements.
 */
export function ZabbixProvisionRules({
  connection,
  canManage,
}: {
  connection: ZabbixConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ZabbixProvisionRule | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ZabbixProvisionRule | null>(null)

  const rules = useQuery({
    queryKey: ["zabbix-template-rules", connection.id],
    queryFn: () =>
      api<Paginated<ZabbixProvisionRule>>(
        `/api/zabbix/template-rules/?connection=${connection.id}`
      ),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/template-rules/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule deleted")
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ["zabbix-template-rules"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-scope"] })
    },
    onError: apiErrorToast,
  })

  const rows = rules.data?.results ?? []

  const columns = useMemo<ColumnDef<ZabbixProvisionRule>[]>(
    () => [
      {
        id: "target",
        accessorFn: (r) => (r.scope === "tenant" ? "" : r.object_name),
        header: ({ column }) => (
          <SortHeader column={column} label="Applies to" />
        ),
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="inline-flex items-center gap-2">
              <span className="font-medium">
                {r.scope === "tenant" ? "Every device" : r.object_name || "-"}
              </span>
              {r.scope !== "tenant" && (
                <span className="text-xs text-muted-foreground">
                  {r.scope_display}
                </span>
              )}
            </span>
          )
        },
      },
      {
        id: "templates",
        header: "Templates",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.templates.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.templates.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "groups",
        header: "Host groups",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.groups.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.groups.map((g) => (
                <Badge key={g} variant="outline">
                  {g}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">site</span>
          ),
      },
      {
        id: "proxy",
        accessorKey: "proxy",
        header: ({ column }) => <SortHeader column={column} label="Proxy" />,
        cell: ({ row }) =>
          row.original.proxy ? (
            <span className="font-mono text-xs">{row.original.proxy}</span>
          ) : (
            <span className="text-muted-foreground">server</span>
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
            } as ColumnDef<ZabbixProvisionRule>,
          ]
        : []),
    ],
    [canManage]
  )

  return (
    <Section
      title="Provisioning rules"
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
          A host Danbyte creates has no template until a rule names one.
        </EmptyState>
      ) : (
        <DataTable
          tableId="zabbix-provision-rules"
          data={rows}
          total={rules.data?.count}
          columns={columns}
          flexColumn="templates"
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
        description="Hosts already provisioned keep what it gave them; new ones will not get it."
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
  rule: ZabbixProvisionRule | null
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

function RuleForm({
  connection,
  rule,
  onDone,
}: {
  connection: ZabbixConnection
  rule: ZabbixProvisionRule | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [scope, setScope] = useState<string | null>(rule?.scope ?? "tenant")
  const [objectId, setObjectId] = useState<string | null>(
    rule?.object_id ?? null
  )
  const [picked, setPicked] = useState<string[]>(rule?.templates ?? [])
  // The fallback when Zabbix cannot be reached: one name per line, because a
  // comma is a legal character in a template name.
  const [text, setText] = useState((rule?.templates ?? []).join("\n"))
  const [groups, setGroups] = useState((rule?.groups ?? []).join("\n"))
  const [proxy, setProxy] = useState<string | null>(rule?.proxy || null)
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)

  // Which scopes exist, and which catalog backs each, comes from the server -
  // Danbyte's own object model is not something to restate in TypeScript.
  const scopes = useQuery({
    queryKey: ["zabbix-template-scopes"],
    queryFn: () =>
      api<ZabbixProvisionScopes>("/api/zabbix/template-rules/scopes/"),
    staleTime: 60 * 60_000,
  })
  const scopeInfo = scopes.data?.scopes.find((s) => s.value === scope)
  const catalog = scopeInfo?.catalog ?? ""
  const options = useQuery({
    queryKey: ["zabbix-scope-catalog", catalog],
    queryFn: () =>
      api<Paginated<{ id: string; name?: string; model?: string }>>(
        `${catalog}?picker=1&page_size=500`
      ),
    enabled: !!catalog,
    staleTime: 10 * 60_000,
  })

  // The templates and proxies the server actually has. Typing a name is how a
  // rule gets silently refused later - Zabbix is strict, and this is the list
  // it is strict about.
  const server = useQuery({
    queryKey: ["zabbix-server-templates", connection.id],
    queryFn: () =>
      api<ZabbixServerTemplates>(
        `/api/zabbix/connections/${connection.id}/templates/`
      ),
    staleTime: 10 * 60_000,
  })
  const canPick = (server.data?.templates.length ?? 0) > 0
  // A name already on the rule stays visible as a chip even when the server
  // no longer offers it - otherwise editing a rule would quietly drop it.
  const serverOptions = useMemo(
    () =>
      (server.data?.templates ?? []).map((t) => ({
        id: t.value,
        name: t.label,
      })),
    [server.data]
  )
  const templateOptions = useMemo(() => {
    const known = new Set(serverOptions.map((o) => o.id))
    const extra = picked
      .filter((p) => !known.has(p))
      .map((p) => ({ id: p, name: p }))
    // Same array back when there is nothing extra, which is the usual case -
    // rebuilding it on every pick churned the open list under the cursor.
    return extra.length ? [...serverOptions, ...extra] : serverOptions
  }, [serverOptions, picked])

  const save = useMutation({
    mutationFn: () =>
      api<ZabbixProvisionRule>(
        rule
          ? `/api/zabbix/template-rules/${rule.id}/`
          : "/api/zabbix/template-rules/",
        {
          method: rule ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            scope,
            object_id: scope === "tenant" ? null : objectId,
            templates: canPick
              ? picked
              : text
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
            groups: groups
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            proxy: proxy ?? "",
            enabled,
          }),
        }
      ),
    onSuccess: () => {
      toast.success(rule ? "Rule saved" : "Rule added")
      void qc.invalidateQueries({ queryKey: ["zabbix-template-rules"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-scope"] })
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
        save.mutate()
      }}
      className="grid gap-4"
    >
      <FormSelect
        label="Applies to"
        value={scope}
        onChange={(v) => {
          setScope(v)
          setObjectId(null)
        }}
        options={(scopes.data?.scopes ?? []).map((s) => ({
          value: s.value,
          label: s.label,
        }))}
        error={fieldErrors.scope}
      />
      {scope !== "tenant" && (
        <FormCombobox
          label={scopeInfo?.label ?? "Target"}
          required
          value={objectId}
          onChange={setObjectId}
          options={(options.data?.results ?? []).map((o) => ({
            value: o.id,
            label: o.name || o.model || o.id,
          }))}
          error={fieldErrors.object_id}
        />
      )}
      {canPick ? (
        <Field
          label="Templates"
          info="The templates a matching host is linked to. Rules stack: a host gets the union of every rule that matches it."
          error={fieldErrors.templates}
        >
          <IdMultiSelect
            options={templateOptions}
            value={picked}
            onChange={setPicked}
            placeholder="Add a template…"
            searchPlaceholder="Search templates…"
            emptyText="No template by that name."
            footer={`${server.data?.templates.length ?? 0} on the server`}
          />
        </Field>
      ) : (
        <FormTextarea
          label="Templates"
          hint={
            server.data?.error
              ? "Zabbix unreachable - one name per line"
              : "One name per line, as Zabbix spells it"
          }
          value={text}
          onChange={setText}
          error={fieldErrors.templates}
        />
      )}
      <FormTextarea
        label="Host groups"
        hint="One per line. Empty uses the site."
        value={groups}
        onChange={setGroups}
        error={fieldErrors.groups}
      />
      <FormSelect
        label="Proxy"
        info="Which proxy the host is monitored through. A host has one, so the most specific rule naming a proxy wins - a site first. Danbyte sets it only on hosts still polled by the server."
        value={proxy}
        onChange={setProxy}
        options={(server.data?.proxies ?? []).map((p) => ({
          value: p.value,
          label: p.label,
        }))}
        noneLabel="Zabbix server"
      />
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={rule ? "Save changes" : "Add rule"}
      />
    </form>
  )
}
