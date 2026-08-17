import { createFileRoute, Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Network } from "lucide-react"

import {
  api,
  type Paginated,
  type VirtNetwork,
  type VirtualizationSource,
  type VirtualSwitch,
} from "@/lib/api"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/virtual-topology/")({
  component: VirtualTopologyPage,
})

/** Green for "up/active", red for "down/off", neutral otherwise — the coloured
 * VM boxes of the OpenStack-style topology, derived from the status name only
 * (that's all the network payload carries). */
function vmTone(status: string | null): string {
  const s = (status || "").toLowerCase()
  if (/(active|running|up|online|powered.?on)/.test(s))
    return "border-emerald-500/60 bg-emerald-500/5"
  if (/(off|down|decom|failed|stopped|suspend)/.test(s))
    return "border-red-500/60 bg-red-500/5"
  return "border-border bg-muted/30"
}

function VirtualTopologyPage() {
  const [source, setSource] = useState("")

  const sources = useQuery({
    queryKey: ["virtualization-sources", "topology"],
    queryFn: () =>
      api<Paginated<VirtualizationSource>>("/api/virtualization-sources/"),
  })
  const switches = useQuery({
    queryKey: ["virtual-switches", "topology"],
    queryFn: () => api<Paginated<VirtualSwitch>>("/api/virtual-switches/"),
  })
  const networks = useQuery({
    queryKey: ["virt-networks", "topology", source],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(
        `/api/virt-networks/?${new URLSearchParams(source ? { source } : {})}`
      ),
  })

  const switchName = useMemo(() => {
    const m = new Map<string, VirtualSwitch>()
    for (const s of switches.data?.results ?? []) m.set(s.id, s)
    return m
  }, [switches.data])

  // Group networks under their switch (null switch → "Unassigned").
  const groups = useMemo(() => {
    const bySwitch = new Map<string, VirtNetwork[]>()
    for (const n of networks.data?.results ?? []) {
      const key = n.vswitch ?? "—"
      const list = bySwitch.get(key)
      if (list) list.push(n)
      else bySwitch.set(key, [n])
    }
    return [...bySwitch.entries()]
  }, [networks.data])

  const loading = networks.isLoading || switches.isLoading
  const isEmpty = !loading && groups.length === 0

  return (
    <ListPageShell
      title="Virtual network topology"
      query={networks}
      actions={
        <Select
          value={source || "all"}
          onValueChange={(v) => setSource(v === "all" ? "" : v)}
        >
          <SelectTrigger size="sm" className="h-8 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {(sources.data?.results ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {isEmpty ? (
        <EmptyState title="No virtual networks to map yet.">
          Turn on{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          on a virtualization source and re-sync — its switches, networks
          (VLANs) and the VMs on them are drawn here.
        </EmptyState>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-8">
          {groups.map(([swId, nets]) => {
            const sw = switchName.get(swId)
            return (
              <section key={swId} className="space-y-4">
                {/* Switch header — the L2 fabric these networks ride on. */}
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  {sw ? (
                    <Link
                      to="/virtual-switches/$id"
                      params={{ id: sw.id }}
                      className="link text-sm font-semibold"
                    >
                      {sw.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground">
                      Unassigned networks
                    </span>
                  )}
                  {sw?.kind_display && (
                    <span className="text-[11px] text-muted-foreground">
                      {sw.kind_display}
                    </span>
                  )}
                </div>

                {/* Each network is a full-width "subnet bar"; its VMs hang
                    beneath it, connected by a short tick. */}
                {nets.map((n) => (
                  <div key={n.id} className="pl-6">
                    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5">
                      <span className="text-sm font-medium">
                        {n.name || n.ext_key}
                      </span>
                      {n.vlan ? (
                        <Link
                          to="/vlans/$id"
                          params={{ id: n.vlan.id }}
                          className="link ml-2 font-mono text-xs text-muted-foreground"
                        >
                          VLAN {n.vlan.vlan_id}
                        </Link>
                      ) : (
                        <span className="ml-2 text-xs text-muted-foreground">
                          no VLAN
                        </span>
                      )}
                    </div>
                    {n.vms.length > 0 ? (
                      <div className="ml-4 flex flex-wrap gap-3 border-l border-border pt-3 pl-4">
                        {n.vms.map((vm) => (
                          <Link
                            key={vm.id}
                            to="/virtual-machines/$id"
                            params={{ id: vm.id }}
                            className={`link flex min-w-28 flex-col gap-0.5 rounded-md border px-3 py-2 ${vmTone(
                              vm.status
                            )}`}
                          >
                            <span className="text-xs font-medium">
                              {vm.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {vm.status || "—"}
                            </span>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <p className="ml-4 pt-2 pl-4 text-xs text-muted-foreground">
                        No VMs on this network.
                      </p>
                    )}
                  </div>
                ))}
              </section>
            )
          })}
        </div>
      )}
    </ListPageShell>
  )
}
