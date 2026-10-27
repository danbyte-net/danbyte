import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink, Undo2, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgApplyLogEntry,
  PrtgApplyResults,
  PrtgChange,
  PrtgChangeStatus,
  PrtgConnection,
  PrtgDecisionCandidate,
  PrtgDecisionRemote,
  PrtgIssue,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { PanelSection, PanelShell } from "@/components/map-panel"
import { cn } from "@/lib/utils"
import { Section } from "@/components/ui/section"
import { TimeCell } from "@/components/cells/time-ago"
import { useTableFilters } from "@/components/table-filters"

import { PrtgIssueLine } from "./issues"
import { PrtgParentLink, prtgParentName } from "./parent-link"

/**
 * The PRTG review queue as an inbox. Every row has a status - Ready, Needs
 * attention (with where to fix it), Applied (with what PRTG made), Failed
 * (with Retry), Needs a decision, Dismissed - and an Apply beside Dismiss.
 * Rows are selected for Apply selected / Dismiss selected, and Apply all
 * applicable confirms what it will do. Removals in PRTG are applied one at a
 * time, after a confirmation. Clicking a row opens the whole plan beside the
 * table.
 */
/** The connection's review queue - shared by the tab and its count. */
export function usePrtgQueue(connectionId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["prtg-changes", connectionId, "queue"],
    queryFn: () =>
      apiAll<PrtgChange>(`/api/prtg/changes/?connection=${connectionId}`),
  })
}

