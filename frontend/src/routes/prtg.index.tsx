import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  MonitoringEngine,
  PrtgConnection,
  PrtgDefaults,
  PrtgHookToken,
  PrtgTestResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
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
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { PrtgChanges } from "@/components/prtg/changes"
import { PrtgLinks } from "@/components/prtg/links"
import { PrtgStateMapEditor, editableOnly } from "@/components/prtg/state-map"
import {
  Field,
  FormCheckbox,
  FormColumn,
  FormColumns,
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
const LINK_MODES = [
  { value: "auto", label: "Automatically" },
  { value: "review", label: "After review" },
]

// The connection, the decisions waiting on a person, and the pairings the
// reads have made - looked up when a device reads wrong.
const TABS = ["overview", "review", "links"] as const
type PrtgTab = (typeof TABS)[number]

/** The PRTG integration: the connection, its review queue and its links. */
function PrtgPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState<PrtgConnection | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgConnection | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, PrtgTestResult>>({})
  const [tab, setTab] = useUrlTab<PrtgTab>("overview", "tab", TABS)

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

  const readNow = useMutation({
    mutationFn: (id: string) =>
      api<Record<string, number>>(`/api/prtg/connections/${id}/status-now/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success(
        `Read PRTG - ${r.linked ?? 0} linked, ${r.ambiguous ?? 0} to decide.`
      )
      refresh()
      void qc.invalidateQueries({ queryKey: ["prtg-links"] })
      void qc.invalidateQueries({ queryKey: ["prtg-changes"] })
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
        <div className="flex flex-col gap-6">
          <SegmentedTabs
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "overview", label: "Overview" },
              { value: "review", label: "Review queue" },
              { value: "links", label: "Links" },
            ]}
          />
          {tab === "overview" && (
            <>
              <ConnectionCard
                conn={conn}
                result={results[conn.id]}
                canManage={canManage}
                canDelete={canDelete}
                testing={test.isPending}
                reading={readNow.isPending}
                onTest={() => test.mutate(conn.id)}
                onRead={() => readNow.mutate(conn.id)}
                onEdit={() => setEditing(conn)}
                onDelete={() => setDeleting(conn)}
              />
              {conn.push_enabled && canManage && (
                <PushSetup conn={conn} onRotated={refresh} />
              )}
            </>
          )}
          {tab === "review" && <PrtgChanges connection={conn} />}
          {tab === "links" && (
            <PrtgLinks connection={conn} canManage={canManage} />
          )}
        </div>
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
          void qc.invalidateQueries({ queryKey: ["prtg-links"] })
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
  reading,
  onTest,
  onRead,
  onEdit,
  onDelete,
}: {
  conn: PrtgConnection
  result?: PrtgTestResult
  canManage: boolean
  canDelete: boolean
  testing: boolean
  reading: boolean
  onTest: () => void
  onRead: () => void
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
    {
      label: "Links",
      value: conn.link_mode === "review" ? "After review" : "Automatically",
    },
    {
      label: "Engines",
      value: conn.engine_names.length
        ? conn.engine_names.map((e) => e.name).join(", ")
        : dash,
    },
  ]
  const summary = conn.last_status_summary ?? {}
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
      label: "Last read",
      value: conn.last_status_at ? (
        <span className="inline-flex items-center gap-2">
          <TimeCell iso={conn.last_status_at} />
          {typeof summary.linked === "number" && (
            <Badge variant="secondary" className="num">
              {summary.linked} linked
            </Badge>
          )}
        </span>
      ) : (
        <Badge variant="secondary">Never read</Badge>
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
            <Button
              size="sm"
              variant="outline"
              disabled={reading || !conn.api_key_set}
              onClick={onRead}
            >
              {reading ? "Reading…" : "Read now"}
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

/**
 * What to enter in PRTG for push hints: an "Execute HTTP Action"
 * notification template. The token is shown once, when it is made.
 */
function PushSetup({
  conn,
  onRotated,
}: {
  conn: PrtgConnection
  onRotated: () => void
}) {
  const [token, setToken] = useState<PrtgHookToken | null>(null)
  const rotate = useMutation({
    mutationFn: () =>
      api<PrtgHookToken>(
        `/api/prtg/connections/${conn.id}/rotate-hook-token/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      setToken(r)
      onRotated()
    },
    onError: (e) => apiErrorToast(e),
  })
  const url = token ? `${window.location.origin}${token.path}` : ""
  const rows: KvRow[] = [
    { label: "Method", value: <span className="font-mono text-xs">POST</span> },
    {
      label: "URL",
      value: url ? (
        <span className="font-mono text-xs break-all">{url}</span>
      ) : (
        <span className="text-muted-foreground">
          {conn.hook_token_set
            ? "Shown once when made - make a new one to see it."
            : "Make a token first."}
        </span>
      ),
    },
    {
      label: "Payload",
      value: (
        <span className="font-mono text-xs break-all">
          sensorid=%sensorid&amp;deviceid=%deviceid&amp;laststatus=%laststatus
        </span>
      ),
    },
  ]
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">
          Push notification
        </h2>
        {url && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(url)
              toast.success("URL copied")
            }}
          >
            Copy URL
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          {rotate.isPending
            ? "Making…"
            : conn.hook_token_set
              ? "New token"
              : "Make token"}
        </Button>
      </div>
      <div className="p-4">
        <KvCard title="Execute HTTP Action" rows={rows} />
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
      <DialogContent size="4xl" className="max-h-[85vh] overflow-y-auto">
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
  const [engineIds, setEngineIds] = useState<string[]>(
    connection?.engines ?? []
  )
  const [linkMode, setLinkMode] = useState<string | null>(
    connection?.link_mode ?? "auto"
  )
  const [push, setPush] = useState(connection?.push_enabled ?? false)
  const [stateMap, setStateMap] = useState<Record<string, string>>(
    connection?.state_map ?? {}
  )

  // The codes come from the server so PRTG's list is not hard-coded twice.
  const defaults = useQuery({
    queryKey: ["prtg-defaults"],
    queryFn: () => api<PrtgDefaults>("/api/prtg/connections/defaults/"),
    staleTime: 60 * 60_000,
  })
  const engines = useQuery({
    queryKey: ["prtg-engine-picker"],
    queryFn: () => apiAll<MonitoringEngine>("/api/monitoring/engines/"),
    staleTime: 60_000,
  })
  const engineOptions = useMemo(
    () =>
      (engines.data?.results ?? [])
        .filter((e) => e.kind === "prtg")
        .map((e) => ({ id: e.id, name: e.name })),
    [engines.data]
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
            engines: engineIds,
            link_mode: linkMode ?? "auto",
            push_enabled: push,
            state_map: editableOnly(stateMap, defaults.data),
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
      <FormColumns>
        <FormColumn>
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
              hint={
                connection?.api_key_set ? "Set. Blank keeps it." : undefined
              }
              info="An API key from the PRTG user's account settings. Dropped when the URL moves to another host."
              value={apiKey}
              onChange={setApiKey}
              placeholder={connection?.api_key_set ? "••••••" : ""}
              error={fieldErrors.api_key}
            />
            <FormCheckbox
              label="Verify TLS certificate"
              checked={verifyTls}
              onChange={setVerifyTls}
            />
            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSection>
        </FormColumn>
        <FormColumn>
          <FormSection title="Reading" card>
            <FormSelect
              label="Read every"
              value={interval}
              onChange={setIntervalSeconds}
              options={PRTG_INTERVALS}
              error={fieldErrors.status_interval_seconds}
            />
            <FormSelect
              label="Link devices"
              info="How a match between a Danbyte device and a PRTG device becomes a link. After review puts each one in the queue first. A match that is not clear always waits for a decision."
              value={linkMode}
              onChange={setLinkMode}
              options={LINK_MODES}
              error={fieldErrors.link_mode}
            />
            <Field
              label="Engines"
              hint={engineOptions.length ? undefined : "None yet"}
              info="The monitoring engines whose PRTG checks this connection answers. Create one of kind PRTG under Governance → Monitoring engines, then link it here."
              error={fieldErrors.engines}
            >
              <IdMultiSelect
                options={engineOptions}
                value={engineIds}
                onChange={setEngineIds}
                placeholder="Add an engine…"
                searchPlaceholder="Search engines…"
                emptyText="No PRTG engine."
              />
            </Field>
            <FormCheckbox
              label="Accept push notifications"
              info="PRTG's Execute HTTP Action notification asks Danbyte to read one device again at once. Only the ids are used."
              checked={push}
              onChange={setPush}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <PrtgStateMapEditor
        defaults={defaults.data}
        value={stateMap}
        onChange={setStateMap}
        error={fieldErrors.state_map}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add connection"}
      />
    </form>
  )
}
