import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { api, type L2VPN, type L2VPNTermination } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { L2vpnDeleteDialog } from "@/components/l2vpn-delete-dialog"
import { L2vpnTerminationDialog } from "@/components/l2vpn-termination-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/l2vpns/$id")({
  component: L2vpnDetail,
})

function L2vpnDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["l2vpn", id],
    queryFn: () => api<L2VPN>(`/api/l2vpns/${id}/`),
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
  return <Body l2vpn={q.data} />
}

function Body({ l2vpn: v }: { l2vpn: L2VPN }) {
  const [tab, setTab] = useState<
    "overview" | "terminations" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<L2VPN | null>(null)
  const goBack = useCallback(() => nav({ to: "/l2vpns" }), [nav])

  return (
    <DetailShell
      backTo="/l2vpns"
      backLabel="L2VPNs"
      title={v.name}
      presence={{ type: "l2vpn", id: v.id }}
      actions={
        <>
          {canDo("l2vpn", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/l2vpns/$id/edit" params={{ id: v.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("l2vpn", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(v)}
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
              <div className="text-2xl font-semibold tracking-tight">
                {v.name}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <StatusBadge status={v.status} />
              </div>
              {v.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={v.tags} />
                </div>
              )}
              {v.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {v.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat label="Type" value={v.type_display} />
              <DetailStat
                label="Identifier"
                value={
                  v.identifier != null ? (
                    <span className="num font-mono">{v.identifier}</span>
                  ) : (
                    dash
                  )
                }
              />
            </dl>
          </section>

          <CustomFieldValues model="l2vpn" values={v.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "terminations",
          label: "Terminations",
          count: v.terminations.length,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(t) => setTab(t as typeof tab)}
    >
      <DetailTab value="overview">
        <L2vpnOverview l2vpn={v} />
      </DetailTab>
      <DetailTab value="terminations">
        <TerminationsTab l2vpn={v} canEdit={canDo("l2vpn", "change")} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.l2vpn" objectId={v.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.l2vpn" objectId={v.id} />
      </DetailTab>

      <L2vpnDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Route-target names, one per line, monospace — or a dash when empty. */
function RtList({ rts }: { rts: { id: string; name: string }[] }) {
  if (rts.length === 0) return dash
  return (
    <div className="grid gap-0.5">
      {rts.map((rt) => (
        <span key={rt.id} className="font-mono text-[13px]">
          {rt.name}
        </span>
      ))}
    </div>
  )
}

/** The L2VPN's attributes, grouped into labelled tables. Only headline data
 * (name, status, type, identifier) stays up top; everything else reads
 * here. */
function L2vpnOverview({ l2vpn: v }: { l2vpn: L2VPN }) {
  const { humanIds } = useMe()

  const attributes: KvRow[] = [
    ...(humanIds && v.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{v.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Type", value: v.type_display },
    {
      label: "Identifier",
      value:
        v.identifier != null ? (
          <span className="num font-mono text-[13px]">{v.identifier}</span>
        ) : (
          dash
        ),
    },
    { label: "Status", value: <StatusBadge status={v.status} /> },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{v.slug}</span>,
    },
    { label: "Import targets", value: <RtList rts={v.import_targets} /> },
    { label: "Export targets", value: <RtList rts={v.export_targets} /> },
  ]

  const notes: KvRow[] = [
    { label: "Description", value: v.description || dash },
    {
      label: "Comments",
      value: v.comments ? (
        <span className="whitespace-pre-wrap">{v.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="L2VPN" rows={attributes} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}

/** Endpoint cell — a VLAN badge ("vid · name", linked to the VLAN),
 * device:interface (linked to the interface), or VM:vm-interface (linked to
 * the VM). */
function EndpointCell({ termination: t }: { termination: L2VPNTermination }) {
  if (t.vlan) {
    return (
      <Link to="/vlans/$id" params={{ id: t.vlan.id }}>
        <Badge variant="secondary" className="font-mono text-[11px]">
          {t.vlan.vlan_id} · {t.vlan.name}
        </Badge>
      </Link>
    )
  }
  if (t.interface) {
    return (
      <Link
        to="/interfaces/$id"
        params={{ id: t.interface.id }}
        className="font-mono text-[13px] text-primary hover:underline"
      >
        {t.interface.device.name}:{t.interface.name}
      </Link>
    )
  }
  if (t.vm_interface) {
    return (
      <Link
        to="/virtual-machines/$id"
        params={{ id: t.vm_interface.vm.id }}
        className="font-mono text-[13px] text-primary hover:underline"
      >
        {t.vm_interface.vm.name}:{t.vm_interface.name}
      </Link>
    )
  }
  return dash
}

function terminationKind(t: L2VPNTermination): string {
  if (t.vlan) return "VLAN"
  if (t.interface) return "Interface"
  if (t.vm_interface) return "VM interface"
  return "—"
}

function TerminationsTab({
  l2vpn: v,
  canEdit,
}: {
  l2vpn: L2VPN
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<L2VPNTermination | null>(null)
  const [deleting, setDeleting] = useState<L2VPNTermination | null>(null)

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/l2vpn-terminations/${deleting!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Termination removed")
      qc.invalidateQueries({ queryKey: ["l2vpn", v.id] })
      qc.invalidateQueries({ queryKey: ["l2vpns"] })
      setDeleting(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex items-center justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            + Add termination
          </Button>
        </div>
      )}
      {v.terminations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No terminations on this L2VPN yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead className="w-full">Endpoint</TableHead>
                {canEdit && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {v.terminations.map((term) => (
                <TableRow key={term.id}>
                  <TableCell className="py-2">
                    <Badge variant="secondary">{terminationKind(term)}</Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    <EndpointCell termination={term} />
                  </TableCell>
                  {canEdit && (
                    <TableCell className="py-1 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label="Edit termination"
                        onClick={() => {
                          setEditing(term)
                          setDialogOpen(true)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        aria-label="Delete termination"
                        onClick={() => setDeleting(term)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <L2vpnTerminationDialog
        l2vpnId={v.id}
        termination={editing}
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setEditing(null)
        }}
      />

      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this termination?</AlertDialogTitle>
            <AlertDialogDescription>
              The endpoint is detached from the L2VPN. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault()
                del.mutate()
              }}
            >
              {del.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