/** Rows that need a person: ready, needs attention, needs a decision. */
export function needsPerson(rows: PrtgChange[] | undefined): number {
  return (rows ?? []).filter((c) => {
    const st = rowStatus(c)
    return st === "ready" || st === "attention" || st === "decision"
  }).length
}

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
  const [hideDismissed, setHideDismissed] = useState(true)
  const [selected, setSelected] = useState<PrtgChange[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<PrtgChange | null>(null)

  const queue = usePrtgQueue(connection.id)
  // ?object=<id> narrows the queue to one device or VM: the Sensors and
  // Monitoring tabs link here with it.
  const search: { object?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const objectId = search.object
  const clearObject = () =>
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ["object" as string]: undefined,
      }),
    })
  const dismissed = useQuery({
    queryKey: ["prtg-changes", connection.id, "dismissed"],
    queryFn: () =>
      apiAll<PrtgChange>(
        `/api/prtg/changes/?connection=${connection.id}&ignored=1`
      ),
    enabled: !hideDismissed,
  })
  const rows = useMemo(
    () =>
      [
        ...(queue.data?.results ?? []),
        ...(hideDismissed ? [] : (dismissed.data?.results ?? [])),
      ].filter(
        (c) =>
          !objectId ||
          c.device?.id === objectId ||
          c.virtual_machine?.id === objectId
      ),
    [queue.data, dismissed.data, hideDismissed, objectId]
  )
  const objectName = objectId
    ? prtgParentName(rows[0] ?? { device: null, virtual_machine: null })
    : ""
  // What "Apply all" reaches: the server applies the same rows.
  const applicable = rows.filter(
    (c) => !c.ignored && c.applicable && !c.destructive && c.status === "ready"
  )

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["prtg-changes"] })
    void qc.invalidateQueries({ queryKey: ["prtg-links"] })
    void qc.invalidateQueries({ queryKey: ["prtg-connections"] })
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
    onError: (e) => {
      apiErrorToast(e)
      refresh()
    },
  })
  const report = (r: PrtgApplyResults) => {
    if (r.applied) toast.success(`Applied ${r.applied}.`)
    for (const f of r.failed) toast.error(f.detail)
    if (!r.applied && !r.failed.length) toast.info("Nothing to apply.")
    setSelected([])
    refresh()
  }
  const applyAll = useMutation({
    mutationFn: () =>
      api<PrtgApplyResults>("/api/prtg/changes/apply-all/", {
        method: "POST",
        body: JSON.stringify({ connection: connection.id }),
      }),
    onSuccess: (r) => {
      setConfirmAll(false)
      report(r)
    },
    onError: (e) => apiErrorToast(e),
  })
  const applySelected = useMutation({
    mutationFn: (ids: string[]) =>
      api<PrtgApplyResults>("/api/prtg/changes/apply-selected/", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: report,
    onError: (e) => apiErrorToast(e),
  })
  const dismissSelected = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ dismissed: number }>("/api/prtg/changes/dismiss-selected/", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (r) => {
      toast.success(`Dismissed ${r.dismissed}.`)
      setSelected([])
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const pendingId = act.isPending ? act.variables.id : null
  const apply = (c: PrtgChange) =>
    c.destructive
      ? setConfirmRemove(c)
      : act.mutate({ id: c.id, verb: "apply" })

  const columns = useMemo<ColumnDef<PrtgChange>[]>(
    () => [
      ...(canApply ? [selectionColumn<PrtgChange>()] : []),
      {
        id: "status",
        accessorFn: (r) => rowStatus(r),
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => (
          <StatusCell change={row.original} connection={connection} />
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: PrtgChange) => rowStatus(r),
            formatValue: (v: string) => ({ label: STATUS_LABEL[v] ?? v }),
          },
        },
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: ({ column }) => <SortHeader column={column} label="Change" />,
        cell: ({ row }) => (
          <Badge
            variant={row.original.destructive ? "destructive" : "info"}
            className="whitespace-nowrap"
          >
            {row.original.kind_display}
          </Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Change",
            get: (r: PrtgChange) => r.kind_display,
            formatValue: (v: string) => ({ label: v }),
          },
        },
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
          ) : row.original.device || row.original.virtual_machine ? (
            <PrtgParentLink
              device={row.original.device}
              virtual_machine={row.original.virtual_machine}
            />
          ) : (
            <span className="font-mono text-xs">
              {String(
                row.original.detail.device_name ??
                  row.original.detail.name ??
                  ""
              )}
            </span>
          ),
        enableHiding: false,
      },
      {
        id: "detail",
        header: "What",
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
                if (c.ignored)
                  return (
                    <IconAction
                      label="Restore"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: c.id, verb: "restore" })}
                    >
                      <Undo2 />
                    </IconAction>
                  )
                const applying = busy && act.variables?.verb === "apply"
                const status = rowStatus(c)
                if (status === "decision")
                  return (
                    <span
                      className="inline-flex flex-wrap items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DecisionActions change={c} />
                      <IconAction
                        label="Dismiss"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({ id: c.id, verb: "dismiss" })
                        }
                      >
                        <X />
                      </IconAction>
                    </span>
                  )
                const canRun =
                  c.applicable && (status === "ready" || status === "failed")
                return (
                  <span
                    className="inline-flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canRun && (
                      <Button
                        size="sm"
                        variant={c.destructive ? "outline" : "default"}
                        disabled={act.isPending}
                        onClick={() => apply(c)}
                      >
                        {applying
                          ? "Applying…"
                          : status === "failed"
                            ? "Retry"
                            : "Apply"}
                      </Button>
                    )}
                    {c.kind === "adopt" &&
                      !c.applicable &&
                      onEditConnection && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={onEditConnection}
                        >
                          Set defaults
                        </Button>
                      )}
                    {status === "failed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({ id: c.id, verb: "dismiss" })
                        }
                      >
                        {c.kind === "add_sensor" ? "Skip this sensor" : "Skip"}
                      </Button>
                    ) : (
                      status !== "applied" && (
                        <IconAction
                          label="Dismiss"
                          disabled={act.isPending}
                          onClick={() =>
                            act.mutate({ id: c.id, verb: "dismiss" })
                          }
                        >
                          <X />
                        </IconAction>
                      )
                    )}
                  </span>
                )
              },
            } as ColumnDef<PrtgChange>,
          ]
        : []),
    ],
    // The cells close over the mutation; its pending id is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canApply, pendingId, onEditConnection, connection]
  )

  const {
    rail,
    columns: wiredColumns,
    filteredRows,
  } = useTableFilters(columns, rows)
  const open = rows.find((r) => r.id === openId) ?? null
  const kinds = countKinds(applicable)

  return (
    <Section
      title="To review"
      count={queue.data?.results.length ?? 0}
      actions={
        <>
          <label className="inline-flex items-center gap-2 text-[13px] whitespace-nowrap">
            <Checkbox
              checked={hideDismissed}
              onCheckedChange={(v) => setHideDismissed(v === true)}
              aria-label="Hide dismissed"
            />
            Hide dismissed
          </label>
          {canApply && applicable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={applyAll.isPending}
              onClick={() => setConfirmAll(true)}
            >
              Apply all applicable
            </Button>
          )}
        </>
      }
    >
      {objectId && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
          <Badge variant="secondary">
            Showing {objectName || "one object"}
          </Badge>
          <Button size="sm" variant="ghost" onClick={clearObject}>
            Show all
          </Button>
        </div>
      )}
      {queue.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to review">
          {hideDismissed
            ? "Every match was clear and PRTG has what Danbyte plans."
            : "Nothing dismissed either."}
        </EmptyState>
      ) : (
        <div
          className={cn(
            "relative flex min-w-0 overflow-hidden rounded-lg border border-border",
            // Room for the side panel: a short queue must not squeeze it
            // into a scrolling strip.
            open && "min-h-[28rem]"
          )}
        >
          {rail}
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
            <DataTable
              tableId="prtg-changes"
              data={filteredRows}
              total={filteredRows.length}
              columns={wiredColumns}
              flexColumn="detail"
              searchable
              searchPlaceholder="Search changes…"
              onSelectedRowsChange={canApply ? setSelected : undefined}
              selectedRows={selected}
              onRowClick={(r) => setOpenId(r.id === openId ? null : r.id)}
            />
          </div>
          {open && (
            <ChangePanel
              change={open}
              connection={connection}
              onClose={() => setOpenId(null)}
            />
          )}
        </div>
      )}
      {canApply && selected.length > 0 && (
        <SelectionBar
          count={selected.length}
          busy={applySelected.isPending || dismissSelected.isPending}
          applying={applySelected.isPending}
          dismissing={dismissSelected.isPending}
          onApply={() => applySelected.mutate(selected.map((c) => c.id))}
          onDismiss={() => dismissSelected.mutate(selected.map((c) => c.id))}
          onClear={() => setSelected([])}
        />
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={`Apply ${applicable.length} change${applicable.length === 1 ? "" : "s"}?`}
        description={
          <span>
            {kinds.map(([k, n]) => `${n} × ${k}`).join(", ")}. Removals are left
            for one at a time.
          </span>
        }
        confirmLabel="Apply"
        pendingLabel="Applying…"
        destructive={false}
        pending={applyAll.isPending}
        onConfirm={() => applyAll.mutate()}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title={confirmRemove?.kind_display ?? "Remove from PRTG"}
        description={confirmRemove ? removeSentence(confirmRemove) : undefined}
        confirmLabel="Apply"
        pendingLabel="Applying…"
        pending={act.isPending}
        onConfirm={() => {
          if (confirmRemove)
            act.mutate(
              { id: confirmRemove.id, verb: "apply" },
              { onSettled: () => setConfirmRemove(null) }
            )
        }}
      />
    </Section>
  )
}

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  attention: "Needs attention",
  applied: "Applied",
  failed: "Failed",
  decision: "Needs a decision",
  dismissed: "Dismissed",
}

