import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Crown, Pencil, Plus, Trash2, Unlink } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  api,
  type Interface,
  type Device,
  type VirtualChassis,
  type VirtualChassisMember,
} from "@/lib/api"
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
import { KvCard, dash, mono, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { VirtualChassisDeleteDialog } from "@/components/virtual-chassis-delete-dialog"
import { FaceplateLegend } from "@/components/device-faceplate"
import { StackElevation } from "@/components/stack-elevation"
import {
  StackInterfacesTable,
  useStackInterfaces,
} from "@/components/vc-stack-interfaces"
import { AssignIpDialog } from "@/components/assign-ip-dialog"
import type { AssignIpTarget } from "@/components/assign-ip-dialog"
import {
  InterfaceTraceDialog,
  type TraceTarget,
} from "@/components/interface-trace-dialog"
import { VcAddMemberDialog } from "@/components/vc-add-member-dialog"
import { VcMembershipDialog } from "@/components/vc-membership-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/virtual-chassis/$id")({
  component: VirtualChassisDetail,
})

function VirtualChassisDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["virtual-chassis", id],
    queryFn: () => api<VirtualChassis>(`/api/virtual-chassis/${id}/`),
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
  return <Body vc={q.data} />
}

/** Members sorted the way a stack reads: position first, then name. */
function sortMembers(members: VirtualChassisMember[]): VirtualChassisMember[] {
  return [...members].sort((a, b) => {
    const pa = a.vc_position ?? Number.MAX_SAFE_INTEGER
    const pb = b.vc_position ?? Number.MAX_SAFE_INTEGER
    return pa - pb || a.name.localeCompare(b.name)
  })
}

