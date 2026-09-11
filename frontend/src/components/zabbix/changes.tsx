import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  ZabbixApplyResult,
  ZabbixChange,
  ZabbixConnection,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { SegmentedTabs } from "@/components/segmented-tabs"

/**
 * The review queue - what Danbyte would write, waiting for a person.
 *
 * A change is a proposal, never a record: applying one removes it. "Needs a
 * decision" cannot be applied at all, and is drawn differently so it does not
 * read as one more thing to click Apply on. Dismissing keeps the proposal on
 * a second list so a mis-click is not a permanent silence.
 */

const KIND_VARIANT: Record<
  string,
  "secondary" | "warning" | "destructive" | "info"
> = {
  create_host: "info",
  update_host: "secondary",
  link_template: "secondary",
  ambiguous: "warning",
  prune_host: "destructive",
}

export function ZabbixChanges({ connection }: { connection: ZabbixConnection }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canApply = canDo("zabbixchange", "change")
  const [view, setView] = useState<"queue" | "dismissed">("queue")
  const [confirmApply, setConfirmApply] = useState<ZabbixChange | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const changes = useQuery({
    queryKey: ["zabbix-changes", connection.id, view],
    queryFn: () =>
      api<Paginated<ZabbixChange>>(
        `/api/zabbix/changes/?connection=${connection.id}${
          view === "dismissed" ? "&ignored=1" : ""
        }`
      ),
  })
  const rows = changes.data?.results ?? []

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
    void qc.invalidateQueries({ queryKey: ["zabbix-links"] })
    void qc.invalidateQueries({ queryKey: ["zabbix-scope"] })
  }

  const apply = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; detail: string }>(
        `/api/zabbix/changes/${id}/apply/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(r.detail)
      setConfirmApply(null)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/changes/${id}/dismiss/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Dismissed")
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const restore = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/changes/${id}/restore/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Back in the queue")
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const applyAll = useMutation({
    mutationFn: () =>
      api<ZabbixApplyResult>("/api/zabbix/changes/apply-all/", {
        method: "POST",
        body: JSON.stringify({ connection: connection.id }),
      }),
    onSuccess: (r) => {
      toast.success(
        `Applied ${r.applied}${r.failed ? `, ${r.failed} failed` : ""}.`
      )
      // One toast per refusal, in Zabbix's own words: "these two templates
      // both define icmpping" is a rule to fix, and a count is not.
      for (const e of r.errors ?? []) {
        toast.error(`${e.device || "Host"}: ${e.detail}`)
      }
      setConfirmAll(false)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const applicable = rows.filter((c) => c.applicable)
  const prunes = applicable.filter((c) => c.kind === "prune_host").length
  // A prune deletes a host from another system; that one gets a confirmation
  // where the rest apply on click.
  const onApply = (c: ZabbixChange) =>
    c.kind === "prune_host" ? setConfirmApply(c) : apply.mutate(c.id)
  const onApplyAll = () => (prunes > 0 ? setConfirmAll(true) : applyAll.mutate())

  const applyingId = apply.isPending ? apply.variables : null
  const dismissingId = dismiss.isPending ? dismiss.variables : null
  const restoringId = restore.isPending ? restore.variables : null
  const anyApplying = apply.isPending || applyAll.isPending

  const columns = useMemo<ColumnDef<ZabbixChange>[]>(
    () => [
      {
        id: "kind",
        accessorKey: "kind_display",
        header: ({ column }) => <SortHeader column={column} label="Change" />,
        cell: ({ row }) => (
          <Badge variant={KIND_VARIANT[row.original.kind] ?? "secondary"}>
            {row.original.kind_display}
          </Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Change",
            get: (r: ZabbixChange) => r.kind_display,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
      {
        id: "device",
        accessorFn: (r) => r.device?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) =>
          row.original.device ? (
            <Link
              to="/devices/$id"
              params={{ id: row.original.device.id }}
              className="link font-medium"
            >
              {row.original.device.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "detail",
        header: "What would be written",
        enableSorting: false,
        cell: ({ row }) => <ChangeDetail change={row.original} />,
      },
      ...(canApply
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => {
                const c = row.original
                if (view === "dismissed")
                  return (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(c.id)}
                    >
                      {restoringId === c.id ? "Restoring…" : "Restore"}
                    </Button>
                  )
                return (
                  <span className="inline-flex items-center gap-2">
                    {c.applicable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={anyApplying}
                        onClick={() => onApply(c)}
                      >
                        {applyingId === c.id ? "Applying…" : "Apply"}
                      </Button>
                    ) : (
                      <Badge variant="warning">Needs a decision</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(c.id)}
                    >
                      {dismissingId === c.id ? "Dismissing…" : "Dismiss"}
                    </Button>
                  </span>
                )
              },
            } as ColumnDef<ZabbixChange>,
          ]
        : []),
    ],
    // The column cells close over the mutations; their pending ids are the
    // only thing that changes between renders.
    [canApply, view, applyingId, dismissingId, restoringId, anyApplying]
  )

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          To review
          <Badge variant="secondary" className="num">
            {rows.length}
          </Badge>
        </h2>
        <SegmentedTabs
          value={view}
          onValueChange={setView}
          items={[
            { value: "queue", label: "Queue" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
        {canApply && view === "queue" && applicable.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            disabled={applyAll.isPending}
            onClick={onApplyAll}
          >
            {applyAll.isPending
              ? "Applying…"
              : `Apply ${applicable.length} changes`}
          </Button>
        )}
      </div>

      {changes.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={view === "dismissed" ? "Nothing dismissed" : "Nothing to review"}
          className="m-4"
        >
          {view === "dismissed"
            ? "Dismissed proposals wait here until restored."
            : connection.provision_mode === "off"
              ? "Provisioning is off."
              : "Zabbix matches what Danbyte expects."}
        </EmptyState>
      ) : (
        <DataTable
          tableId={`zabbix-changes-${view}`}
          data={rows}
          columns={columns}
          flexColumn="detail"
        />
      )}

      <ConfirmDialog
        open={!!confirmApply}
        onOpenChange={(o) => !o && setConfirmApply(null)}
        title={`Remove ${confirmApply?.device?.name ?? "this host"} from Zabbix?`}
        description="The host, its items and its history are deleted in Zabbix. This cannot be undone from Danbyte."
        confirmLabel="Remove host"
        pendingLabel="Removing…"
        pending={apply.isPending}
        onConfirm={() => confirmApply && apply.mutate(confirmApply.id)}
      />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={`Apply ${applicable.length} changes?`}
        description={`${prunes} of them remove${prunes === 1 ? "s" : ""} a host from Zabbix, with its items and history. That part cannot be undone from Danbyte.`}
        confirmLabel="Apply all"
        pendingLabel="Applying…"
        pending={applyAll.isPending}
        onConfirm={() => applyAll.mutate()}
      />
    </section>
  )
}

/** What would actually be written, in a sentence. */
function ChangeDetail({ change }: { change: ZabbixChange }) {
  const d = change.detail
  if (change.kind === "ambiguous")
    return (
      <span className="text-[12px] text-muted-foreground">
        {String(d.reason ?? "")}
      </span>
    )
  if (change.kind === "prune_host")
    return (
      <span className="text-[12px] text-muted-foreground">
        Deletes <span className="font-mono">{String(d.host_name ?? "")}</span>{" "}
        - Danbyte created it and it left scope.
      </span>
    )
  if (change.kind === "link_template") {
    const add = (d.add ?? []) as string[]
    const groups = (d.add_groups ?? []) as string[]
    const parts: string[] = []
    if (add.length) parts.push(`links ${add.join(", ")}`)
    if (groups.length) parts.push(`joins ${groups.join(", ")}`)
    if (d.add_snmp_interface) parts.push("adds an SNMP interface")
    return (
      <span className="text-[12px] text-muted-foreground">
        {parts.length ? parts.join(" · ") : "nothing new"}
      </span>
    )
  }
  if (change.kind === "update_host") {
    const changes = (d.changes ?? {}) as Record<string, unknown>
    const fields = Object.entries(changes)
      // `_interfaceid` is how the write is addressed, not something being
      // changed; `_address` and `_proxy` are changes on other calls.
      .filter(([k]) => k !== "_interfaceid")
      .map(([k, v]) => `${k.replace(/^_/, "")} → ${String(v)}`)
    return (
      <span className="text-[12px] text-muted-foreground">
        {fields.length > 0 ? fields.join(", ") : "no writable difference"}
      </span>
    )
  }
  const templates = (d.templates ?? []) as string[]
  const groups = (d.groups ?? []) as string[]
  const parts: string[] = []
  if (groups.length) parts.push(`in ${groups.join(", ")}`)
  if (templates.length) parts.push(`with ${templates.join(", ")}`)
  if (d.proxy) parts.push(`via ${String(d.proxy)}`)
  return (
    <span className="text-[12px] text-muted-foreground">
      Creates the host{parts.length ? ` ${parts.join(", ")}` : ""}.
    </span>
  )
}