/** The row's status, dismissed rows being their own. */
export function rowStatus(c: PrtgChange): PrtgChangeStatus | "dismissed" {
  return c.ignored ? "dismissed" : (c.status ?? "ready")
}

function countKinds(rows: PrtgChange[]): [string, number][] {
  const out = new Map<string, number>()
  for (const r of rows)
    out.set(r.kind_display, (out.get(r.kind_display) ?? 0) + 1)
  return [...out.entries()]
}

/** A PRTG path ("Local Probe / Denmark / HQ") as the queue shows it. */
export function treePath(path: unknown): string {
  return String(path ?? "")
    .split(" / ")
    .filter(Boolean)
    .join(" › ")
}

function removeSentence(c: PrtgChange): string {
  const d = c.detail
  if (c.kind === "remove_group")
    return `Deletes the empty PRTG group ${treePath(d.path) || String(d.objid ?? "")}. Danbyte made it.`
  if (c.kind === "remove_device") {
    const rule = d.rule as { name?: string } | undefined
    return `Deletes PRTG device ${String(d.name || d.objid || "")} and its sensors. ${
      rule?.name ? `Rule ${rule.name}.` : "Danbyte created it."
    }`
  }
  const s = (d.sensor as { name?: string; objid?: string } | undefined) ?? {}
  return `Deletes sensor ${s.name ?? ""} (${s.objid ?? c.key}) in PRTG. Danbyte created it.`
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The bar that appears while rows are selected. */
export function SelectionBar({
  count,
  busy,
  applying,
  dismissing,
  onApply,
  onDismiss,
  onClear,
}: {
  count: number
  busy: boolean
  applying: boolean
  dismissing: boolean
  onApply: () => void
  onDismiss: () => void
  onClear: () => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
      <div
        role="toolbar"
        aria-label="Selected changes"
        className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
      >
        <span className="pl-2 text-xs font-medium whitespace-nowrap">
          {count} selected
        </span>
        <span className="h-4 w-px bg-border" />
        <Button size="sm" className="h-7" disabled={busy} onClick={onApply}>
          {applying ? "Applying…" : "Apply selected"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={busy}
          onClick={onDismiss}
        >
          {dismissing ? "Dismissing…" : "Dismiss selected"}
        </Button>
        <IconAction label="Clear selection" onClick={onClear}>
          <X />
        </IconAction>
      </div>
    </div>
  )
}

/** The status pill and what goes with it. */
export function StatusCell({
  change: c,
  connection,
}: {
  change: PrtgChange
  connection: PrtgConnection
}) {
  const status = rowStatus(c)
  const d = c.detail
  if (status === "applied") {
    const deviceId = (d.result as { device?: string } | undefined)?.device
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        <Badge variant="success">Applied</Badge>
        {deviceId && (
          <a
            href={`${connection.url.replace(/\/$/, "")}/device.htm?id=${deviceId}`}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            PRTG
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </span>
    )
  }
  if (status === "failed") {
    const last = d.last_error as
      { detail?: string; prtg?: string; issue?: PrtgIssue } | undefined
    const full = [last?.detail, last?.prtg].filter(Boolean).join(" PRTG said: ")
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px] [overflow-wrap:anywhere]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive">Failed</Badge>
          </TooltipTrigger>
          <TooltipContent variant="default" className="max-w-md break-words">
            {full || "Failed"}
          </TooltipContent>
        </Tooltip>
        {last?.issue ? (
          <PrtgIssueLine issue={last.issue} className="text-muted-foreground" />
        ) : (
          last?.detail && (
            <span className="text-muted-foreground">{last.detail}</span>
          )
        )}
      </span>
    )
  }
  if (status === "attention") {
    const issues = (d.issues as PrtgIssue[] | undefined) ?? []
    const reason = String(d.reason ?? "")
    const object = c.device
      ? { kind: "device" as const, id: c.device.id }
      : c.virtual_machine
        ? { kind: "virtual_machine" as const, id: c.virtual_machine.id }
        : undefined
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px]">
        <Badge variant="warning">Needs attention</Badge>
        {issues.length > 0
          ? issues.map((i) => (
              <PrtgIssueLine
                key={`${i.code}-${i.text}`}
                issue={i}
                object={object}
                className="text-muted-foreground"
              />
            ))
          : reason && <span className="text-muted-foreground">{reason}</span>}
      </span>
    )
  }
  if (status === "decision")
    return <Badge variant="warning">Needs a decision</Badge>
  if (status === "dismissed")
    return <Badge variant="secondary">Dismissed</Badge>
  return <Badge variant="info">Ready</Badge>
}

