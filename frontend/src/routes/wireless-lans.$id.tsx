import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { WirelessLAN } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import { WirelessLANDeleteDialog } from "@/components/wireless-lan-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { RevealPskButton } from "@/components/reveal-psk-button"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VlanBadge } from "@/components/cells/vlan-badge"

const OBJECT_TYPE = "api.wirelesslan"

// A WLAN has no reverse relations - nothing in the model points back at it.
// The honest page is therefore Overview + Journal + History: its own attributes,
// links out to the group and VLAN it belongs to, and the change log that has
// been recorded since the model was audited but had nowhere to show.
type Tab = "overview" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "journal", "history"]

export const Route = createFileRoute("/wireless-lans/$id")({
  component: WirelessLANDetail,
})

function WirelessLANDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["wireless-lan", id],
    queryFn: () => api<WirelessLAN>(`/api/wireless-lans/${id}/`),
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
  return <Body wlan={q.data} />
}

function Body({ wlan: w }: { wlan: WirelessLAN }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<WirelessLAN | null>(null)
  const goBack = useCallback(() => nav({ to: "/wireless-lans" }), [nav])

  return (
    <DetailShell
      backTo="/wireless-lans"
      backLabel="Wireless LANs"
      title={w.ssid}
      presence={{ type: "wirelesslan", id: w.id }}
      actions={
        <>
          {canDo("wirelesslan", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/wireless-lans/$id/edit" params={{ id: w.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("wirelesslan", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(w)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={w.ssid}
            mono
            badges={<StatusBadge status={w.status} />}
            subtitle={
              w.group ? (
                <Link
                  to="/wireless-lan-groups/$id"
                  params={{ id: w.group.id }}
                  className="link"
                >
                  {w.group.name}
                </Link>
              ) : undefined
            }
            tags={w.tags.length > 0 && <TagList tags={w.tags} />}
            description={w.description}
          />
          <CustomFieldValues model="wirelesslan" values={w.custom_fields} />
        </>
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
        <WlanOverview wlan={w} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={w.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={w.id} />
      </DetailTab>

      <WirelessLANDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** "Stored" plus a reveal button, or a plain "Not set". The key itself is
 * never in the page payload - revealing is a separate, audited request that
 * needs the `reveal` grant on wireless LANs (#68). */
function PskRow({ lan }: { lan: WirelessLAN }) {
  const { canDo } = useMe()
  if (!lan.psk_set) return <span className="text-muted-foreground">Not set</span>
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-[13px]">••••••••</span>
      {canDo("wirelesslan", "reveal") && <RevealPskButton id={lan.id} />}
    </span>
  )
}

function WlanOverview({ wlan: w }: { wlan: WirelessLAN }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && w.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{w.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "SSID",
      value: <span className="font-mono text-[13px]">{w.ssid}</span>,
      copy: w.ssid,
    },
    { label: "Status", value: <StatusBadge status={w.status} /> },
    {
      label: "Group",
      value: w.group ? (
        <Link
          to="/wireless-lan-groups/$id"
          params={{ id: w.group.id }}
          className="link"
        >
          {w.group.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Description",
      value: w.description ? (
        <span className="whitespace-pre-wrap">{w.description}</span>
      ) : (
        dash
      ),
    },
  ]

  // What the SSID is bridged to, and how a client authenticates onto it - the
  // two things you actually come to this page to read.
  const network: KvRow[] = [
    {
      label: "VLAN",
      value: w.vlan ? (
        <Link
          to="/vlans/$id"
          params={{ id: w.vlan.id }}
          className="link"
        >
          <VlanBadge vlan={w.vlan} />
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Authentication",
      value: w.auth_type ? w.auth_type_display : dash,
    },
    {
      label: "Cipher",
      value: w.auth_cipher ? (
        <span className="font-mono text-[13px]">
          {w.auth_cipher.toUpperCase()}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Pre-shared key",
      value: <PskRow lan={w} />,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={w.created_at} /> },
    { label: "Updated", value: <TimeCell iso={w.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Wireless LAN" rows={details} />
        <KvCard title="Network" rows={network} />
        <KvCard title="Record" rows={record} />
      </div>

      {w.comments && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Comments
          </h2>
          <p className="rounded-lg border border-border p-3 text-[13px] whitespace-pre-wrap">
            {w.comments}
          </p>
        </section>
      )}
    </div>
  )
}
