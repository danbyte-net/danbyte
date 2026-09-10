import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { trademarkNotice, VENDORS } from "@/lib/vendors"
import { Button } from "@/components/ui/button"
import { SettingsHeader } from "@/components/settings/settings-card"
import {
  ToggleCard,
  ToggleCardGrid,
} from "@/components/settings/toggle-card"
import { VendorLogo } from "@/components/settings/vendor-logo"
import { PluginsSection } from "@/components/settings/plugins-section"

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettingsPage,
})

type IntegrationSettings = {
  dhcp_sync_enabled: boolean
  dns_sync_enabled: boolean
  virt_proxmox_enabled: boolean
  virt_vcenter_enabled: boolean
  ai_access_enabled: boolean
  ai_writes_enabled: boolean
  ai_chat_enabled: boolean
  zabbix_enabled: boolean
}

interface IntegrationCard {
  key: keyof IntegrationSettings
  label: string
  info: string
  description: string
  /** Whose product this talks to, for the logo slot and the marks. */
  vendor?: string
  /** Every vendor named on the card, so the attribution line is complete. */
  names?: string[]
  /** Where the connection itself is configured, when that is a page. */
  configure?: { to: string; label: string }
}

const CARDS: IntegrationCard[] = [
  {
    key: "virt_proxmox_enabled",
    label: "Proxmox VE sync",
    vendor: "proxmox",
    names: ["proxmox"],
    info: "Reads over the Proxmox VE REST API with a scoped API token. Danbyte never writes to the hypervisor.",
    description:
      "Import clusters, nodes, virtual machines, their interfaces and guest IPs into the existing cluster and VM inventory.",
    configure: { to: "/virtualization-sources", label: "Sources" },
  },
  {
    key: "virt_vcenter_enabled",
    label: "vCenter sync",
    vendor: "vcenter",
    names: ["vcenter"],
    info: "Reads over the vSphere API with a read-only account. Danbyte never writes to the hypervisor.",
    description:
      "Import clusters, hosts, virtual machines, their interfaces and guest IPs into the existing cluster and VM inventory.",
    configure: { to: "/virtualization-sources", label: "Sources" },
  },
  {
    key: "dhcp_sync_enabled",
    label: "DHCP sync",
    vendor: "windows",
    names: ["windows"],
    info: "Talks to the DhcpServer PowerShell module over WinRM - no agent on the server. The connecting account should be in the DHCP Administrators group, not a domain admin.",
    description:
      "Sync scopes, exclusion ranges and reservations into IPAM - and push reservations you create here back out.",
    configure: { to: "/windows-servers", label: "Servers" },
  },
  {
    key: "dns_sync_enabled",
    label: "DNS sync",
    vendor: "windows",
    names: ["windows"],
    info: "Reads zones via the DnsServer PowerShell module over the same WinRM connection a DHCP server uses. Record management stays limited to A/AAAA/PTR.",
    description:
      "Reconcile A/AAAA/PTR records against your IP addresses' DNS names, with drift review and optional push.",
    configure: { to: "/dns-zones", label: "Zones" },
  },
  {
    key: "zabbix_enabled",
    label: "Zabbix monitoring",
    vendor: "zabbix",
    names: ["zabbix"],
    info: "Reads over the Zabbix JSON-RPC API with a named API token. Danbyte does not run the checks - it reads what Zabbix already knows.",
    description:
      "Let an existing Zabbix answer for a site's monitoring status, alongside or instead of Danbyte's own engine.",
    configure: { to: "/settings/monitoring", label: "Engines" },
  },
  {
    key: "ai_access_enabled",
    label: "Agent access (MCP)",
    info: "Speaks the Model Context Protocol over HTTP at /api/mcp/. An assistant authenticates with an API token and sees exactly what that account sees - the same tenant, sites and objects, through the same permissions.",
    description:
      "Let assistants and agents read this tenant's data from your own tooling. Reading only, until you also allow writes.",
    configure: { to: "/agent-access", label: "Tokens & calls" },
  },
  {
    key: "ai_writes_enabled",
    label: "Agent access: allow writes",
    info: "A write still needs the token's own create/change/delete permission, and a delete has to name the object it removes. Every change is recorded in the change log under that account.",
    description:
      "Also let an assistant create, edit and delete objects. Leave this off if you want questions answered but nothing changed.",
  },
  {
    key: "ai_chat_enabled",
    label: "Assistant chat",
    info: "Adds a chat to the top bar. Unlike agent access, Danbyte itself calls a model, so the conversation and the data it reads go to whichever provider a deployment admin configured. Pick the local provider to keep everything on your own network.",
    description:
      "Ask questions about this tenant's data from inside Danbyte, in a panel beside the docs button.",
    configure: { to: "/settings/security", label: "Model" },
  },
]

/** What Danbyte talks to, one card each (#51).
 *
 * The switch was a row in a list, and the connection it governs was
 * configured on a different page in the main nav with nothing linking the
 * two. Now the card carries both, plus the vendor's name written the way its
 * owner asks for it. */
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
  const notice = trademarkNotice(CARDS.flatMap((c) => c.names ?? []))

  return (
    <div className="max-w-5xl space-y-4">
      <SettingsHeader title="Integrations">
        What Danbyte talks to and what it is allowed to change, plus the
        plugins installed on this deployment. Everything is off until you turn
        it on - a disabled integration hides its pages and stops its scheduled
        syncs for this tenant.
      </SettingsHeader>

      {query.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {settings && (
        <>
          <ToggleCardGrid>
            {CARDS.map((card) => (
              <ToggleCard
                key={card.key}
                title={card.label}
                info={card.info}
                description={card.description}
                logo={<VendorLogo vendor={card.vendor} />}
                subtitle={
                  card.names &&
                  card.names.map((n) => VENDORS[n]?.display ?? n).join(" · ")
                }
                checked={settings[card.key]}
                disabled={save.isPending}
                onCheckedChange={(on) => save.mutate({ [card.key]: on })}
                action={
                  card.configure && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to={card.configure.to}>{card.configure.label}</Link>
                    </Button>
                  )
                }
              />
            ))}
          </ToggleCardGrid>

          {notice && (
            <p className="max-w-prose text-[11px] text-muted-foreground">
              {notice}
            </p>
          )}
        </>
      )}

      {/* Plugins are the same thing to an operator: something Danbyte can do
          that is off until you turn it on. They used to live on a page of
          their own, which meant looking in two places to answer "what is
          switched on here?". */}
      <PluginsSection />
    </div>
  )
}