function ChangeDetail({ change }: { change: PrtgChange }) {
  const d = change.detail
  if (change.kind === "ambiguous") return <DecisionDetail change={change} />
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
  params?: Record<string, unknown>
  interval_seconds?: number | null
  tags?: string[]
  interface?: { name: string } | null
}
type PlannedGroup = { path?: string; objid?: string } | null

/** Which rule chose a planned row's host (`detail.host_source`). */
const HOST_SOURCE: Record<string, string> = {
  override: "the PRTG host set on the object",
  primary: "the primary address",
  oob: "the OOB address",
  assigned: "the first assigned address",
  dns: "the DNS name of its address",
}

const CREDENTIAL_LABEL: Record<string, string> = {
  snmp: "SNMP",
  windows: "Windows",
}

const groupPath = (g: unknown) => {
  const group = g as PlannedGroup
  return group ? String(group.path || group.objid || "") : ""
}

/** What a planned write does to PRTG, in one line. */
export function PlannedDetail({ change }: { change: PrtgChange }) {
  const d = change.detail
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
        {d.deleted_in_prtg ? (
          <span className="text-muted-foreground">Deleted in PRTG</span>
        ) : null}
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
      </span>
    )
  }
  if (change.kind === "update_host") {
    const from = (d.from as { host?: string } | undefined) ?? {}
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-mono text-xs text-muted-foreground">
          {from.host ?? ""}
        </span>
        <span>→</span>
        <span className="font-mono text-xs">{String(d.host ?? "")}</span>
      </span>
    )
  }
  if (
    change.kind === "remove_device" ||
    change.kind === "pause_device" ||
    change.kind === "resume_device"
  )
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-mono text-xs">
          {String(d.name || d.objid || "")}
        </span>
        <span className="text-muted-foreground">{String(d.reason ?? "")}</span>
      </span>
    )
  if (change.kind === "create_group")
    return (
      <span
        className="inline-flex flex-wrap items-center gap-1.5 text-[13px]"
        data-testid="prtg-create-group"
      >
        <span>Create group</span>
        <span className="font-medium">{treePath(d.path)}</span>
      </span>
    )
  if (change.kind === "rename_group")
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="text-muted-foreground">{String(d.from ?? "")}</span>
        <span>→</span>
        <span className="font-medium">{String(d.to ?? "")}</span>
        <span className="text-muted-foreground">{treePath(d.path)}</span>
      </span>
    )
  if (change.kind === "remove_group")
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-medium">{treePath(d.path)}</span>
        <span className="text-muted-foreground">{String(d.reason ?? "")}</span>
      </span>
    )
  if (change.kind === "group_creds") {
    const sections =
      (d.sections as { label: string; credential: string }[] | undefined) ?? []
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
        {sections.map((s) => (
          <Badge key={s.label} variant="outline">
            {s.label} {s.credential}
          </Badge>
        ))}
        <span className="text-muted-foreground">
          on {treePath(groupPath(d.group))}
        </span>
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="text-muted-foreground">{groupPath(d.from)}</span>
      <span>→</span>
      <span>{groupPath(d.to)}</span>
    </span>
  )
}