function Body({ vc }: { vc: VirtualChassis }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "interfaces" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<VirtualChassis | null>(null)
  const goBack = useCallback(() => nav({ to: "/virtual-chassis" }), [nav])
  const members = useMemo(() => sortMembers(vc.members), [vc.members])
  const stackIfaces = useStackInterfaces(members)
  // Same row actions (and the dialogs behind them) as the device page's
  // interfaces table — the stack table must look and behave identically here.
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const [traceTarget, setTraceTarget] = useState<TraceTarget | null>(null)
  // Plain object: StackInterfacesTable memoises its columns on these primitives
  // (and the stable setters), so it doesn't need a stable object identity.
  const ifaceActions = {
    canAddIp: canDo("ipaddress", "add"),
    canAssignIp: canDo("ipaddress", "change"),
    canEdit: canDo("interface", "change"),
    canChangeCable: canDo("cable", "change"),
    canConnect: canDo("cable", "add"),
    onTrace: setTraceTarget,
    onAssignIp: setAssignTarget,
  }
  // Per-member interface lists feed the faceplates in the stack drawing.
  const ifacesByMember = useMemo(() => {
    const map = new Map<string, Interface[]>()
    for (const { member, iface } of stackIfaces.rows) {
      const list = map.get(member.id)
      if (list) list.push(iface)
      else map.set(member.id, [iface])
    }
    return map
  }, [stackIfaces.rows])

  return (
    <DetailShell
      backTo="/virtual-chassis"
      backLabel="Virtual chassis"
      title={vc.name}
      presence={{ type: "virtualchassis", id: vc.id }}
      actions={
        <>
          {canDo("virtualchassis", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/virtual-chassis/$id/edit" params={{ id: vc.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("virtualchassis", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(vc)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="text-2xl font-semibold tracking-tight">
              {vc.name}
            </div>
            {vc.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={vc.tags} />
              </div>
            )}
            {vc.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {vc.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Master"
              value={
                vc.master ? (
                  <Link
                    to="/devices/$id"
                    params={{ id: vc.master.id }}
                    className="font-mono text-[13px] text-primary hover:underline"
                  >
                    {vc.master.name}
                  </Link>
                ) : (
                  dash
                )
              }
            />
            <DetailStat
              label="Members"
              value={<span className="num">{vc.member_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "interfaces",
          label: "Interfaces",
          count: stackIfaces.count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <Overview vc={vc} members={members} ifacesByMember={ifacesByMember} />
      </DetailTab>
      <DetailTab value="interfaces">
        <StackInterfacesTable
          rows={stackIfaces.rows}
          loading={stackIfaces.loading}
          error={stackIfaces.error}
          actions={ifaceActions}
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualchassis" objectId={vc.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualchassis" objectId={vc.id} />
      </DetailTab>

      <VirtualChassisDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
      {/* Behind the interface row actions — same pair the device page renders. */}
      <AssignIpDialog
        target={assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />
      <InterfaceTraceDialog
        target={traceTarget}
        onOpenChange={(o) => !o && setTraceTarget(null)}
      />
    </DetailShell>
  )
}

function Overview({
  vc,
  members,
  ifacesByMember,
}: {
  vc: VirtualChassis
  members: VirtualChassisMember[]
  ifacesByMember: Map<string, Interface[]>
}) {
  const { humanIds } = useMe()

  const attributes: KvRow[] = [
    ...(humanIds && vc.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{vc.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: vc.name },
    { label: "Domain", value: mono(vc.domain), copy: vc.domain || undefined },
    {
      label: "Master",
      value: vc.master ? (
        <Link
          to="/devices/$id"
          params={{ id: vc.master.id }}
          className="font-mono text-[13px] text-primary hover:underline"
        >
          {vc.master.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Members",
      value: <span className="num">{vc.member_count}</span>,
    },
  ]

  const notes: KvRow[] = [
    { label: "Description", value: vc.description || dash },
    {
      label: "Comments",
      value: vc.comments ? (
        <span className="whitespace-pre-wrap">{vc.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Stack
          </h2>
          <StackElevation
            members={members}
            masterId={vc.master?.id ?? null}
            interfacesByMember={ifacesByMember}
          />
          <FaceplateLegend className="mt-2" />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {vc.member_count} member{vc.member_count === 1 ? "" : "s"}
            {vc.master ? <> · master {vc.master.name}</> : null}
            {vc.domain ? (
              <>
                {" "}
                · domain <span className="font-mono">{vc.domain}</span>
              </>
            ) : null}
          </p>
        </section>
        <div className="grid content-start gap-6">
          <KvCard title="Virtual chassis" rows={attributes} />
          <KvCard title="Notes" rows={notes} />
        </div>
      </div>
      <MembersTable vc={vc} members={members} />
    </div>
  )
}

function MembersTable({
  vc,
  members,
}: {
  vc: VirtualChassis
  members: VirtualChassisMember[]
}) {
  const { canDo } = useMe()
  const canEditDevice = canDo("device", "change")
  const canEditVc = canDo("virtualchassis", "change")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<VirtualChassisMember | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<VirtualChassisMember | null>(null)
  // Next free slot: one past the highest taken position (1 for an empty stack).
  const nextPosition =
    members.reduce((max, m) => Math.max(max, m.vc_position ?? 0), 0) + 1

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["virtual-chassis", vc.id] })
    qc.invalidateQueries({ queryKey: ["virtual-chassis"] })
    qc.invalidateQueries({ queryKey: ["devices"] })
  }

  // Leaving the stack is a device write — membership lives on the Device.
  const remove = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${removing!.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          virtual_chassis_id: null,
          vc_position: null,
          vc_priority: null,
        }),
      }),
    onSuccess: (saved) => {
      toast.success(`${saved.name} removed from stack`)
      invalidate()
      qc.invalidateQueries({ queryKey: ["device", saved.id] })
      setRemoving(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  const setMaster = useMutation({
    mutationFn: (memberId: string) =>
      api<VirtualChassis>(`/api/virtual-chassis/${vc.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ master_id: memberId }),
      }),
    onSuccess: () => {
      toast.success("Master updated")
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Members
        </h2>
        {canEditDevice && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" /> Add member
          </Button>
        )}
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No members yet.{" "}
          {canEditDevice
            ? "Add one with the button above, or from a device's own edit form (Stack membership)."
            : "Devices join from their own edit form (Stack membership)."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead className="w-full">Device</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Status</TableHead>
                {(canEditDevice || canEditVc) && <TableHead className="w-28" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="py-2">
                    {m.vc_position != null ? (
                      <span className="num font-mono text-[13px]">
                        {m.vc_position}
                      </span>
                    ) : (
                      dash
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    <Link
                      to="/devices/$id"
                      params={{ id: m.id }}
                      className="font-mono text-[13px] text-primary hover:underline"
                    >
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell className="py-2">
                    {m.vc_priority != null ? (
                      <span className="num font-mono text-[13px]">
                        {m.vc_priority}
                      </span>
                    ) : (
                      dash
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    {m.is_master ? (
                      <Badge variant="info">Master</Badge>
                    ) : (
                      <Badge variant="secondary">Member</Badge>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    {mono(m.serial_number)}
                  </TableCell>
                  <TableCell className="py-2">
                    <StatusBadge status={m.status} />
                  </TableCell>
                  {(canEditDevice || canEditVc) && (
                    <TableCell className="py-1 text-right whitespace-nowrap">
                      {canEditVc && !m.is_master && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label="Set as master"
                          title="Set as master"
                          disabled={setMaster.isPending}
                          onClick={() => setMaster.mutate(m.id)}
                        >
                          <Crown className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canEditDevice && (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label="Edit membership"
                            title="Edit membership"
                            onClick={() => {
                              setEditing(m)
                              setDialogOpen(true)
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            aria-label="Remove from stack"
                            title="Remove from stack"
                            onClick={() => setRemoving(m)}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <VcAddMemberDialog
        chassisId={vc.id}
        memberIds={members.map((m) => m.id)}
        suggestedPosition={nextPosition}
        open={adding}
        onOpenChange={setAdding}
      />
      <VcMembershipDialog
        chassisId={vc.id}
        member={editing}
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setEditing(null)
        }}
      />

      <AlertDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name} from this stack?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The device stays; only its stack membership, position and priority
              are cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault()
                remove.mutate()
              }}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
