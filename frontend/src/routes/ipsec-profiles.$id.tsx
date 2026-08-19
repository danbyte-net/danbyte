import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { IPSecProfile } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { IPSecProfileDeleteDialog } from "@/components/ipsec-profile-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { EmbeddedTunnelTable } from "@/components/embedded-tables"

export const Route = createFileRoute("/ipsec-profiles/$id")({
  component: IPSecProfileDetail,
})

function IPSecProfileDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["ipsec-profile", id],
    queryFn: () => api<IPSecProfile>(`/api/ipsec-profiles/${id}/`),
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
  return <Body profile={q.data} />
}

function Body({ profile: p }: { profile: IPSecProfile }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "tunnels" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<IPSecProfile | null>(null)
  const goBack = useCallback(() => nav({ to: "/ipsec-profiles" }), [nav])

  return (
    <DetailShell
      backTo="/ipsec-profiles"
      backLabel="IPSec profiles"
      title={p.name}
      presence={{ type: "ipsecprofile", id: p.id }}
      actions={
        <>
          {canDo("ipsecprofile", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ipsec-profiles/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("ipsecprofile", "delete") && (
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
          subtitle={
            <span className="font-mono">
              {p.ike_version_display} · {p.encryption_display} ·{" "}
              {p.authentication_display}
            </span>
          }
          description={p.description}
          statCols={1}
          stats={
            <DetailStat
              label="Tunnels"
              value={<span className="num">{p.tunnel_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "tunnels", label: "Tunnels", count: p.tunnel_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <IPSecProfileOverview profile={p} />
      </DetailTab>
      <DetailTab value="tunnels">
        <EmbeddedTunnelTable
          filter={{ ipsec_profile: p.id }}
          omitProfile
          emptyText="No tunnels use this profile yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.ipsecprofile" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.ipsecprofile" objectId={p.id} />
      </DetailTab>

      <IPSecProfileDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The crypto parameters, which are the whole point of the object - read them
 * here before you change a profile that tunnels already depend on. */
function IPSecProfileOverview({ profile: p }: { profile: IPSecProfile }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && p.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{p.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: p.name, copy: p.name },
    { label: "Description", value: p.description || dash },
    { label: "Tunnels", value: <span className="num">{p.tunnel_count}</span> },
  ]

  const crypto: KvRow[] = [
    { label: "IKE version", value: p.ike_version_display },
    {
      label: "Encryption",
      value: (
        <span className="font-mono text-[13px]">{p.encryption_display}</span>
      ),
    },
    {
      label: "Authentication",
      value: (
        <span className="font-mono text-[13px]">
          {p.authentication_display}
        </span>
      ),
    },
    { label: "DH group", value: <span className="num">{p.dh_group}</span> },
    {
      label: "PFS group",
      value:
        p.pfs_group != null ? <span className="num">{p.pfs_group}</span> : dash,
    },
    {
      label: "SA lifetime",
      value:
        p.sa_lifetime != null ? (
          <span className="num">{p.sa_lifetime.toLocaleString()} s</span>
        ) : (
          dash
        ),
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={p.created_at} /> },
    { label: "Updated", value: <TimeCell iso={p.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Profile" rows={details} />
      <KvCard title="Crypto" rows={crypto} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
