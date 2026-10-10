import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus, RefreshCw } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  OxidizedConnection,
  OxidizedNodeLink,
  OxidizedUnmatchedNode,
  Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Section } from "@/components/ui/section"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { DevicePicker } from "@/components/device-picker"
import {
  FormCheckbox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

export const Route = createFileRoute("/oxidized/")({ component: OxidizedPage })

const MATCH_OPTIONS = [
  { value: "address_name", label: "Address, then name" },
  { value: "address", label: "Address only" },
  { value: "name", label: "Name only" },
]
const MATCH_LABEL = Object.fromEntries(
  MATCH_OPTIONS.map((o) => [o.value, o.label])
)

/** The Oxidized connection and its node mapping (#35). */
function OxidizedPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState<OxidizedConnection | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<OxidizedConnection | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const connections = useQuery({
    queryKey: ["oxidized-connections"],
    queryFn: () =>
      api<Paginated<OxidizedConnection>>("/api/oxidized/connections/"),
  })
  const all = connections.data?.results ?? []
  const conn = all.find((c) => c.id === selectedId) ?? all.at(0)

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["oxidized-connections"] })
    void qc.invalidateQueries({ queryKey: ["oxidized-links"] })
    void qc.invalidateQueries({ queryKey: ["oxidized-unmatched"] })
  }

  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; detail: string }>(
        `/api/oxidized/connections/${id}/test/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail)
      else toast.error(r.detail)
      refreshAll()
    },
    onError: (e) => {
      apiErrorToast(e)
      refreshAll()
    },
  })

  const sync = useMutation({
    mutationFn: (id: string) =>
      api<{ linked: number; unmatched_count: number }>(
        `/api/oxidized/connections/${id}/sync/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(`${r.linked} linked, ${r.unmatched_count} unmatched.`)
      refreshAll()
    },
    onError: (e) => {
      apiErrorToast(e)
      refreshAll()
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/oxidized/connections/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Connection removed")
      setDeleting(null)
      setSelectedId(null)
      refreshAll()
    },
    onError: (e) => apiErrorToast(e),
  })

  const canManage = canDo("oxidizedconnection", "change")
  const canAdd = canDo("oxidizedconnection", "add")
  const canDelete = canDo("oxidizedconnection", "delete")
  const canPin = canDo("oxidizednodelink", "add")
  const canUnlink = canDo("oxidizednodelink", "delete")

  return (
    <ListPageShell
      title="Oxidized"
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
        <EmptyState title="No Oxidized connection">
          Point Danbyte at oxidized-web.
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
          <ConnectionCard
            conn={conn}
            canManage={canManage}
            canDelete={canDelete}
            testing={test.isPending}
            syncing={sync.isPending}
            onTest={() => test.mutate(conn.id)}
            onSync={() => sync.mutate(conn.id)}
            onEdit={() => setEditing(conn)}
            onDelete={() => setDeleting(conn)}
          />
          <UnmatchedNodes connection={conn} canPin={canPin} />
          <LinkedNodes connection={conn} canUnlink={canUnlink} />
        </div>
      )}

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
          refreshAll()
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? "this connection"}?`}
        description="Its node links go with it. Nothing in Oxidized is touched."
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
  canManage,
  canDelete,
  testing,
  syncing,
  onTest,
  onSync,
  onEdit,
  onDelete,
}: {
  conn: OxidizedConnection
  canManage: boolean
  canDelete: boolean
  testing: boolean
  syncing: boolean
  onTest: () => void
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const connection: KvRow[] = [
    {
      label: "URL",
      value: <span className="font-mono text-xs break-all">{conn.url}</span>,
    },
    {
      label: "Basic auth",
      value: conn.username ? (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{conn.username}</span>
          {conn.password_set ? (
            <Badge variant="success">Password set</Badge>
          ) : (
            <Badge variant="warning">No password</Badge>
          )}
        </span>
      ) : (
        "Off"
      ),
    },
    { label: "Verify TLS", value: conn.verify_tls ? "Yes" : "No" },
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
  const mapping: KvRow[] = [
    { label: "Matching", value: MATCH_LABEL[conn.match_by] ?? conn.match_by },
    {
      label: "Nodes",
      value:
        conn.node_count == null ? (
          dash
        ) : (
          <span className="num">{conn.node_count}</span>
        ),
    },
    { label: "Linked", value: <span className="num">{conn.link_count}</span> },
    {
      label: "Unmatched",
      value: conn.sync.unmatched_count ? (
        <Badge variant="warning">{conn.sync.unmatched_count}</Badge>
      ) : (
        dash
      ),
    },
    {
      label: "Last sync",
      value: conn.last_sync_at ? <TimeCell iso={conn.last_sync_at} /> : dash,
    },
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
              {testing ? "Testing…" : "Test"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={onSync}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {syncing ? "Syncing…" : "Sync nodes"}
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
        <KvCard title="Mapping" rows={mapping} />
      </div>
    </section>
  )
}

/** Nodes the last sync paired with nothing, with the reason and a way to pin
 * one to a device by hand. */
function UnmatchedNodes({
  connection,
  canPin,
}: {
  connection: OxidizedConnection
  canPin: boolean
}) {
  const qc = useQueryClient()
  const [pinning, setPinning] = useState<OxidizedUnmatchedNode | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ["oxidized-unmatched", connection.id],
    queryFn: () =>
      api<{ results: OxidizedUnmatchedNode[]; count: number }>(
        `/api/oxidized/connections/${connection.id}/unmatched/`
      ),
  })

  const pin = useMutation({
    mutationFn: () =>
      api<OxidizedNodeLink>("/api/oxidized/links/", {
        method: "POST",
        body: JSON.stringify({
          connection_id: connection.id,
          device_id: deviceId,
          full_name: pinning?.full_name,
        }),
      }),
    onSuccess: (r) => {
      toast.success(`Pinned ${r.full_name} to ${r.device.name}`)
      setPinning(null)
      setDeviceId(null)
      void qc.invalidateQueries({ queryKey: ["oxidized-links"] })
      void qc.invalidateQueries({ queryKey: ["oxidized-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<OxidizedUnmatchedNode>[]>(
    () => [
      {
        id: "node",
        accessorKey: "full_name",
        header: ({ column }) => <SortHeader column={column} label="Node" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.full_name}</span>
        ),
      },
      {
        id: "ip",
        accessorKey: "ip",
        header: ({ column }) => <SortHeader column={column} label="Address" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.ip || "-"}</span>
        ),
      },
      {
        id: "model",
        accessorKey: "model",
        header: ({ column }) => <SortHeader column={column} label="Model" />,
      },
      {
        id: "reason",
        accessorKey: "reason",
        header: ({ column }) => <SortHeader column={column} label="Reason" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.reason}</span>
        ),
      },
      ...(canPin
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPinning(row.original)}
                >
                  Pin to device
                </Button>
              ),
            } as ColumnDef<OxidizedUnmatchedNode>,
          ]
        : []),
    ],
    [canPin]
  )

  const rows = q.data?.results ?? []
  return (
    <Section title="Unmatched nodes" count={q.data?.count ?? rows.length}>
      {q.isLoading ? null : rows.length === 0 ? (
        <EmptyState title="Every node is linked">
          Sync nodes to read the list from Oxidized.
        </EmptyState>
      ) : (
        <DataTable
          tableId="oxidized-unmatched"
          data={rows}
          total={q.data?.count}
          columns={columns}
          flexColumn="reason"
        />
      )}
      <Dialog
        open={!!pinning}
        onOpenChange={(o) => {
          if (!o) {
            setPinning(null)
            setDeviceId(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pin {pinning?.full_name}</DialogTitle>
          </DialogHeader>
          <DevicePicker
            value={deviceId}
            onChange={setDeviceId}
            placeholder="Select a device…"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pin.isPending}
              onClick={() => setPinning(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!deviceId || pin.isPending}
              onClick={() => pin.mutate()}
            >
              {pin.isPending ? "Pinning…" : "Pin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  )
}

/** The pairings in force: matched by the last sync, or pinned by hand. */
function LinkedNodes({
  connection,
  canUnlink,
}: {
  connection: OxidizedConnection
  canUnlink: boolean
}) {
  const qc = useQueryClient()
  const [unlinking, setUnlinking] = useState<OxidizedNodeLink | null>(null)
  const links = useQuery({
    queryKey: ["oxidized-links", connection.id],
    queryFn: () =>
      api<Paginated<OxidizedNodeLink>>(
        `/api/oxidized/links/?connection=${connection.id}&page_size=1000`
      ),
  })
  const unlink = useMutation({
    mutationFn: (id: string) =>
      api(`/api/oxidized/links/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Unlinked")
      setUnlinking(null)
      void qc.invalidateQueries({ queryKey: ["oxidized-links"] })
      void qc.invalidateQueries({ queryKey: ["oxidized-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<OxidizedNodeLink>[]>(
    () => [
      {
        id: "device",
        accessorFn: (r) => r.device.name,
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.device.id }}
            search={{ tab: "config" }}
            className="link font-medium"
          >
            {row.original.device.name}
          </Link>
        ),
      },
      {
        id: "node",
        accessorKey: "full_name",
        header: ({ column }) => <SortHeader column={column} label="Node" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.full_name}</span>
        ),
      },
      {
        id: "ip",
        accessorKey: "node_ip",
        header: ({ column }) => <SortHeader column={column} label="Address" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.node_ip || "-"}
          </span>
        ),
      },
      {
        id: "model",
        accessorKey: "node_model",
        header: ({ column }) => <SortHeader column={column} label="Model" />,
      },
      {
        id: "matched_by",
        accessorKey: "matched_by",
        header: ({ column }) => (
          <SortHeader column={column} label="Matched by" />
        ),
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.matched_by === "manual" ? "info" : "secondary"
            }
          >
            {row.original.matched_by === "manual"
              ? "Pinned"
              : row.original.matched_by === "address"
                ? "Address"
                : "Name"}
          </Badge>
        ),
      },
      {
        id: "seen",
        accessorKey: "last_seen_at",
        header: ({ column }) => (
          <SortHeader column={column} label="Last seen" />
        ),
        cell: ({ row }) =>
          row.original.last_seen_at ? (
            <TimeCell iso={row.original.last_seen_at} />
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      ...(canUnlink
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <RowActions
                  onDelete={() => setUnlinking(row.original)}
                  deleteLabel="Unlink"
                />
              ),
            } as ColumnDef<OxidizedNodeLink>,
          ]
        : []),
    ],
    [canUnlink]
  )

  const rows = links.data?.results ?? []
  return (
    <Section title="Linked nodes" count={links.data?.count ?? rows.length}>
      {links.isLoading ? null : rows.length === 0 ? (
        <EmptyState title="Nothing linked">
          Sync nodes pairs each Oxidized node with its device.
        </EmptyState>
      ) : (
        <DataTable
          tableId="oxidized-links"
          data={rows}
          total={links.data?.count}
          columns={columns}
          flexColumn="node"
        />
      )}
      <ConfirmDialog
        open={!!unlinking}
        onOpenChange={(o) => !o && setUnlinking(null)}
        title={`Unlink ${unlinking?.device.name ?? "this device"}?`}
        description="A matched link comes back on the next sync if it still matches. Oxidized is untouched."
        confirmLabel="Unlink"
        pendingLabel="Unlinking…"
        pending={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking.id)}
      />
    </Section>
  )
}

