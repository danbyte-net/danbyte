import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  ApplicationGroup,
  ApplicationGroupAssignment,
  ApplicationGroupMember,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { PlanStaged, useSaveObject } from "@/lib/save-object"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormFooter, FormText, useFieldErrors } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { Loading } from "@/components/loading"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ApplicationPicker } from "@/components/application-picker"
import { ApplicationGroupDeleteDialog } from "@/components/application-group-delete-dialog"
import {
  AssignGroupDialog,
  UnassignGroupDialog,
  useInvalidateGroupWork,
} from "@/components/application-group-assign"
import {
  buildApplicationGroupAssignmentColumns,
  buildApplicationGroupMemberColumns,
} from "@/components/columns/application-group-columns"

export const Route = createFileRoute("/application-groups/$id")({
  component: ApplicationGroupDetail,
})

function ApplicationGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["application-group", id],
    queryFn: () => api<ApplicationGroup>(`/api/application-groups/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body group={q.data} />
}

function Body({ group }: { group: ApplicationGroup }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "members" | "hosts" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ApplicationGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/application-groups" }), [nav])
  const { canDo, humanIds } = useMe()

  const rows: KvRow[] = [
    ...(humanIds && group.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{group.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Slug", value: <span className="font-mono">{group.slug}</span> },
    {
      label: "Applications",
      value: <span className="num">{group.member_count}</span>,
    },
    { label: "Hosts", value: <span className="num">{group.host_count}</span> },
    {
      label: "Installs",
      value: <span className="num">{group.install_count}</span>,
    },
  ]

  return (
    <DetailShell
      backTo="/application-groups"
      backLabel="Application groups"
      title={group.name}
      presence={{ type: "applicationgroup", id: group.id }}
      actions={
        <>
          {canDo("applicationgroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/application-groups/$id/edit" params={{ id: group.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("applicationgroup", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(group)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={group.name}
          subtitle={<span className="font-mono">{group.slug}</span>}
          description={group.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "members", label: "Applications", count: group.member_count },
        { value: "hosts", label: "Hosts", count: group.host_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="max-w-xl space-y-6">
          <KvCard title="Application group" rows={rows} />
        </div>
      </DetailTab>
      <DetailTab value="members">
        <Members group={group} />
      </DetailTab>
      <DetailTab value="hosts">
        <Hosts groupId={group.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.applicationgroup" objectId={group.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.applicationgroup" objectId={group.id} />
      </DetailTab>
      <ApplicationGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

type MemberRow = { application_id: string; version: string }

const toRows = (members: ApplicationGroupMember[]): MemberRow[] =>
  members.map((m) => ({ application_id: m.application.id, version: m.version }))

/** The group's applications. Every change writes the whole ordered list;
 * the server installs, removes or re-versions on every assigned host. */
function Members({ group }: { group: ApplicationGroup }) {
  const qc = useQueryClient()
  const invalidate = useInvalidateGroupWork()
  const { canDo } = useMe()
  const canEdit = canDo("applicationgroup", "change")
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ApplicationGroupMember | null>(null)
  const members = group.members
  const saveObject = useSaveObject()

  const write = useMutation({
    mutationFn: (rows: MemberRow[]) =>
      saveObject<ApplicationGroup>({
        objectType: "api.applicationgroup",
        endpoint: "/api/application-groups/",
        id: group.id,
        payload: { members: rows },
      }),
    onSuccess: (saved) => {
      qc.setQueryData(["application-group", group.id], saved)
      invalidate()
    },
  })

  const move = useCallback(
    (m: ApplicationGroupMember, by: -1 | 1) => {
      const rows = toRows(members)
      const i = members.findIndex((x) => x.id === m.id)
      const j = i + by
      if (i < 0 || j < 0 || j >= rows.length) return
      ;[rows[i], rows[j]] = [rows[j], rows[i]]
      write.mutate(rows, {
        onError: (err) => {
          if (!(err instanceof PlanStaged)) apiErrorToast(err)
        },
      })
    },
    [members, write]
  )
  const remove = useCallback(
    (m: ApplicationGroupMember) =>
      write.mutate(
        toRows(members).filter((r) => r.application_id !== m.application.id),
        {
          onSuccess: () => toast.success(`Removed ${m.application.name}`),
          onError: (err) => {
            if (!(err instanceof PlanStaged)) apiErrorToast(err)
          },
        }
      ),
    [members, write]
  )

  const columns = useMemo(
    () =>
      buildApplicationGroupMemberColumns({
        actions: canEdit
          ? {
              onEdit: setEditing,
              onDelete: remove,
              deleteLabel: "Remove",
              extra: (m) => {
                const i = members.findIndex((x) => x.id === m.id)
                return (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title="Move up"
                      disabled={i <= 0 || write.isPending}
                      onClick={() => move(m, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      <span className="sr-only">Move up</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title="Move down"
                      disabled={i >= members.length - 1 || write.isPending}
                      onClick={() => move(m, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                      <span className="sr-only">Move down</span>
                    </Button>
                  </>
                )
              },
            }
          : undefined,
      }),
    [canEdit, members, move, remove, write.isPending]
  )

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add application
          </Button>
        </div>
      )}
      {members.length === 0 ? (
        <EmptyState title="No applications yet." />
      ) : (
        <DataTable
          data={members}
          columns={columns}
          flexColumn="application"
          tableId="application-group-members"
          embedded
        />
      )}
      <MemberDialog
        group={group}
        member={editing}
        open={adding || editing != null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSave={(rows) => write.mutateAsync(rows)}
      />
    </div>
  )
}

/** Add an application to the group, or change a member's version. */
function MemberDialog({
  group,
  member,
  open,
  onOpenChange,
  onSave,
}: {
  group: ApplicationGroup
  member: ApplicationGroupMember | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (rows: MemberRow[]) => Promise<unknown>
}) {
  const isEdit = !!member
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [version, setVersion] = useState("")

  useEffect(() => {
    if (!open) return
    setApplicationId(member?.application.id ?? null)
    setVersion(member?.version ?? "")
    reset()
  }, [open, member, reset])

  const save = useMutation({
    mutationFn: () => {
      const rows = toRows(group.members)
      if (member) {
        const row = rows.find((r) => r.application_id === member.application.id)
        if (row) row.version = version.trim()
      } else {
        rows.push({
          application_id: applicationId ?? "",
          version: version.trim(),
        })
      }
      return onSave(rows)
    },
    onSuccess: () => {
      toast.success(isEdit ? "Version saved" : "Application added")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${member.application.name}` : "Add application"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          {!isEdit && (
            <ApplicationPicker
              required
              value={applicationId}
              onChange={setApplicationId}
              excludeIds={group.members.map((m) => m.application.id)}
              error={fieldErrors.members}
            />
          )}
          <FormText
            label="Version"
            value={version}
            onChange={setVersion}
            mono
            placeholder="2022"
            error={isEdit ? fieldErrors.members : undefined}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add application"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The devices and VMs the group is assigned to, with Assign and Unassign. */
function Hosts({ groupId }: { groupId: string }) {
  const { canDo } = useMe()
  const canAssign = canDo("applicationgroupassignment", "add")
  const canUnassign = canDo("applicationgroupassignment", "delete")
  const [assigning, setAssigning] = useState(false)
  const [unassigning, setUnassigning] =
    useState<ApplicationGroupAssignment | null>(null)
  const q = useQuery({
    queryKey: ["application-group-assignments", "group", groupId],
    queryFn: () =>
      apiAll<ApplicationGroupAssignment>(
        `/api/application-group-assignments/?group=${groupId}`
      ),
  })
  const columns = useMemo(
    () =>
      buildApplicationGroupAssignmentColumns({
        actions: canUnassign
          ? { onDelete: setUnassigning, deleteLabel: "Unassign" }
          : undefined,
      }),
    [canUnassign]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      {canAssign && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAssigning(true)}>
            <Plus className="h-3.5 w-3.5" /> Assign
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Not assigned to any host." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="host"
          tableId="application-group-hosts"
          embedded
          searchable
          searchPlaceholder="Search hosts…"
        />
      )}
      <AssignGroupDialog
        group={{ id: groupId }}
        open={assigning}
        onOpenChange={setAssigning}
      />
      <UnassignGroupDialog
        assignment={unassigning}
        onOpenChange={(o) => !o && setUnassigning(null)}
      />
    </div>
  )
}
