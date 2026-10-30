import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Pencil, RotateCw, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceProfile,
  DeviceProfileAssignment,
  DeviceProfileEffectiveItem,
  DeviceProfileSectionKind,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { Loading } from "@/components/loading"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { TagList } from "@/components/cells/tag-list"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DeviceProfileDeleteDialog } from "@/components/device-profile-delete-dialog"
import {
  ASSIGN_ENDPOINT,
  PROFILES_ENDPOINT,
  UnassignProfileDialog,
  useInvalidateProfileWork,
  useReapplyProfile,
} from "@/components/device-profile-assign"
import {
  appliesToLabel,
  buildDeviceProfileAssignmentColumns,
  buildDeviceProfileColumns,
} from "@/components/columns/device-profile-columns"

export const Route = createFileRoute("/device-profiles/$id")({
  component: DeviceProfileDetail,
})

function DeviceProfileDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["device-profile", id],
    queryFn: () => api<DeviceProfile>(`${PROFILES_ENDPOINT}${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body profile={q.data} />
}

function Body({ profile: p }: { profile: DeviceProfile }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "assigned" | "children" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<DeviceProfile | null>(null)
  const goBack = useCallback(() => nav({ to: "/device-profiles" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/device-profiles"
      backLabel="Device profiles"
      title={p.name}
      presence={{ type: "deviceprofile", id: p.id }}
      actions={
        <>
          {canDo("deviceprofile", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/device-profiles/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("deviceprofile", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(p)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={p.name}
          subtitle={<span className="font-mono">{p.slug}</span>}
          description={p.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "assigned",
          label: "Assigned objects",
          count: p.assignment_count,
        },
        { value: "children", label: "Children", count: p.child_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <ProfileOverview profile={p} />
      </DetailTab>
      <DetailTab value="assigned">
        <AssignedObjects profileId={p.id} />
      </DetailTab>
      <DetailTab value="children">
        <Children profileId={p.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="profiles.deviceprofile" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="profiles.deviceprofile" objectId={p.id} />
      </DetailTab>
      <DeviceProfileDeleteDialog
        profile={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

const SECTIONS: { kind: DeviceProfileSectionKind; title: string }[] = [
  { kind: "application_group", title: "Application groups" },
  { kind: "tag", title: "Tags to add" },
  { kind: "custom_field", title: "Custom field values" },
  { kind: "platform", title: "Platform" },
]

function valueText(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (Array.isArray(v)) return v.join(", ")
  if (typeof v === "boolean") return v ? "Yes" : "No"
  return String(v)
}

/** "from <parent>" on an item the profile inherits. */
export function InheritedChip({ item }: { item: DeviceProfileEffectiveItem }) {
  if (!item.inherited) return null
  return (
    <Badge variant="secondary" className="font-normal">
      from {item.from}
    </Badge>
  )
}

/** The profile's facts, then one card per section with the effective items
 * - the parents' applied - each inherited one marked with where it is from. */
export function ProfileOverview({ profile: p }: { profile: DeviceProfile }) {
  const { humanIds } = useMe()
  const rows: KvRow[] = [
    ...(humanIds && p.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{p.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Slug", value: <span className="font-mono">{p.slug}</span> },
    {
      label: "Parent",
      value: p.parent ? (
        <Link
          to="/device-profiles/$id"
          params={{ id: p.parent.id }}
          className="inline-flex"
        >
          <ColorBadge
            name={p.parent.name}
            color={p.parent.color || undefined}
          />
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Applies to", value: appliesToLabel(p) },
    {
      label: "Assigned",
      value: <span className="num">{p.assignment_count}</span>,
    },
    {
      label: "Runbook",
      value: p.runbook_url ? (
        <a
          href={p.runbook_url}
          target="_blank"
          rel="noreferrer"
          className="link break-all"
        >
          {p.runbook_url}
        </a>
      ) : (
        dash
      ),
    },
    {
      label: "Tags",
      value: p.tags.length ? <TagList tags={p.tags} inline /> : dash,
    },
  ]
  const effective = p.effective
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-6">
        <KvCard title="Device profile" rows={rows} />
        {p.notes && (
          <section>
            <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
              Notes
            </h2>
            <div className="rounded-lg border border-border bg-card p-4 text-sm whitespace-pre-wrap">
              {p.notes}
            </div>
          </section>
        )}
      </div>
      <div className="min-w-0 space-y-6">
        {SECTIONS.map(({ kind, title }) => {
          const items = effective?.[kind] ?? []
          const columns: SimpleColumn<DeviceProfileEffectiveItem>[] = [
            {
              id: "item",
              header: kind === "custom_field" ? "Field" : "Item",
              cell: (i) =>
                kind === "custom_field" ? (
                  <span className="font-mono text-xs">{i.label}</span>
                ) : (
                  i.label
                ),
            },
            ...(kind === "custom_field"
              ? [
                  {
                    id: "value",
                    header: "Value",
                    cell: (i: DeviceProfileEffectiveItem) => valueText(i.value),
                  },
                ]
              : []),
            {
              id: "from",
              header: "",
              cell: (i) => <InheritedChip item={i} />,
            },
          ]
          return (
            <OverviewTable
              key={kind}
              title={title}
              count={items.length}
              columns={columns}
              data={items}
              getRowKey={(i) => `${i.from}:${i.label}`}
              footer={
                items.length === 0 ? (
                  <span className="text-muted-foreground">None.</span>
                ) : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}

/** The devices and VMs the profile is on, with their state, Re-apply,
 * Unassign and the same two in bulk. */
export function AssignedObjects({ profileId }: { profileId: string }) {
  const { canDo } = useMe()
  const canUnassign = canDo("deviceprofileassignment", "delete")
  const canReapply = canDo("deviceprofileassignment", "change")
  const invalidate = useInvalidateProfileWork()
  const reapply = useReapplyProfile()
  const [selected, setSelected] = useState<DeviceProfileAssignment[]>([])
  const [unassigning, setUnassigning] =
    useState<DeviceProfileAssignment | null>(null)
  const q = useQuery({
    queryKey: ["device-profile-assignments", "profile", profileId],
    queryFn: () =>
      apiAll<DeviceProfileAssignment>(
        `${ASSIGN_ENDPOINT}?profile=${profileId}`
      ),
  })
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const missing = rows.reduce((n, a) => n + a.missing_count, 0)
  const edited = rows.reduce((n, a) => n + a.edited_count, 0)

  const bulk = useMutation({
    mutationFn: async (op: "reapply" | "unassign") => {
      let done = 0
      for (const a of selected) {
        await (op === "reapply"
          ? api(`${ASSIGN_ENDPOINT}${a.id}/reapply/`, { method: "POST" })
          : api(`${ASSIGN_ENDPOINT}${a.id}/`, { method: "DELETE" }))
        done++
      }
      return { op, done }
    },
    onSuccess: ({ op, done }) => {
      toast.success(
        `${op === "reapply" ? "Re-applied on" : "Unassigned from"} ${done} ${
          done === 1 ? "object" : "objects"
        }`
      )
      setSelected([])
      invalidate()
    },
    onError: (err) => {
      apiErrorToast(err)
      invalidate()
    },
  })

  const columns = useMemo(
    () =>
      buildDeviceProfileAssignmentColumns({
        selection: canUnassign || canReapply,
        actions:
          canUnassign || canReapply
            ? {
                onDelete: canUnassign ? setUnassigning : undefined,
                deleteLabel: "Unassign",
                extra: canReapply
                  ? (a) => (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title="Re-apply"
                        disabled={reapply.isPending}
                        onClick={() => reapply.mutate(a)}
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        <span className="sr-only">Re-apply</span>
                      </Button>
                    )
                  : undefined,
              }
            : undefined,
      }),
    [canUnassign, canReapply, reapply]
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {missing > 0 && (
          <Badge variant="warning" className="num">
            {missing} missing
          </Badge>
        )}
        {edited > 0 && (
          <Badge variant="info" className="num">
            {edited} edited
          </Badge>
        )}
        {selected.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selected.length} selected
            </span>
            {canReapply && (
              <Button
                size="sm"
                variant="outline"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate("reapply")}
              >
                {bulk.isPending && bulk.variables === "reapply"
                  ? "Re-applying…"
                  : "Re-apply"}
              </Button>
            )}
            {canUnassign && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate("unassign")}
              >
                {bulk.isPending && bulk.variables === "unassign"
                  ? "Unassigning…"
                  : "Unassign"}
              </Button>
            )}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Not assigned to any device or VM." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="host"
          tableId="device-profile-assigned"
          embedded
          searchable
          searchPlaceholder="Search objects…"
          onSelectedRowsChange={
            canUnassign || canReapply ? setSelected : undefined
          }
          selectedRows={selected}
        />
      )}
      <UnassignProfileDialog
        assignment={unassigning}
        onOpenChange={(o) => !o && setUnassigning(null)}
      />
    </div>
  )
}

/** The profiles that inherit from this one. */
function Children({ profileId }: { profileId: string }) {
  const { humanIds } = useMe()
  const q = useQuery({
    queryKey: ["device-profiles", "children", profileId],
    queryFn: () =>
      apiAll<DeviceProfile>(`${PROFILES_ENDPOINT}?parent=${profileId}`),
  })
  const columns = useMemo(
    () => buildDeviceProfileColumns<DeviceProfile>({ humanIds }),
    [humanIds]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyState title="No child profiles." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="device-profile-children"
          embedded
        />
      )}
    </div>
  )
}