function paramText(params?: Record<string, unknown>): string {
  return Object.entries(params ?? {})
    .filter(([, v]) => v !== null && v !== "" && v !== false)
    .map(([k, v]) => `${k} ${v === true ? "on" : String(v)}`)
    .join(" · ")
}

/** The whole plan behind a row, and what applying it did. */
export function ChangePanel({
  change: c,
  connection,
  onClose,
}: {
  change: PrtgChange
  connection: PrtgConnection
  onClose: () => void
}) {
  const d = c.detail
  const sensors: PlannedSensor[] =
    c.kind === "create_device"
      ? ((d.sensors as PlannedSensor[] | undefined) ?? [])
      : c.kind === "add_sensor"
        ? [(d.sensor as PlannedSensor | undefined) ?? {}]
        : []
  const creds =
    (d.credentials as { kind: string; name: string }[] | undefined) ?? []
  const placed =
    (d.device_credentials as
      { label: string; credential: string }[] | undefined) ?? []
  const policies =
    (d.policies as { id: string; name: string }[] | undefined) ?? []
  const profiles = (d.profiles as string[] | undefined) ?? []
  const log = (d.log as PrtgApplyLogEntry[] | undefined) ?? []
  const target = d.group ?? d.to
  return (
    <PanelShell
      label="Change"
      title={`${c.kind_display} · ${prtgParentName(c) || String(d.name ?? "")}`}
      onClose={onClose}
      // Rows wrap; nothing may scroll sideways under the text.
      bodyClassName="overflow-x-hidden"
    >
      <PanelSection label="Status">
        <StatusCell change={c} connection={connection} />
      </PanelSection>
      <PanelSection label="Plan">
        {d.host ? (
          <PlanText label="Host">
            {String(d.host)}
            {HOST_SOURCE[String(d.host_source ?? "")] && (
              <span className="text-muted-foreground">
                {" "}
                from {HOST_SOURCE[String(d.host_source)]}
              </span>
            )}
          </PlanText>
        ) : null}
        {groupPath(target) && (
          <PlanText label="Group">{groupPath(target)}</PlanText>
        )}
        {groupPath(d.from) && (
          <PlanText label="From">{groupPath(d.from)}</PlanText>
        )}
        {policies.length > 0 && (
          <PlanText label="Policies">
            {policies.map((p) => p.name).join(", ")}
          </PlanText>
        )}
        {profiles.length > 0 && (
          <PlanText label="Profiles">{profiles.join(", ")}</PlanText>
        )}
        {creds.length > 0 && (
          <PlanText label="Credentials">
            {creds
              .map((x) => `${CREDENTIAL_LABEL[x.kind] ?? x.kind} ${x.name}`)
              .join(", ")}
          </PlanText>
        )}
        {placed.length > 0 && (
          <PlanText label="On the device">
            {placed.map((x) => `${x.label} ${x.credential}`).join(", ")}
          </PlanText>
        )}
        {(c.kind === "create_group" || c.kind === "remove_group") && d.path ? (
          <PlanText label="Path">{treePath(d.path)}</PlanText>
        ) : null}
        {c.kind === "group_creds" && (
          <PlanText label="Sets">
            {((d.sections as { label: string; credential: string }[]) ?? [])
              .map((x) => `${x.label} ${x.credential}`)
              .join(", ")}
          </PlanText>
        )}
        {d.reason ? <PlanText label="Why">{String(d.reason)}</PlanText> : null}
      </PanelSection>
      {c.kind === "ambiguous" && (
        <PanelSection label="Decide">
          <div className="grid gap-2">
            <DecisionDetail change={c} />
            {rowStatus(c) === "decision" && (
              <div className="flex flex-wrap gap-1.5">
                <DecisionActions change={c} />
              </div>
            )}
          </div>
        </PanelSection>
      )}
      {sensors.length > 0 && (
        <PanelSection label="Sensors">
          <ul className="grid gap-1.5">
            {sensors.map((s, i) => (
              <li key={`${s.name}-${i}`} data-testid="prtg-change-sensor">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {s.kind_label}
                  </span>
                </div>
                {s.interface?.name && (
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {s.interface.name}
                  </div>
                )}
                {paramText(s.params) && (
                  <div className="text-[11px] text-muted-foreground">
                    {paramText(s.params)}
                  </div>
                )}
                {s.interval_seconds ? (
                  <div className="text-[11px] text-muted-foreground">
                    every {s.interval_seconds} s
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
      <PanelSection label="Apply log">
        {log.length === 0 ? (
          <span className="text-muted-foreground">Not applied yet.</span>
        ) : (
          <ul className="grid gap-2">
            {[...log].reverse().map((e) => (
              <li key={e.at} data-testid="prtg-apply-log">
                <div className="flex items-center gap-2">
                  <Badge variant={e.ok ? "success" : "destructive"}>
                    {e.ok ? "Applied" : "Failed"}
                  </Badge>
                  <TimeCell iso={e.at} />
                  <span className="text-[11px] text-muted-foreground">
                    {e.by}
                  </span>
                </div>
                <div className="mt-0.5 [overflow-wrap:anywhere]">
                  {e.issue ? (
                    <PrtgIssueLine issue={e.issue} className="" />
                  ) : (
                    e.detail
                  )}
                </div>
                {e.prtg && (
                  <div
                    className="mt-0.5 text-[11px] [overflow-wrap:anywhere] text-muted-foreground"
                    data-testid="prtg-apply-log-prtg"
                  >
                    PRTG said: {e.prtg}
                  </div>
                )}
                {e.steps.map((s) => (
                  <div key={s} className="text-[11px] text-muted-foreground">
                    {s}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </PanelShell>
  )
}

/** One plan row: the label, then its value left aligned and wrapping. */
function PlanText({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-2 py-0.5">
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 text-left text-[12px] [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  )
}

/** What a decision row is about: its reason, the PRTG device and the
 * Danbyte objects that contend for it, with their site and address. */
function DecisionDetail({ change: c }: { change: PrtgChange }) {
  const d = c.detail
  const remote = d.remote as PrtgDecisionRemote | undefined
  const candidates = (d.candidates as PrtgDecisionCandidate[] | undefined) ?? []
  const remotes = (d.remotes as PrtgDecisionRemote[] | undefined) ?? []
  return (
    <div className="grid gap-1 text-[13px]" data-testid="prtg-decision">
      <span className="text-muted-foreground">{String(d.reason ?? "")}</span>
      {remote && (
        <span>
          PRTG device <span className="font-medium">{remote.name}</span>{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {remote.host}
          </span>
        </span>
      )}
      {candidates.length > 0 && (
        <ul className="grid gap-0.5">
          {candidates.map((o) => (
            <li key={o.id} className="text-xs">
              <span className="font-medium">
                {o.kind === "virtual_machine" ? "VM " : ""}
                {o.name}
              </span>
              <span className="text-muted-foreground">
                {o.site ? ` · ${o.site}` : ""}
                {o.address ? ` · ${o.address}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {remotes.length > 0 && (
        <ul className="grid gap-0.5">
          {remotes.map((r) => (
            <li key={r.objid} className="text-xs">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · {r.host}
                {r.group ? ` · ${r.group}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The choices of a decision row, each applied at once. */
function DecisionActions({ change: c }: { change: PrtgChange }) {
  const qc = useQueryClient()
  const d = c.detail
  const owner = prtgParentName(c)
  const remote = d.remote as PrtgDecisionRemote | undefined
  const candidates = (d.candidates as PrtgDecisionCandidate[] | undefined) ?? []
  const remotes = (d.remotes as PrtgDecisionRemote[] | undefined) ?? []
  const decide = useMutation({
    mutationFn: (choice: Record<string, unknown>) =>
      api<{ ok: boolean; detail: string }>(
        `/api/prtg/changes/${c.id}/decide/`,
        {
          method: "POST",
          body: JSON.stringify(choice),
        }
      ),
    onSuccess: (r) => toast.success(r.detail),
    onError: (e) => apiErrorToast(e),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["prtg-changes"] })
      void qc.invalidateQueries({ queryKey: ["prtg-links"] })
      void qc.invalidateQueries({ queryKey: ["prtg-plan"] })
    },
  })
  const busy = decide.isPending
  return (
    <>
      {remote &&
        candidates.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => decide.mutate({ link: { kind: o.kind, id: o.id } })}
          >
            Link {remote.name} (PRTG) to {o.name}
          </Button>
        ))}
      {remotes.map((r) => (
        <Button
          key={r.objid}
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => decide.mutate({ remote: r.objid })}
        >
          Link {owner} to {r.name} (PRTG)
        </Button>
      ))}
      {c.decision?.can_create && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => decide.mutate({ create: true })}
        >
          {busy && decide.variables.create
            ? "Creating…"
            : `Create a separate PRTG device for ${owner}`}
        </Button>
      )}
    </>
  )
}
