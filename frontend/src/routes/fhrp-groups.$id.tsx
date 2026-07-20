import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2, X } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type FHRPGroup, type Paginated } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { QueryError } from "@/components/query-error"
import { FhrpGroupDeleteDialog } from "@/components/fhrp-group-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/fhrp-groups/$id")({
  component: FhrpGroupDetail,
})

type IfacePick = {
  id: string
  name: string
  device: { id: string; name: string } | null
}

function FhrpGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["fhrp-group", id],
    queryFn: () => api<FHRPGroup>(`/api/fhrp-groups/${id}/`),
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
  return <Body group={q.data} />
}

function Body({ group: g }: { group: FHRPGroup }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "members" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<FHRPGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/fhrp-groups" }), [nav])
  const label = `${g.protocol_display} ${g.group_id}`
  const { canDo, humanIds } = useMe()

  return (
    <DetailShell
      backTo="/fhrp-groups"
      backLabel="FHRP groups"
      title={label}
      presence={{ type: "fhrpgroup", id: g.id }}
      actions={
        <>
          {canDo("fhrpgroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/fhrp-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("fhrpgroup", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight">
                {label}
              </span>
              {g.name && (
                <span className="text-sm text-muted-foreground">{g.name}</span>
              )}
            </div>
            {g.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={g.tags} />
              </div>
            )}
            {g.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {g.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Members"
              value={<span className="num">{g.assignment_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "members",
          label: "Members",
          count: g.assignment_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <FhrpGroupOverview group={g} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="members">
        <Members group={g} canManage={canDo("fhrpgroup", "change")} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.fhrpgroup" objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.fhrpgroup" objectId={g.id} />
      </DetailTab>

      <FhrpGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** FHRP group attributes that used to crowd the header, grouped into a table. */
function FhrpGroupOverview({
  group: g,
  humanIds,
}: {
  group: FHRPGroup
  humanIds: boolean
}) {
  const attributes: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Protocol", value: g.protocol_display },
    {
      label: "Group ID",
      value: <span className="num font-mono">{g.group_id}</span>,
    },
    {
      label: "Authentication",
      value: g.auth_type ? g.auth_type_display : "None",
    },
    {
      label: "Virtual IP",
      value: g.virtual_ip ? (
        <Link
          to="/ips/$id"
          params={{ id: g.virtual_ip.id }}
          className="font-mono text-[13px] text-primary hover:underline"
        >
          {g.virtual_ip.ip_address}
        </Link>
      ) : (
        dash
      ),
      copy: g.virtual_ip?.ip_address || undefined,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
    </div>
  )
}

function Members({
  group: g,
  canManage,
}: {
  group: FHRPGroup
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [ifaceId, setIfaceId] = useState<string | null>(null)
  const [priority, setPriority] = useState("100")

  const ifaces = useQuery({
    queryKey: ["interfaces-picker-fhrp"],
    queryFn: () => api<Paginated<IfacePick>>("/api/interfaces/?page_size=1000"),
    staleTime: 5 * 60_000,
  })

  const options = useMemo<ComboboxOption[]>(
    () =>
      (ifaces.data?.results ?? []).map((i) => ({
        value: i.id,
        label: i.device ? `${i.device.name} : ${i.name}` : i.name,
      })),
    [ifaces.data]
  )

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["fhrp-group", g.id] })
    qc.invalidateQueries({ queryKey: ["fhrp-groups"] })
  }

  const add = useMutation({
    mutationFn: () =>
      api(`/api/fhrp-assignments/`, {
        method: "POST",
        body: JSON.stringify({
          fhrp_group_id: g.id,
          interface_id: ifaceId,
          priority: Number(priority) || 100,
        }),
      }),
    onSuccess: () => {
      toast.success("Member added")
      setIfaceId(null)
      setPriority("100")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const remove = useMutation({
    mutationFn: (aid: string) =>
      api<void>(`/api/fhrp-assignments/${aid}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Member removed")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <div className="max-w-2xl">
      {g.assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No interfaces are members of this group yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {g.assignments.map((a) => {
            const target = a.interface
              ? `${a.interface.device.name} : ${a.interface.name}`
              : a.vm_interface
                ? `${a.vm_interface.vm.name} : ${a.vm_interface.name}`
                : "—"
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 px-3 py-2 text-[13px]"
              >
                <span className="font-mono">{target}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  priority <span className="num">{a.priority}</span>
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => remove.mutate(a.id)}
                    disabled={remove.isPending}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                    aria-label="Remove member"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canManage && (
        <div className="mt-3 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Combobox
              value={ifaceId}
              onChange={setIfaceId}
              options={options}
              placeholder="Add an interface…"
              searchPlaceholder="Search interfaces…"
            />
          </div>
          <Input
            type="number"
            min={0}
            max={255}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-20 font-mono"
            aria-label="Priority"
          />
          <Button
            type="button"
            size="sm"
            disabled={!ifaceId || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      )}
    </div>
  )
}
