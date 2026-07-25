import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Check, Copy, KeyRound } from "lucide-react"

import {
  api,
  type ApiToken,
  type ApiTokenCreated,
  type Paginated,
  type TenantPicker,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { Field, FormSelect } from "@/components/forms"
import { RowActions } from "@/components/row-actions"
import { timeAgo } from "@/components/cells/time-ago"
import { SettingsCard } from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

export function ApiTokensSection() {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [created, setCreated] = useState<ApiTokenCreated | null>(null)
  const [copied, setCopied] = useState(false)

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api<Paginated<ApiToken>>("/api/api-tokens/"),
  })
  const tenants = useQuery({
    queryKey: ["tenants", "picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const create = useMutation({
    mutationFn: () =>
      api<ApiTokenCreated>("/api/api-tokens/", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), tenant_id: tenantId }),
      }),
    onSuccess: (t) => {
      setCreated(t)
      setName("")
      setCopied(false)
      qc.invalidateQueries({ queryKey: ["api-tokens"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/api-tokens/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] })
      toast.success("Token revoked")
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = tokens.data?.results ?? []

  const columns: SimpleColumn<ApiToken>[] = [
    {
      id: "name",
      header: "Name",
      flex: true,
      cell: (t) => (
        <span className="flex items-center gap-1.5 font-medium">
          <KeyRound className="size-3.5 text-muted-foreground" />
          {t.name}
          {t.is_expired && (
            <Badge variant="secondary" className="text-[10px]">
              expired
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: "tenant",
      header: "Tenant",
      cell: (t) => <span className="text-xs">{t.tenant.name}</span>,
    },
    {
      id: "prefix",
      header: "Prefix",
      cell: (t) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {t.prefix}…
        </span>
      ),
    },
    {
      id: "last_used",
      header: "Last used",
      cell: (t) => (
        <span className="text-xs text-muted-foreground">
          {t.last_used_at ? timeAgo(t.last_used_at) : "never"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (t) => (
        <RowActions
          deleteLabel="Revoke"
          // Guard in the handler rather than disabling the button: one
          // in-flight revoke shouldn't make the row's action jump.
          onDelete={() => !revoke.isPending && revoke.mutate(t.id)}
        />
      ),
    },
  ]

  return (
    <SettingsCard
      title="API tokens"
      description={
        <>
          Long-lived keys for non-interactive callers (Ansible / AWX, scripts).
          A token acts as you, scoped to one tenant, and is shown only once. Use
          the header{" "}
          <span className="font-mono">Authorization: Token &lt;key&gt;</span>.
        </>
      }
    >
      {created && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
          <p className="text-xs font-medium text-emerald-800 dark:text-emerald-200">
            Copy your new token now — it won't be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">
              {created.key}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(created.key)
                setCopied(true)
              }}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <SimpleTable
        columns={columns}
        data={rows}
        getRowKey={(t) => t.id}
        empty="No tokens yet."
      />

      <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Name">
          <Input
            placeholder="awx-runner"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <FormSelect
          label="Tenant"
          value={tenantId}
          onChange={setTenantId}
          options={(tenants.data?.results ?? []).map((t) => ({
            value: t.id,
            label: t.name,
          }))}
          placeholder="Pick a tenant"
        />
        <Button
          onClick={() => create.mutate()}
          disabled={!name.trim() || !tenantId || create.isPending}
        >
          Create token
        </Button>
      </div>
    </SettingsCard>
  )
}
