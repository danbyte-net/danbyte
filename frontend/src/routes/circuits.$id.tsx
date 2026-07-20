import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import {
  api,
  type Circuit,
  type CircuitTermination,
  type CircuitTermSide,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { TagList } from "@/components/cells/tag-list"
import { CopyButton, KvCard, dash, type KvRow } from "@/components/kv-card"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { QueryError } from "@/components/query-error"
import { CircuitDeleteDialog } from "@/components/circuit-delete-dialog"
import { CircuitTerminationDialog } from "@/components/circuit-termination-dialog"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/circuits/$id")({
  component: CircuitDetail,
})

function CircuitDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["circuit", id],
    queryFn: () => api<Circuit>(`/api/circuits/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body circuit={q.data} />
}

function fmtKbps(kbps: number | null): React.ReactNode {
  if (kbps == null) return dash
  return <span className="num">{(kbps / 1000).toLocaleString()} Mbps</span>
}

function Body({ circuit: c }: { circuit: Circuit }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "terminations" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<Circuit | null>(null)
  const [termDialog, setTermDialog] = useState<{
    termination: CircuitTermination | null
    side: CircuitTermSide
  } | null>(null)
  const [deletingTerm, setDeletingTerm] = useState<CircuitTermination | null>(
    null
  )
  const goBack = useCallback(() => nav({ to: "/circuits" }), [nav])
  const canEditTerms = canDo("circuit", "change")

  return (
    <DetailShell
      backTo="/circuits"
      backLabel="Circuits"
      title={<span className="font-mono">{c.cid}</span>}
      presence={{ type: "circuit", id: c.id }}
      actions={
        <>
          {canDo("circuit", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/circuits/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("circuit", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(c)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-2xl font-semibold tracking-tight">
                  {c.cid}
                </span>
                {humanIds && c.numid != null && (
                  <span className="num font-mono text-sm text-muted-foreground">
                    #{c.numid}
                  </span>
                )}
                <StatusBadge status={c.status} />
              </div>
              {c.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={c.tags} />
                </div>
              )}
              {c.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {c.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Provider"
                value={
                  c.provider ? (
                    <Link
                      to="/providers"
                      className="text-primary hover:underline"
                    >
                      {c.provider.name}
                    </Link>
                  ) : (
                    dash
                  )
                }
              />
              <DetailStat
                label="Commit rate"
                value={fmtKbps(c.commit_rate_kbps)}
              />
            </dl>
          </section>

          <CustomFieldValues model="circuit" values={c.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "terminations",
          label: "Terminations",
          count: c.terminations.length,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <CircuitOverview circuit={c} />
      </DetailTab>
      <DetailTab value="terminations">
        <div className="grid gap-6 lg:grid-cols-2">
          {(["A", "Z"] as const).map((side) => (
            <TerminationCard
              key={side}
              side={side}
              termination={
                c.terminations.find((t) => t.term_side === side) ?? null
              }
              canEdit={canEditTerms}
              onAdd={() => setTermDialog({ termination: null, side })}
              onEdit={(t) => setTermDialog({ termination: t, side })}
              onDelete={setDeletingTerm}
            />
          ))}
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.circuit" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.circuit" objectId={c.id} />
      </DetailTab>

      <CircuitDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
      <CircuitTerminationDialog
        circuitId={c.id}
        termination={termDialog?.termination}
        presetSide={termDialog?.side}
        open={!!termDialog}
        onOpenChange={(o) => !o && setTermDialog(null)}
      />
      <TerminationDeleteDialog
        circuitId={c.id}
        termination={deletingTerm}
        onOpenChange={(o) => !o && setDeletingTerm(null)}
      />
    </DetailShell>
  )
}

/** The circuit's attributes grouped into labelled tables. */
function CircuitOverview({ circuit: c }: { circuit: Circuit }) {
  const circuitRows: KvRow[] = [
    {
      label: "Circuit ID",
      value: <span className="font-mono text-[13px]">{c.cid}</span>,
      copy: c.cid,
    },
    {
      label: "Provider",
      value: c.provider ? (
        <Link to="/providers" className="text-primary hover:underline">
          {c.provider.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Type",
      value: c.type ? (
        <ColorBadge name={c.type.name} color={c.type.color || undefined} />
      ) : (
        dash
      ),
    },
    { label: "Status", value: <StatusBadge status={c.status} /> },
  ]

  const serviceRows: KvRow[] = [
    {
      label: "Install date",
      value: c.install_date ? (
        <span className="num">{c.install_date}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Termination date",
      value: c.termination_date ? (
        <span className="num">{c.termination_date}</span>
      ) : (
        dash
      ),
    },
    { label: "Commit rate", value: fmtKbps(c.commit_rate_kbps) },
  ]

  const notesRows: KvRow[] = [
    { label: "Description", value: c.description || dash },
    {
      label: "Comments",
      value: c.comments ? (
        <span className="whitespace-pre-wrap">{c.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Circuit" rows={circuitRows} />
      <KvCard title="Service" rows={serviceRows} />
      <KvCard title="Notes" rows={notesRows} />
    </div>
  )
}

/** One side (A or Z) of the circuit — the endpoint and its cross-connect
 * details, or an empty state inviting the first termination. */
function TerminationCard({
  side,
  termination: t,
  canEdit,
  onAdd,
  onEdit,
  onDelete,
}: {
  side: CircuitTermSide
  termination: CircuitTermination | null
  canEdit: boolean
  onAdd: () => void
  onEdit: (t: CircuitTermination) => void
  onDelete: (t: CircuitTermination) => void
}) {
  if (!t) {
    return (
      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          {side} side
        </h2>
        <EmptyState title="Not terminated.">
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={onAdd}
              className="mt-2"
            >
              <Plus className="h-3.5 w-3.5" /> Add termination
            </Button>
          )}
        </EmptyState>
      </section>
    )
  }

  const rows: KvRow[] = [
    {
      label: "Endpoint",
      value: t.site ? (
        <Link
          to="/sites/$id"
          params={{ id: t.site.id }}
          className="text-primary hover:underline"
        >
          {t.site.name}
        </Link>
      ) : t.provider_network ? (
        <span>
          {t.provider_network.name}{" "}
          <span className="text-[11px] text-muted-foreground">
            provider network
          </span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Port speed", value: fmtKbps(t.port_speed_kbps) },
    { label: "Upstream speed", value: fmtKbps(t.upstream_speed_kbps) },
    {
      label: "Cross-connect",
      value: t.xconnect_id ? (
        <span className="font-mono text-[13px]">{t.xconnect_id}</span>
      ) : (
        dash
      ),
      copy: t.xconnect_id || undefined,
    },
    {
      label: "Patch panel / port",
      value: t.pp_info ? (
        <span className="font-mono text-[13px]">{t.pp_info}</span>
      ) : (
        dash
      ),
    },
    { label: "Description", value: t.description || dash },
  ]

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          {side} side
        </h2>
        {canEdit && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => onEdit(t)}
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => onDelete(t)}
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          </div>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow
                key={r.label}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="w-40 py-2 align-top text-xs text-muted-foreground">
                  {r.label}
                </TableCell>
                <TableCell className="py-2 text-[13px] text-foreground">
                  {r.value}
                </TableCell>
                <TableCell className="w-9 py-2 pr-2 text-right align-top">
                  {r.copy ? <CopyButton value={r.copy} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function TerminationDeleteDialog({
  circuitId,
  termination,
  onOpenChange,
}: {
  circuitId: string
  termination: CircuitTermination | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/circuit-terminations/${termination!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${termination!.term_side} side termination`)
      qc.invalidateQueries({ queryKey: ["circuit", circuitId] })
      qc.invalidateQueries({ queryKey: ["circuits"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!termination} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete the {termination?.term_side} side termination?
          </AlertDialogTitle>
          <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
