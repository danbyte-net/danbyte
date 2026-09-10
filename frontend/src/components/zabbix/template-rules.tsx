import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  ZabbixConnection,
  ZabbixTemplateRule,
  ZabbixTemplateScopes,
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
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

/**
 * Which Zabbix templates a kind of device should carry (#162 phase 3).
 *
 * A host with no template collects nothing, and what template a device wants
 * is a question about what the device is - which is the question Danbyte
 * exists to answer. Rules stack, so this reads as a short list of statements.
 */
export function ZabbixTemplateRules({
  connection,
  canManage,
}: {
  connection: ZabbixConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ZabbixTemplateRule | null>(null)
  const [adding, setAdding] = useState(false)

  const rules = useQuery({
    queryKey: ["zabbix-template-rules", connection.id],
    queryFn: () =>
      api<Paginated<ZabbixTemplateRule>>(
        `/api/zabbix/template-rules/?connection=${connection.id}`
      ),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/template-rules/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule removed")
      qc.invalidateQueries({ queryKey: ["zabbix-template-rules"] })
    },
    onError: apiErrorToast,
  })

  const rows = rules.data?.results ?? []

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          Templates{" "}
          <span className="num text-xs font-normal text-muted-foreground">
            {rows.length}
          </span>
        </h2>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
        )}
      </div>

      {rules.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">
          No rules. A host Danbyte creates gets no template, so Zabbix shows it
          and collects nothing.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {r.scope === "tenant"
                    ? "Every device"
                    : r.object_name || r.scope_display}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {r.scope === "tenant" ? "" : r.scope_display}
                </span>
              </span>
              <span className="flex flex-wrap gap-1">
                {r.templates.map((t) => (
                  <span
                    key={t}
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                  >
                    {t}
                  </span>
                ))}
              </span>
              {!r.enabled && <Badge variant="warning">Off</Badge>}
              {canManage && (
                <span className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Edit"
                    onClick={() => setEditing(r)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Delete"
                    onClick={() => remove.mutate(r.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
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
    </section>
  )
}

function RuleDialog({
  connection,
  rule,
  open,
  onOpenChange,
}: {
  connection: ZabbixConnection
  rule: ZabbixTemplateRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "Add template rule"}</DialogTitle>
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
  rule: ZabbixTemplateRule | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [scope, setScope] = useState<string | null>(rule?.scope ?? "tenant")
  const [objectId, setObjectId] = useState<string | null>(
    rule?.object_id ?? null
  )
  // One template per line: an operator pastes a list out of Zabbix, and a
  // comma is a legal character in a template name.
  const [text, setText] = useState((rule?.templates ?? []).join("\n"))
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)

  // Which scopes exist, and which catalog backs each, comes from the server -
  // Danbyte's own object model is not something to restate in TypeScript.
  const scopes = useQuery({
    queryKey: ["zabbix-template-scopes"],
    queryFn: () =>
      api<ZabbixTemplateScopes>("/api/zabbix/template-rules/scopes/"),
    staleTime: 60 * 60_000,
  })
  const catalog = useMemo(
    () => scopes.data?.scopes.find((s) => s.value === scope)?.catalog ?? "",
    [scopes.data, scope]
  )
  const options = useQuery({
    queryKey: ["zabbix-scope-catalog", catalog],
    queryFn: () =>
      api<Paginated<{ id: string; name?: string; model?: string }>>(
        `${catalog}?picker=1&page_size=500`
      ),
    enabled: !!catalog,
    staleTime: 10 * 60_000,
  })

  const save = useMutation({
    mutationFn: () =>
      api<ZabbixTemplateRule>(
        rule
          ? `/api/zabbix/template-rules/${rule.id}/`
          : "/api/zabbix/template-rules/",
        {
          method: rule ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            scope,
            object_id: scope === "tenant" ? null : objectId,
            templates: text
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            enabled,
          }),
        }
      ),
    onSuccess: () => {
      toast.success(rule ? "Rule saved" : "Rule added")
      qc.invalidateQueries({ queryKey: ["zabbix-template-rules"] })
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
          label="Which"
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
      <FormTextarea
        label="Templates"
        required
        hint="One name per line, exactly as Zabbix spells it"
        value={text}
        onChange={setText}
        error={fieldErrors.templates}
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
