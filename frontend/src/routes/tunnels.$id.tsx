import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { lazy, Suspense, useCallback, useState } from "react"
import { toast } from "sonner"

import { api, type Tunnel, type TunnelTermination } from "@/lib/api"
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
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { TunnelDeleteDialog } from "@/components/tunnel-delete-dialog"
import { TunnelTerminationDialog } from "@/components/tunnel-termination-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

// Lazy like the topology canvas — React Flow stays out of the main bundle.
const TunnelMap = lazy(() =>
  import("@/components/tunnels/tunnel-map").then((m) => ({
    default: m.TunnelMap,
  }))
)

export const Route = createFileRoute("/tunnels/$id")({
  component: TunnelDetail,
})

function TunnelDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["tunnel", id],
    queryFn: () => api<Tunnel>(`/api/tunnels/${id}/`),
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
  return <Body tunnel={q.data} />
}

function Body({ tunnel: t }: { tunnel: Tunnel }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "map" | "terminations" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Tunnel | null>(null)
  const goBack = useCallback(() => nav({ to: "/tunnels" }), [nav])

  return (
    <DetailShell
      backTo="/tunnels"
      backLabel="Tunnels"
      title={t.name}
      presence={{ type: "tunnel", id: t.id }}
      actions={
        <>
          {canDo("tunnel", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/tunnels/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("tunnel", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(t)}
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
                {t.name}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <StatusBadge status={t.status} />
              </div>
              {t.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={t.tags} />
                </div>
              )}
              {t.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {t.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Encapsulation"
                value={t.encapsulation_display}
              />
              <DetailStat
                label="Group"
                value={
                  t.group ? (
                    <Link
                      to="/tunnel-groups"
                      className="text-primary hover:underline"
                    >
                      {t.group.name}
                    </Link>
                  ) : (
                    dash
                  )
                }
              />
            </dl>
          </section>

          <CustomFieldValues model="tunnel" values={t.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "map", label: "Map" },
        {
          value: "terminations",
          label: "Terminations",
          count: t.terminations.length,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <TunnelOverview tunnel={t} />
      </DetailTab>
      <DetailTab value="map">
        <Suspense
          fallback={
            <div className="h-96 animate-pulse rounded-lg bg-muted/30" />
          }
        >
          <TunnelMap tunnel={t} />
        </Suspense>
      </DetailTab>
      <DetailTab value="terminations">
        <TerminationsTab tunnel={t} canEdit={canDo("tunnel", "change")} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.tunnel" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.tunnel" objectId={t.id} />
      </DetailTab>

      <TunnelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The tunnel's attributes, grouped into labelled tables. Only headline data
 * (name, status, encapsulation, group) stays up top; everything else reads
 * here. */
function TunnelOverview({ tunnel: t }: { tunnel: Tunnel }) {
  const { humanIds } = useMe()

  const attributes: KvRow[] = [
    ...(humanIds && t.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{t.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Status", value: <StatusBadge status={t.status} /> },
    { label: "Encapsulation", value: t.encapsulation_display },
    {
      label: "Tunnel ID",
      value:
        t.tunnel_id != null ? (
          <span className="num font-mono text-[13px]">{t.tunnel_id}</span>
        ) : (
          dash
        ),
    },
    {
      label: "Group",
      value: t.group ? (
        <Link to="/tunnel-groups" className="text-primary hover:underline">
          {t.group.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "IPSec profile", value: t.ipsec_profile?.name ?? dash },
  ]

  const notes: KvRow[] = [
    { label: "Description", value: t.description || dash },
    {
      label: "Comments",
      value: t.comments ? (
        <span className="whitespace-pre-wrap">{t.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Tunnel" rows={attributes} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}

/** Endpoint cell — device:interface (linked to the interface) or
 * VM:vm-interface (linked to the VM). */
function EndpointCell({ termination: t }: { termination: TunnelTermination }) {
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

function TerminationsTab({
  tunnel: t,
  canEdit,
}: {
  tunnel: Tunnel
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TunnelTermination | null>(null)
  const [deleting, setDeleting] = useState<TunnelTermination | null>(null)

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/tunnel-terminations/${deleting!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Termination removed")
      qc.invalidateQueries({ queryKey: ["tunnel", t.id] })
      qc.invalidateQueries({ queryKey: ["tunnels"] })
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
      {t.terminations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No terminations on this tunnel yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead className="w-full">Endpoint</TableHead>
                <TableHead>Outside IP</TableHead>
                {canEdit && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.terminations.map((term) => (
                <TableRow key={term.id}>
                  <TableCell className="py-2">
                    <Badge variant="secondary">{term.role_display}</Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    <EndpointCell termination={term} />
                  </TableCell>
                  <TableCell className="py-2">
                    {term.outside_ip ? (
                      <Link
                        to="/ips/$id"
                        params={{ id: term.outside_ip.id }}
                        className="font-mono text-[13px] text-primary hover:underline"
                      >
                        {term.outside_ip.ip_address}
                      </Link>
                    ) : (
                      dash
                    )}
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

      <TunnelTerminationDialog
        tunnelId={t.id}
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
              The endpoint is detached from the tunnel. This can't be undone.
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
