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
 * The PRTG review queue: link proposals (review mode), PRTG devices offered
 * for adoption, and the ambiguities a read could not settle. Same actions and
 * URL shape as the Zabbix queue; every row here changes Danbyte, not PRTG.
 */
export function PrtgChanges({
  connection,
  onEditConnection,
}: {
  connection: PrtgConnection
  /** Opens the connection form, where an adoption waiting on a default is
   * unblocked. */
  onEditConnection?: () => void
}) {
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
  // Planned writes to PRTG cannot be applied yet; "apply all" skips them.
  const applicable = rows.filter((c) => c.applicable && !c.planned)

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
      toast.success(`Applied ${r.applied}.`)
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
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Badge
              variant={row.original.kind === "ambiguous" ? "warning" : "info"}
            >
              {row.original.kind_display}
            </Badge>
            {row.original.planned && <Badge variant="outline">Planned</Badge>}
          </span>
        ),
      },
      {
        id: "device",
        accessorFn: (r) => prtgParentName(r),
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) =>
          row.original.kind === "adopt" ? (
            // Not a device yet: the PRTG device's name, which applying makes
            // one.
            <span className="font-mono text-xs">
              {String(row.original.detail.name ?? "")}
            </span>
          ) : (
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
                const adopt = c.kind === "adopt"
                const applying = busy && act.variables?.verb === "apply"
                return (
                  <span className="inline-flex items-center gap-2">
                    {c.applicable && !c.planned && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ id: c.id, verb: "apply" })}
                      >
                        {adopt
                          ? applying
                            ? "Adopting…"
                            : "Adopt"
                          : applying
                            ? "Linking…"
                            : "Link"}
                      </Button>
                    )}
                    {adopt && !c.applicable && onEditConnection && (
                      // Waiting on the connection's defaults: the button is
                      // the decision, not a label saying one is needed.
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={onEditConnection}
                      >
                        Set defaults
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
    [canApply, view, pendingId, onEditConnection]
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
              {applyAll.isPending ? "Applying…" : `Apply ${applicable.length}`}
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
  if (change.kind === "adopt") return <AdoptDetail detail={d} />
  if (change.planned) return <PlannedDetail change={change} />
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

/** What adopting makes: the device, where, and on which address. */
export function AdoptDetail({
  detail: d,
}: {
  detail: Record<string, unknown>
}) {
  const name = String(d.name ?? d.host ?? "")
  if (d.reason)
    return (
      <span className="text-[13px] text-muted-foreground">
        <span className="font-mono text-xs">{name}</span> - {String(d.reason)}
      </span>
    )
  const parts: string[] = []
  if (d.device_type) parts.push(`a ${String(d.device_type)}`)
  if (d.role) parts.push(String(d.role))
  if (d.site)
    parts.push(
      `at ${String(d.site)}${d.rule ? ` (rule ${String(d.rule)})` : ""}`
    )
  if (d.address) parts.push(`on ${String(d.address)}`)
  return (
    <span className="text-[13px] text-muted-foreground">
      Creates the device <span className="font-mono text-xs">{name}</span> in
      Danbyte{parts.length ? ` - ${parts.join(", ")}` : ""}.
      {d.note ? ` ${String(d.note)}` : ""}
    </span>
  )
}

type PlannedSensor = {
  name?: string
  kind_label?: string
  interface?: { name: string } | null
}
type PlannedGroup = { path?: string; objid?: string } | null

const CREDENTIAL_LABEL: Record<string, string> = {
  snmp: "SNMP",
  windows: "Windows",
}

/** What a planned write would do to PRTG - not written in this release. */
export function PlannedDetail({ change }: { change: PrtgChange }) {
  const d = change.detail
  const reason =
    !change.applicable && d.reason ? (
      <Badge variant="warning">{String(d.reason)}</Badge>
    ) : null
  const groupPath = (g: unknown) => {
    const group = g as PlannedGroup
    return group ? String(group.path || group.objid || "") : ""
  }
  if (change.kind === "create_device") {
    const sensors = (d.sensors as PlannedSensor[] | undefined) ?? []
    const templates = (d.templates as string[] | undefined) ?? []
    const creds =
      (d.credentials as { kind: string; name: string }[] | undefined) ?? []
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-mono text-xs">{String(d.host ?? "")}</span>
        {groupPath(d.group) && (
          <span className="text-muted-foreground">in {groupPath(d.group)}</span>
        )}
        {sensors.map((s, i) => (
          <Badge key={`${s.name}-${i}`} variant="secondary">
            {s.name}
          </Badge>
        ))}
        {templates.map((t) => (
          <Badge key={`t-${t}`} variant="outline">
            Template {t}
          </Badge>
        ))}
        {creds.map((c) => (
          <Badge key={`c-${c.kind}-${c.name}`} variant="outline">
            {CREDENTIAL_LABEL[c.kind] ?? c.kind} {c.name}
          </Badge>
        ))}
        {reason}
      </span>
    )
  }
  if (change.kind === "add_sensor") {
    const s = (d.sensor as PlannedSensor | undefined) ?? {}
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-medium">{s.name}</span>
        <Badge variant="secondary">{s.kind_label}</Badge>
        {s.interface?.name && (
          <span className="font-mono text-xs text-muted-foreground">
            {s.interface.name}
          </span>
        )}
        {reason}
      </span>
    )
  }
  if (change.kind === "remove_sensor") {
    const s = (d.sensor as { name?: string; objid?: string } | undefined) ?? {}
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-medium">{s.name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {s.objid}
        </span>
        {reason}
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="text-muted-foreground">{groupPath(d.from)}</span>
      <span>→</span>
      <span>{groupPath(d.to)}</span>
      {reason}
    </span>
  )
}