function ConnectionDialog({
  connection,
  open,
  onOpenChange,
  onSaved,
}: {
  connection: OxidizedConnection | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connection ? `Edit ${connection.name}` : "Add Oxidized connection"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <ConnectionForm
            connection={connection}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConnectionForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection: OxidizedConnection | null
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!connection
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [name, setName] = useState(connection?.name ?? "")
  const [url, setUrl] = useState(connection?.url ?? "")
  const [username, setUsername] = useState(connection?.username ?? "")
  const [password, setPassword] = useState("")
  const [verifyTls, setVerifyTls] = useState(connection?.verify_tls ?? true)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [matchBy, setMatchBy] = useState<string | null>(
    connection?.match_by ?? "address_name"
  )

  // A plain request rather than the planning-aware save: a staged change
  // would keep the password in the plan.
  const mutation = useMutation({
    mutationFn: () =>
      api<OxidizedConnection>(
        isEdit
          ? `/api/oxidized/connections/${connection.id}/`
          : "/api/oxidized/connections/",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            username: username.trim(),
            // Blank keeps what is stored.
            ...(password ? { password } : {}),
            verify_tls: verifyTls,
            enabled,
            match_by: matchBy,
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
          placeholder="oxidized"
          error={fieldErrors.name}
        />
        <FormText
          label="URL"
          required
          mono
          value={url}
          onChange={setUrl}
          placeholder="https://oxidized.example.com"
          info="Where oxidized-web answers. An internal address needs a deployment admin to allow it under Settings → Security → Outbound connections."
          error={fieldErrors.url}
        />
        <FormText
          label="Username"
          value={username}
          onChange={setUsername}
          info="Basic auth, for an oxidized-web behind a proxy that asks for it. Leave blank for none."
          error={fieldErrors.username}
        />
        <FormText
          label="Password"
          type="password"
          hint={connection?.password_set ? "Set. Blank keeps it." : undefined}
          info="Dropped when the URL moves to another host or the username changes, so it is never sent somewhere it was not typed for."
          value={password}
          onChange={setPassword}
          placeholder={connection?.password_set ? "••••••" : ""}
          error={fieldErrors.password}
        />
        <FormSelect
          label="Matching"
          info="How a node finds its device: an address recorded on the device, then the device name (the host part of an FQDN counts). A node that matches two devices, or a device two nodes match, is left unmatched."
          value={matchBy}
          onChange={setMatchBy}
          options={MATCH_OPTIONS}
          error={fieldErrors.match_by}
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
