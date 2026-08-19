import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettingsPage,
})

type IntegrationSettings = {
  dhcp_sync_enabled: boolean
  dns_sync_enabled: boolean
  virtualization_enabled: boolean
}

const CARDS: {
  key: keyof IntegrationSettings
  label: string
  info: string
  description: string
}[] = [
  {
    key: "dhcp_sync_enabled",
    label: "Windows DHCP sync",
    info: "Talks to the DhcpServer PowerShell module over WinRM - no agent on the server. The connecting account should be in the DHCP Administrators group, not a domain admin.",
    description:
      "Sync scopes, exclusion ranges and reservations from Windows DHCP servers into IPAM - and push reservations you create here back out.",
  },
  {
    key: "dns_sync_enabled",
    label: "Windows DNS sync",
    info: "Reads zones via the DnsServer PowerShell module over the same WinRM connection a DHCP server uses. Record management stays limited to A/AAAA/PTR.",
    description:
      "Reconcile A/AAAA/PTR records from Windows DNS zones against your IP addresses' DNS names, with drift review and optional push.",
  },
  {
    key: "virtualization_enabled",
    label: "Virtualization sync",
    info: "Proxmox VE first, over its REST API with a scoped API token. vCenter follows behind the same source model.",
    description:
      "Import clusters, virtual machines, their interfaces and guest IPs from your hypervisors into the existing cluster/VM inventory.",
  },
]

function IntegrationsSettingsPage() {
  const { canManage, isLoading } = useMe()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ["integration-settings"],
    queryFn: () => api<IntegrationSettings>("/api/integrations/settings/"),
    enabled: canManage,
  })

  const save = useMutation({
    mutationFn: (patch: Partial<IntegrationSettings>) =>
      api<IntegrationSettings>("/api/integrations/settings/", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["integration-settings"], data)
      toast.success("Integration settings saved")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        Tenant admin access is required to change integration settings.
      </p>
    )

  const settings = query.data

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-base font-medium">Integrations</h1>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          External systems Danbyte keeps in sync with. Everything is off until
          you enable it here - a disabled integration hides its pages and stops
          its scheduled syncs for this tenant.
        </p>
      </div>
      {query.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {settings && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {CARDS.map((card) => (
            <div key={card.key} className="flex items-start gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-medium">{card.label}</h2>
                  <InfoTip>{card.info}</InfoTip>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {card.description}
                </p>
              </div>
              <Switch
                checked={settings[card.key]}
                disabled={save.isPending}
                onCheckedChange={(on) =>
                  save.mutate({
                    [card.key]: on,
                  } as Partial<IntegrationSettings>)
                }
                aria-label={card.label}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
