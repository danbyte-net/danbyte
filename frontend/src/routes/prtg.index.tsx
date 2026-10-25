import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PrtgConnection, PrtgTestResult } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { VENDORS } from "@/lib/vendors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

export const Route = createFileRoute("/prtg/")({ component: PrtgPage })

const PRTG_INTERVALS = [
  { value: "60", label: "1 minute" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
]
const INTERVAL_LABEL = Object.fromEntries(
  PRTG_INTERVALS.map((o) => [o.value, o.label])
)

/** The PRTG connection: how to reach the server, and a test of it. */
function PrtgPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState<PrtgConnection | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgConnection | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, PrtgTestResult>>({})

  const connections = useQuery({
    queryKey: ["prtg-connections"],
    queryFn: () => apiAll<PrtgConnection>("/api/prtg/connections/"),
  })
  const all = connections.data?.results ?? []
  const conn = all.find((c) => c.id === selectedId) ?? all.at(0)
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ["prtg-connections"] })

  const test = useMutation({
    mutationFn: (id: string) =>
      api<PrtgTestResult>(`/api/prtg/connections/${id}/test/`, {
        method: "POST",
      }).then((r) => ({ id, r })),
    onSuccess: ({ id, r }) => {
      setResults((prev) => ({ ...prev, [id]: r }))
      toast.success(r.detail)
      refresh()
    },
    onError: (e) => {
      apiErrorToast(e)
      refresh()
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/connections/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Connection removed")
      setDeleting(null)
      setSelectedId(null)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const canManage = canDo("prtgconnection", "change")
  const canAdd = canDo("prtgconnection", "add")
  const canDelete = canDo("prtgconnection", "delete")

  return (
    <ListPageShell
      title="PRTG"
      count={connections.data ? all.length : undefined}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add connection
          </Button>
        )
      }
      query={connections}
    >
      {connections.data && !conn && (
        <EmptyState title="No PRTG connection">
          Point Danbyte at a PRTG core server.
        </EmptyState>
      )}

      {all.length > 1 && conn && (
        <SegmentedTabs
          value={conn.id}
          onValueChange={setSelectedId}
          items={all.map((c) => ({ value: c.id, label: c.name }))}
          className="mb-4"
        />
      )}

      {conn && (
        <ConnectionCard
          conn={conn}
          result={results[conn.id]}
          canManage={canManage}
          canDelete={canDelete}
          testing={test.isPending}
          onTest={() => test.mutate(conn.id)}
          onEdit={() => setEditing(conn)}
          onDelete={() => setDeleting(conn)}
        />
      )}

      <p className="mt-6 text-[11px] text-muted-foreground">
        {VENDORS.prtg?.notice}
      </p>

      <ConnectionDialog
        connection={editing}
        open={adding || editing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          setAdding(false)
          setEditing(null)
          refresh()
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? "this connection"}?`}
        description="Nothing in PRTG is touched."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </ListPageShell>
  )
}

function ConnectionCard({
  conn,
  result,
  canManage,
  canDelete,
  testing,
  onTest,
  onEdit,
  onDelete,
}: {
  conn: PrtgConnection
  result?: PrtgTestResult
  canManage: boolean
  canDelete: boolean
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const connection: KvRow[] = [
    {
      label: "URL",
      value: <span className="font-mono text-xs break-all">{conn.url}</span>,
    },
    {
      label: "API key",
      value: conn.api_key_set ? (
        <Badge variant="success">Set</Badge>
      ) : (
        <Badge variant="warning">Not set</Badge>
      ),
    },
    { label: "Verify TLS", value: conn.verify_tls ? "Yes" : "No" },
    {
      label: "Read every",
      value:
        INTERVAL_LABEL[String(conn.status_interval_seconds)] ??
        `${conn.status_interval_seconds} s`,
    },
  ]
  const server: KvRow[] = [
    {
      label: "Version",
      value: conn.version ? (
        <span className="inline-flex items-center gap-2">
          <span className="num">{conn.version}</span>
          {!conn.supported && <Badge variant="warning">Unsupported</Badge>}
        </span>
      ) : (
        dash
      ),
    },
    ...(result?.probes != null
      ? [
          {
            label: "Probes",
            value: <span className="num">{result.probes}</span>,
          },
        ]
      : []),
    ...(result?.sensors != null
      ? [
          {
            label: "Sensors",
            value: <span className="num">{result.sensors}</span>,
          },
        ]
      : []),
    {
      label: "API v2",
      value:
        conn.v2_available == null ? (
          dash
        ) : conn.v2_available ? (
          <Badge variant="success">Available</Badge>
        ) : (
          <Badge variant="secondary">Not available</Badge>
        ),
    },
    {
      label: "Last tested",
      value: conn.last_checked_at ? (
        <TimeCell iso={conn.last_checked_at} />
      ) : (
        <Badge variant="secondary">Never tested</Badge>
      ),
    },
    ...(conn.last_error
      ? [
          {
            label: "Last error",
            value: <Badge variant="destructive">{conn.last_error}</Badge>,
          },
        ]
      : []),
  ]
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          {conn.name}
          {!conn.enabled && <Badge variant="secondary">Disabled</Badge>}
        </h2>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={onTest}
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
            {canDelete && (
              <Button size="sm" variant="ghost" onClick={onDelete}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <KvCard title="Connection" rows={connection} />
        <KvCard title="Server" rows={server} />
      </div>
    </section>
  )
}

function ConnectionDialog({
  connection,
  open,
  onOpenChange,
  onSaved,
}: {
  connection: PrtgConnection | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connection ? `Edit ${connection.name}` : "Add PRTG connection"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <PrtgConnectionForm
            connection={connection}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PrtgConnectionForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection: PrtgConnection | null
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!connection
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [name, setName] = useState(connection?.name ?? "")
  const [url, setUrl] = useState(connection?.url ?? "")
  const [apiKey, setApiKey] = useState("")
  const [verifyTls, setVerifyTls] = useState(connection?.verify_tls ?? true)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [interval, setIntervalSeconds] = useState<string | null>(
    String(connection?.status_interval_seconds ?? 120)
  )

  // A plain request rather than the planning-aware save: a staged change
  // would keep the API key in the plan.
  const mutation = useMutation({
    mutationFn: () =>
      api<PrtgConnection>(
        isEdit
          ? `/api/prtg/connections/${connection.id}/`
          : "/api/prtg/connections/",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            // Blank keeps what is stored.
            ...(apiKey ? { api_key: apiKey } : {}),
            verify_tls: verifyTls,
            enabled,
            status_interval_seconds: Number(interval ?? 120),
          }),
        }
      ),
    onSuccess: (saved) => {
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
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
      <FormSection title="Connection" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="prtg"
          error={fieldErrors.name}
        />
        <FormText
          label="URL"
          required
          mono
          value={url}
          onChange={setUrl}
          placeholder="https://prtg.example.com"
          info="The PRTG web interface. An internal address needs a deployment admin to allow it under Settings → Security → Outbound connections."
          error={fieldErrors.url ?? fieldErrors.api_v2_url}
        />
        <FormText
          label="API key"
          type="password"
          hint={connection?.api_key_set ? "Set. Blank keeps it." : undefined}
          info="An API key from the PRTG user's account settings. Dropped when the URL moves to another host."
          value={apiKey}
          onChange={setApiKey}
          placeholder={connection?.api_key_set ? "••••••" : ""}
          error={fieldErrors.api_key}
        />
        <FormSelect
          label="Read every"
          value={interval}
          onChange={setIntervalSeconds}
          options={PRTG_INTERVALS}
          error={fieldErrors.status_interval_seconds}
        />
        <FormCheckbox
          label="Verify TLS certificate"
          checked={verifyTls}
          onChange={setVerifyTls}
        />
        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add connection"}
      />
    </form>
  )
}
