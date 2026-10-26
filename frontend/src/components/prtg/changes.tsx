import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PrtgChange, PrtgConnection } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import { SegmentedTabs } from "@/components/segmented-tabs"

import { PrtgParentLink, prtgParentName } from "./parent-link"

/**
 * The PRTG review queue: link proposals (review mode) and the ambiguities a
 * read could not settle. Same actions and URL shape as the Zabbix queue;
 * mirrored rather than shared because the Zabbix rows describe writes into
 * Zabbix and these describe pairings in Danbyte.
 */
export function PrtgChanges({ connection }: { connection: PrtgConnection }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canApply = canDo("prtgchange", "change")
  const [view, setView] = useState<"queue" | "dismissed">("queue")

  const changes = useQuery({
    queryKey: ["prtg-changes", connection.id, view],
    queryFn: () =>
      apiAll<PrtgChange>(
        `/api/prtg/changes/?connection=${connection.id}${
          view === "dismissed" ? "&ignored=1" : ""
        }`
      ),
  })
  const rows = changes.data?.results ?? []
  const applicable = rows.filter((c) => c.applicable)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["prtg-changes"] })
    void qc.invalidateQueries({ queryKey: ["prtg-links"] })
  }
  const act = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: string }) =>
      api<{ ok?: boolean; detail?: string }>(
        `/api/prtg/changes/${id}/${verb}/`,
        { method: "POST" }
      ),
    onSuccess: (r, { verb }) => {
      toast.success(
        r.detail ?? (verb === "dismiss" ? "Dismissed" : "Back in the queue")
      )
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })
  const applyAll = useMutation({
    mutationFn: () =>
      api<{ applied: number; failed: { id: string; detail: string }[] }>(
        "/api/prtg/changes/apply-all/",
        { method: "POST", body: JSON.stringify({ connection: connection.id }) }
      ),
    onSuccess: (r) => {
      toast.success(`Linked ${r.applied}.`)
      for (const f of r.failed) toast.error(f.detail)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const pendingId = act.isPending ? act.variables.id : null

  const columns = useMemo<ColumnDef<PrtgChange>[]>(
    () => [
      {
        id: "kind",
        accessorKey: "kind_display",
        header: ({ column }) => <SortHeader column={column} label="Change" />,
        cell: ({ row }) => (
          <Badge
            variant={row.original.kind === "ambiguous" ? "warning" : "info"}
          >
            {row.original.kind_display}
          </Badge>
        ),
      },
      {
        id: "device",
        accessorFn: (r) => prtgParentName(r),
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <PrtgParentLink
            device={row.original.device}
            virtual_machine={row.original.virtual_machine}
          />
        ),
      },
      {
        id: "detail",
        header: "Why",
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
                const busy = pendingId === c.id
                if (view === "dismissed")
                  return (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: c.id, verb: "restore" })}
                    >
                      {busy ? "Restoring…" : "Restore"}
                    </Button>
                  )
                return (
                  <span className="inline-flex items-center gap-2">
                    {c.applicable && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ id: c.id, verb: "apply" })}
                      >
                        {busy && act.variables?.verb === "apply"
                          ? "Linking…"
                          : "Link"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: c.id, verb: "dismiss" })}
                    >
                      {busy && act.variables?.verb === "dismiss"
                        ? "Dismissing…"
                        : "Dismiss"}
                    </Button>
                  </span>
                )
              },
            } as ColumnDef<PrtgChange>,
          ]
        : []),
    ],
    // The cells close over the mutation; its pending id is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canApply, view, pendingId]
  )

  return (
    <Section
      title="To review"
      count={rows.length}
      actions={
        <>
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
              onClick={() => applyAll.mutate()}
            >
              {applyAll.isPending
                ? "Linking…"
                : `Link ${applicable.length} devices`}
            </Button>
          )}
        </>
      }
    >
      {changes.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            view === "dismissed" ? "Nothing dismissed" : "Nothing to review"
          }
        >
          {view === "dismissed"
            ? "Dismissed proposals wait here until restored."
            : "Every match was clear."}
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-changes"
          autoColumns={{ api: "/api/prtg/changes/" }}
          data={rows}
          total={changes.data?.count}
          columns={columns}
          flexColumn="detail"
          searchable
          searchPlaceholder="Search changes…"
        />
      )}
    </Section>
  )
}

function ChangeDetail({ change }: { change: PrtgChange }) {
  const d = change.detail
  if (change.kind === "ambiguous")
    return (
      <span className="text-[13px] text-muted-foreground">
        {String(d.reason ?? "")}
      </span>
    )
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="font-mono text-xs">{String(d.name ?? d.objid)}</span>
      {d.host ? (
        <span className="font-mono text-xs text-muted-foreground">
          {String(d.host)}
        </span>
      ) : null}
      <Badge variant="secondary">by {String(d.matched_by ?? "")}</Badge>
      {d.replaces ? (
        <span className="text-muted-foreground">
          replaces {String(d.replaces)}
        </span>
      ) : null}
    </span>
  )
}
