import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftRight, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { BGPSession } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { sessionNeighbor } from "@/components/columns/routing-columns"
import { knobRows, remoteAsnText } from "@/components/routing/bgp-bits"
import { RoutingDeleteDialog } from "@/components/routing/catalog-page"

export const Route = createFileRoute("/bgp-sessions/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["bgp-session", id],
    queryFn: () => api<BGPSession>(`/api/routing/bgp-sessions/${id}/`),
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
  return <Body s={q.data} />
}

function Body({ s }: { s: BGPSession }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const qc = useQueryClient()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<BGPSession | null>(null)
  const goBack = useCallback(() => nav({ to: "/bgp-sessions" }), [nav])
  const neighbor = sessionNeighbor(s)
  const eff = s.effective

  // The mirror session on the peer device, one click - needs the peer
  // device, this side's local address and a far address IPAM knows.
  const createPeer = useMutation({
    mutationFn: () =>
      api<BGPSession>(`/api/routing/bgp-sessions/${s.id}/create-peer/`, {
        method: "POST",
      }),
    onSuccess: (mirror) => {
      toast.success(`Created the far end on ${mirror.instance.device.name}`)
      qc.invalidateQueries({ queryKey: ["bgp-session", s.id] })
      qc.invalidateQueries({ queryKey: ["bgp-sessions"] })
    },
    onError: (e) => apiErrorToast(e, "Couldn't create the far end"),
  })
  const canPair =
    !s.peer_session &&
    !!s.peer_device &&
    !!s.local_address &&
    !!s.remote_address

  const identity: KvRow[] = [
    ...(humanIds && s.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{s.numid}</span>,
          },
        ]
      : []),
    { label: "Name", value: s.name || dash },
    {
      label: "Device",
      value: (
        <Link
          to="/devices/$id"
          params={{ id: s.instance.device.id }}
          search={{ tab: "routing" }}
          className="link"
        >
          {s.instance.device.name}
        </Link>
      ),
    },
    {
      label: "Instance",
      value: (
        <span className="font-mono">
          AS{s.instance.asn.asn} ·{" "}
          {s.instance.vrf ? (
            <ColorBadge
              name={s.instance.vrf.name}
              color={s.instance.vrf.color}
            />
          ) : (
            "global"
          )}
        </span>
      ),
    },
    {
      label: "Peer group",
      value: s.peer_group ? (
        <Link
          to="/bgp-peer-groups/$id"
          params={{ id: s.peer_group.id }}
          className="link font-mono"
        >
          {s.peer_group.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Status", value: <StatusBadge status={s.status} /> },
    { label: "Description", value: s.description || dash },
  ]
  const ends: KvRow[] = [
    {
      label: "Local address",
      value: s.local_address ? (
        <Link
          to="/ips/$id"
          params={{ id: s.local_address.id }}
          className="link font-mono"
        >
          {s.local_address.ip_address}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Update source",
      value: eff.update_source ? (
        <span className="font-mono">{eff.update_source}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Local AS",
      value: <span className="num font-mono">{eff.local_asn}</span>,
    },
    {
      label: s.interface ? "Interface" : "Remote address",
      value: s.interface ? (
        <Link
          to="/interfaces/$id"
          params={{ id: s.interface.id }}
          className="link font-mono"
        >
          {s.interface.name}
        </Link>
      ) : s.remote_address_obj ? (
        <Link
          to="/ips/$id"
          params={{ id: s.remote_address_obj.id }}
          className="link font-mono"
        >
          {s.remote_address}
        </Link>
      ) : (
        <span className="font-mono">{s.remote_address}</span>
      ),
    },
    {
      label: "Remote AS",
      value: (
        <span className="num font-mono">{remoteAsnText(eff) || dash}</span>
      ),
    },
    {
      label: "Peer device",
      value: s.peer_device ? (
        <Link
          to="/devices/$id"
          params={{ id: s.peer_device.id }}
          search={{ tab: "routing" }}
          className="link"
        >
          {s.peer_device.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Far end",
      value: s.peer_session ? (
        <Link
          to="/bgp-sessions/$id"
          params={{ id: s.peer_session.id }}
          className="link"
        >
          session on {s.peer_session.device.name}
        </Link>
      ) : canPair && canDo("bgpsession", "add") ? (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={createPeer.isPending}
          onClick={() => createPeer.mutate()}
        >
          <ArrowLeftRight className="h-3 w-3" />
          {createPeer.isPending ? "Creating…" : "Create the far end"}
        </Button>
      ) : (
        <span className="text-muted-foreground">Not paired</span>
      ),
    },
  ]
  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={s.created_at} /> },
    { label: "Updated", value: <TimeCell iso={s.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo="/bgp-sessions"
      backLabel="BGP sessions"
      title={neighbor}
      presence={{ type: "bgpsession", id: s.id }}
      actions={
        <>
          {canDo("bgpsession", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/bgp-sessions/$id/edit" params={{ id: s.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("bgpsession", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(s)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={neighbor}
          mono
          badges={<StatusBadge status={s.status} />}
          subtitle={
            <span className="font-mono">
              {s.instance.device.name} · AS{eff.local_asn} → AS
              {remoteAsnText(eff) || "?"}
              {s.peer_group ? ` · ${s.peer_group.name}` : ""}
            </span>
          }
          description={s.description}
          tags={s.tags.length ? <TagList tags={s.tags} /> : undefined}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Session" rows={identity} />
          <KvCard title="Ends" rows={ends} />
          <KvCard title="Effective settings" rows={knobRows(eff, "-")} />
          <KvCard title="Own values" rows={knobRows(s, "Inherit")} />
          <KvCard title="Record" rows={record} />
          <CustomFieldValues
            model="bgpsession"
            values={s.custom_fields}
            layout="cards"
          />
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="routing.bgpsession" objectId={s.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="routing.bgpsession" objectId={s.id} />
      </DetailTab>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/bgp-sessions/"
        queryKey="bgp-sessions"
        label={(x) => sessionNeighbor(x)}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
