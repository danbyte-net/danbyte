import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Inbox, Plug, Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type VirtualizationSource } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SyncStatusBadge } from "@/components/integrations/sync-status-badge"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormTextarea,
  FormCheckbox,
  FormSelect,
  FormText,
} from "@/components/forms"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { TimeCell } from "@/components/cells/time-ago"
import { VirtChangesDialog } from "@/components/integrations/virt-changes-dialog"

export const Route = createFileRoute("/virtualization-sources/")({
  component: VirtualizationSourcesPage,
})

function VirtualizationSourcesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("virtualizationsource", "add")
  const canEdit = canDo("virtualizationsource", "change")
  const canDelete = canDo("virtualizationsource", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<VirtualizationSource | null>(null)
  const [reviewing, setReviewing] = useState<VirtualizationSource | null>(null)
  const [deleting, setDeleting] = useState<VirtualizationSource | null>(null)

  const query = useQuery({
    queryKey: ["virtualization-sources", q],
    queryFn: () =>
      api<Paginated<VirtualizationSource>>(
        `/api/virtualization-sources/?${new URLSearchParams({ search: q })}`
      ),
  })
  const rows = query.data?.results ?? []
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["virtualization-sources"] })

  const del = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api(`/api/virtualization-sources/${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Source removed")
      setDeleting(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const test = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api<{
        ok: boolean
        product?: string
        version?: string
        nodes?: number
        online_nodes?: number
        vms?: number
        error?: string
      }>(`/api/virtualization-sources/${s.id}/test/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (r.ok) {
        // The product comes from the response - naming it here is what made a
        // vCenter probe report "Proxmox VE". vCenter reports no version.
        const name = [r.product, r.version].filter(Boolean).join(" ")
        const parts = [`${r.online_nodes}/${r.nodes} nodes online`]
        if (r.vms !== undefined) parts.push(`${r.vms} VMs`)
        toast.success(`Connected - ${name}, ${parts.join(", ")}`)
      } else toast.error(r.error || "Probe failed")
    },
    onError: (e) => apiErrorToast(e),
  })

  const syncNow = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api<{
        ok: boolean
        vms?: number
        interfaces?: number
        ips?: number
        ips_skipped?: number
        hosts?: number
        error?: string
      }>(`/api/virtualization-sources/${s.id}/sync/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (r.ok) {
        let base = `Synced: ${r.vms ?? 0} VMs, ${r.interfaces ?? 0} interfaces, ${r.ips ?? 0} IPs`
        if (r.hosts) base += `, ${r.hosts} host${r.hosts === 1 ? "" : "s"}`
        // An address with no containing prefix is dropped by design; say how
        // many, so it stops looking like the sync just missed them.
        const unplaced = r.ips_skipped ?? 0
        if (unplaced)
          toast.warning(
            `${base} · ${unplaced} address${unplaced === 1 ? "" : "es"} unplaced - no containing prefix`
          )
        else toast.success(base)
      } else toast.error(r.error || "Sync failed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<VirtualizationSource>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            <Link
              to="/virtualization-sources/$id"
              params={{ id: row.original.id }}
              className="link"
            >
              {row.original.name}
            </Link>
            {!row.original.enabled && (
              <Badge variant="secondary" className="text-[10px]">
                disabled
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: "Platform",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px]">
            {row.original.kind_display}
          </Badge>
        ),
      },
      {
        id: "mode",
        accessorKey: "sync_mode",
        header: "Mode",
        cell: ({ row }) => {
          const m = row.original.sync_mode
          const label =
            m === "auto" ? "automatic" : m === "manual" ? "manual" : "review"
          return (
            <span className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {label}
              </Badge>
              {row.original.pending_count > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setReviewing(row.original)}
                >
                  <Inbox className="h-3.5 w-3.5" />
                  {row.original.pending_count} to review
                </Button>
              )}
            </span>
          )
        },
      },
      {
        id: "host",
        accessorKey: "host",
        header: "API",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            https://{row.original.host}:{row.original.port}
          </span>
        ),
      },
      {
        id: "status",
        header: "Last sync",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original
          return (
            <span className="flex items-center gap-2">
              <SyncStatusBadge
                status={s.last_sync_status}
                error={s.last_sync_error}
                skipped={s.last_sync_skipped}
              />
              {s.last_sync_at && <TimeCell iso={s.last_sync_at} />}
            </span>
          )
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => setDeleting(row.original) : undefined}
            extra={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={test.isPending}
                  onClick={() => test.mutate(row.original)}
                >
                  <Plug className="h-3.5 w-3.5" /> Test
                </Button>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={syncNow.isPending}
                    onClick={() => syncNow.mutate(row.original)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {syncNow.isPending ? "Syncing…" : "Sync"}
                  </Button>
                )}
              </>
            }
          />
        ),
      },
    ],
    [canEdit, canDelete, del, test, syncNow]
  )

  return (
    <ListPageShell
      title="Virtualization sources"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter sources…" }}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add source
          </Button>
        )
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No virtualization sources.">
          Connect a Proxmox VE cluster or a VMware vCenter and Danbyte imports
          its virtual machines, their interfaces and guest IPs into the
          cluster/VM inventory - and keeps them fresh.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          total={query.data?.count}
          columns={columns}
          flexColumn="host"
          tableId="virtualization-sources"
        />
      )}
      {creating && <SourceDialog onOpenChange={setCreating} />}
      {editing && (
        <SourceDialog
          source={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      {reviewing && (
        <VirtChangesDialog
          source={reviewing}
          onOpenChange={(o) => !o && setReviewing(null)}
        />
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the connection and its sync state. The virtual machines,
              switches and networks it imported stay - they simply stop
              updating.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleting) del.mutate(deleting)
              }}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListPageShell>
  )
}

/** What each hypervisor needs from this dialog, in the order they are offered.
 *
 * Every place the form differs by backend reads a field here. The alternative
 * - a `kind === "vcenter"` ternary in each of the nine spots that differ -
 * turns into a nested ternary the moment there is a third hypervisor.
 */
const KIND_SPEC = {
  proxmox: {
    label: "Proxmox VE",
    short: "Proxmox",
    port: 8006,
    namePlaceholder: "DB-CLUSTER01",
    hostPlaceholder: "10.0.0.11",
    hostInfo: "Any cluster node works - the API answers cluster-wide.",
    auth: "token",
    idLabel: "API token id",
    idPlaceholder: "danbyte@pam!sync",
    idInfo:
      "Datacenter → Permissions → API Tokens. The PVEAuditor role is enough for read sync.",
    secretLabel: "Token secret",
    // Proxmox reports a bridge MTU per vNIC; vSphere does not.
    mtu: true,
    hostHardware: false,
    disks: true,
    hosts: true,
    apiVersion: false,
    nat: false,
    groups: false,
    templates: false,
  },
  vcenter: {
    label: "VMware vCenter",
    short: "vCenter",
    port: 443,
    namePlaceholder: "vcenter.example.com",
    hostPlaceholder: "vcenter.danbyte.lan",
    hostInfo: "The vCenter Server FQDN or IP.",
    auth: "userpass",
    idLabel: "Username",
    idPlaceholder: "administrator@vsphere.local",
    idInfo: "A read-only vCenter SSO user is enough for inventory sync.",
    secretLabel: "Password",
    mtu: false,
    hostHardware: true,
    disks: true,
    hosts: true,
    apiVersion: false,
    nat: false,
    groups: false,
    templates: false,
  },
  vcloud: {
    label: "VMware Cloud Director",
    short: "Cloud Director",
    port: 443,
    namePlaceholder: "cloud.example.com",
    hostPlaceholder: "vcd.danbyte.lan",
    hostInfo: "The Cloud Director portal address.",
    auth: "userpass",
    idLabel: "Username",
    idPlaceholder: "sync@my-org",
    idInfo:
      "A read-only organization account. The org in the username is what scopes the connection - one source per organization.",
    secretLabel: "Password",
    mtu: false,
    hostHardware: false,
    // An org account sees neither the hypervisor hosts underneath nor a VM's
    // individual disks - only one aggregate figure - so neither switch has
    // anything to act on here.
    disks: false,
    hosts: false,
    // Cloud Director negotiates its API version, so there is one to pin.
    apiVersion: true,
    nat: true,
    groups: true,
    templates: true,
  },
} as const

type KindKey = keyof typeof KIND_SPEC

const KINDS = (Object.keys(KIND_SPEC) as KindKey[]).map((value) => ({
  value,
  label: KIND_SPEC[value].label,
}))

/** Ports the dialog itself filled in, so changing kind may replace one. */
const DEFAULT_PORTS = KINDS.map((k) => String(KIND_SPEC[k.value].port))

function specFor(kind: string) {
  return kind in KIND_SPEC ? KIND_SPEC[kind as KindKey] : KIND_SPEC.proxmox
}

export function SourceDialog({
  source,
  onOpenChange,
}: {
  /** Present = edit; absent = create. */
  source?: VirtualizationSource
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const isEdit = !!source
  // Only offer a hypervisor whose sync is switched on for this tenant - the
  // server refuses the others anyway, and a disabled kind in the picker is a
  // dead end you only discover on save.
  const toggles = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
  })
  const kinds = KINDS.filter((k) => toggles.data?.[`virt_${k.value}`] !== false)
  // The page itself 404s while both syncs are off, so there is always at
  // least one kind here; the fallback is belt to those braces.
  const firstKind = kinds.length > 0 ? kinds[0].value : "proxmox"
  const [kind, setKind] = useState<string>(source?.kind ?? firstKind)
  const spec = specFor(kind)
  const [name, setName] = useState(source?.name ?? "")
  const [host, setHost] = useState(source?.host ?? "")
  const [port, setPort] = useState(String(source?.port ?? spec.port))
  const [verifySsl, setVerifySsl] = useState(source?.verify_ssl ?? false)
  const [tokenId, setTokenId] = useState("")
  const [secret, setSecret] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")

  // On create, switching kind swaps the conventional default API port unless the
  // operator has typed a non-default one.
  function changeKind(next: string | null) {
    const k = next ?? firstKind
    if (!isEdit && (port === "" || DEFAULT_PORTS.includes(port))) {
      setPort(String(specFor(k).port))
    }
    setKind(k)
  }
  const [syncMode, setSyncMode] = useState<string>(
    source?.sync_mode ?? "review"
  )
  const [interval, setInterval] = useState(
    String(source?.poll_interval_minutes ?? 10)
  )
  const [syncDisks, setSyncDisks] = useState(source?.sync_disks ?? true)
  const [syncNetworks, setSyncNetworks] = useState(
    source?.sync_networks ?? false
  )
  const [matchVlans, setMatchVlans] = useState(
    source?.match_existing_vlans ?? false
  )
  const [syncHosts, setSyncHosts] = useState(source?.sync_hosts ?? false)
  const [syncHostHw, setSyncHostHw] = useState(
    source?.sync_host_hardware ?? false
  )
  const [syncPlatforms, setSyncPlatforms] = useState(
    source?.sync_platforms ?? false
  )
  const [syncMtu, setSyncMtu] = useState(
    source?.sync_vm_interface_mtu ?? true
  )
  const [skipOffline, setSkipOffline] = useState(
    source?.skip_offline_vms ?? false
  )
  const [apiVersion, setApiVersion] = useState(source?.api_version ?? "")
  const [syncNat, setSyncNat] = useState(source?.sync_nat ?? false)
  const [syncGroups, setSyncGroups] = useState(source?.sync_vm_groups ?? true)
  const [syncTemplates, setSyncTemplates] = useState(
    source?.sync_templates ?? false
  )
  const [autoPrune, setAutoPrune] = useState(source?.auto_prune ?? false)
  const [pruneAfter, setPruneAfter] = useState(
    String(source?.auto_prune_after_days ?? 7)
  )
  const [allowedNetworks, setAllowedNetworks] = useState(
    (source?.sync_allowed_networks ?? []).join("\n")
  )
  const [enabled, setEnabled] = useState(source?.enabled ?? true)
  // Where discovered addresses may land. Empty = the Global VRF, which is a
  // real routing context here, not "unset".
  const [vrfId, setVrfId] = useState(source?.vrf_id ?? "")
  const [vrfMode, setVrfMode] = useState(source?.vrf_mode ?? "pinned")
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        host: host.trim(),
        port: Number(port) || spec.port,
        verify_ssl: verifySsl,
        sync_mode: syncMode,
        poll_interval_minutes: Number(interval) || 10,
        sync_disks: syncDisks,
        sync_networks: syncNetworks,
        match_existing_vlans: matchVlans,
        sync_hosts: syncHosts,
        sync_host_hardware: syncHostHw,
        sync_platforms: syncPlatforms,
        sync_vm_interface_mtu: syncMtu,
        skip_offline_vms: skipOffline,
        api_version: apiVersion.trim(),
        sync_nat: syncNat,
        sync_vm_groups: syncGroups,
        sync_templates: syncTemplates,
        auto_prune: autoPrune,
        auto_prune_after_days: Number(pruneAfter) || 0,
        sync_allowed_networks: allowedNetworks
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        vrf_id: vrfId || null,
        vrf_mode: vrfMode,
        enabled,
      }
      if (spec.auth === "userpass") {
        if (username.trim()) body.username = username.trim()
        if (password) body.password = password
      } else {
        if (tokenId.trim()) body.token_id = tokenId.trim()
        if (secret) body.secret = secret
      }
      if (isEdit)
        return api<VirtualizationSource>(
          `/api/virtualization-sources/${source.id}/`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
      return api<VirtualizationSource>("/api/virtualization-sources/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      toast.success(isEdit ? "Source saved" : "Source added")
      qc.invalidateQueries({ queryKey: ["virtualization-sources"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  // Which pair of credential fields is on screen; the rest of the pair's
  // wording comes from the descriptor.
  const cred =
    spec.auth === "userpass"
      ? {
          id: username,
          setId: setUsername,
          secret: password,
          setSecret: setPassword,
        }
      : { id: tokenId, setId: setTokenId, secret, setSecret }
  const valid =
    name.trim() &&
    host.trim() &&
    (isEdit || (cred.id.trim() && cred.secret))

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="3xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${spec.short} source` : `Add ${spec.short} source`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder={spec.namePlaceholder}
          />
          {!isEdit && kinds.length > 1 && (
            <FormSelect
              label="Type"
              value={kind}
              onChange={changeKind}
              options={kinds}
            />
          )}
          <FormText
            label="Host"
            value={host}
            onChange={setHost}
            required
            placeholder={spec.hostPlaceholder}
            info={spec.hostInfo}
          />
          <FormText label="API port" value={port} onChange={setPort} />
          {spec.apiVersion && (
            <FormText
              label="API version"
              value={apiVersion}
              onChange={setApiVersion}
              placeholder="negotiate"
              info="Leave blank and Danbyte asks the appliance what it speaks, then uses the newest version this release was tested against. Pin one only to work around a specific version."
            />
          )}
          <FormSelect
            label="Sync mode"
            value={syncMode}
            onChange={(v) => setSyncMode(v ?? "review")}
            info="Automatic mirrors the hypervisor (it becomes the source of truth). Review polls on a schedule but only applies changes you accept. Manual detects only when you sync by hand - both keep Danbyte the source of truth."
            options={[
              { value: "review", label: "Review - apply on accept" },
              { value: "auto", label: "Automatic - mirror" },
              { value: "manual", label: "Manual - detect on demand" },
            ]}
          />
          <FormText
            label="Poll interval (minutes)"
            value={interval}
            onChange={setInterval}
          />
          <FormText
            label={spec.idLabel}
            value={cred.id}
            onChange={cred.setId}
            mono
            placeholder={isEdit ? "(unchanged)" : spec.idPlaceholder}
            info={spec.idInfo}
            required={!isEdit}
          />
          <FormText
            label={spec.secretLabel}
            value={cred.secret}
            onChange={cred.setSecret}
            type="password"
            placeholder={isEdit ? "(unchanged)" : ""}
            required={!isEdit}
          />
          <div className="flex flex-col justify-end gap-2 pb-1">
            <FormCheckbox
              label="Verify TLS certificate"
              checked={verifySsl}
              onChange={setVerifySsl}
            />
            {spec.disks && (
              <FormCheckbox
                label="Sync disks"
                hint="Import each VM's virtual disks (name, size, storage)."
                checked={syncDisks}
                onChange={setSyncDisks}
              />
            )}
            <FormCheckbox
              label="Sync virtual switches & networks"
              hint="Import virtual switches and port-groups/bridges, mapping them to VLANs."
              checked={syncNetworks}
              onChange={setSyncNetworks}
            />
            {syncNetworks && (
              <FormCheckbox
                label="Match existing VLANs by ID"
                hint="Link a tagged network to a VLAN you already have with that VLAN ID - and the prefixes on it - instead of creating one in the source's own group."
                checked={matchVlans}
                onChange={setMatchVlans}
              />
            )}
            {spec.hosts && (
              <FormCheckbox
                label="Create hosts as devices"
                hint="Add each hypervisor node as a Device, so VMs link to their host and bridge uplinks find its NICs."
                checked={syncHosts}
                onChange={setSyncHosts}
              />
            )}
            {/* Only offered where the hypervisor actually reports a per-vNIC
                MTU. vSphere keeps it on the vSwitch or port group, so there is
                nothing to copy; offering it with a disclaimer read as a
                setting that was simply not working. */}
            {spec.mtu && (
              <FormCheckbox
                label="Sync interface MTU"
                hint="Copy the hypervisor's MTU onto a VM interface that has none, and report a differing one as drift. Off leaves MTU to you."
                checked={syncMtu}
                onChange={setSyncMtu}
              />
            )}
            {spec.groups && (
              <FormCheckbox
                label="Sync vApps as VM groups"
                hint="Mirror the hypervisor's own grouping. A VM you grouped by hand keeps your grouping."
                checked={syncGroups}
                onChange={setSyncGroups}
              />
            )}
            {spec.nat && (
              <FormCheckbox
                label="Record external addresses as NAT rules"
                hint="Write a static NAT rule for each translated interface. Off leaves the edge yours to document."
                checked={syncNat}
                onChange={setSyncNat}
              />
            )}
            {spec.templates && (
              <FormCheckbox
                label="Import vApp templates"
                hint="Templates are golden images rather than running machines, so they are left out by default."
                checked={syncTemplates}
                onChange={setSyncTemplates}
              />
            )}
            <FormCheckbox
              label="Skip powered-off VMs"
              hint="Leave stopped guests alone. They still count as present, so they are never pruned for being off."
              checked={skipOffline}
              onChange={setSkipOffline}
            />
            <FormCheckbox
              label="Delete VMs removed from the hypervisor"
              hint="Off by default - Danbyte keeps them, flagged as missing, for you to delete. In review mode the removal is proposed either way."
              checked={autoPrune}
              onChange={setAutoPrune}
            />
            {autoPrune && (
              <FormText
                label="Remove after"
                hint="days a VM must stay missing before Danbyte believes it - also delays the review-mode proposal"
                type="number"
                value={pruneAfter}
                onChange={setPruneAfter}
              />
            )}
            <FormCheckbox
              label="Set platform from the guest OS"
              hint="Fill in each VM's platform from what the hypervisor reports, creating the platform on demand. Rename it afterwards if you like - the match survives."
              checked={syncPlatforms}
              onChange={setSyncPlatforms}
            />
            <FormTextarea
              label="Allowed networks"
              hint="optional - one CIDR per line"
              info="Guest-reported IPs are only recorded when they fall inside one of these networks. Keeps container guests (Docker) from flooding the sync with bridge addresses. Empty = record everything a prefix matches."
              value={allowedNetworks}
              onChange={setAllowedNetworks}
              rows={3}
              placeholder={"10.0.9.0/24\n192.168.110.0/24"}
            />
            {spec.hostHardware && syncHosts && (
              <FormCheckbox
                label="Read host hardware"
                hint="Fill in model, vendor and serial from vSphere. Creates a device type and manufacturer on demand, so it is separate from the switch above."
                checked={syncHostHw}
                onChange={setSyncHostHw}
              />
            )}
            {isEdit && (
              <FormCheckbox
                label="Enabled"
                checked={enabled}
                onChange={setEnabled}
              />
            )}
          </div>
          <div className="col-span-2 grid grid-cols-2 gap-3 border-t pt-3">
            <FormSelect
              label="Address VRF"
              hint="Routing context for the addresses this source discovers. An address is only recorded when a prefix in that VRF contains it."
              value={vrfId || null}
              onChange={(v) => setVrfId(v ?? "")}
              noneLabel="Global"
              options={(vrfs.data?.results ?? []).map((v) => ({
                value: v.id,
                label: v.name,
              }))}
            />
            <FormSelect
              label="If nothing there contains it"
              hint="Searching other VRFs only ever places addresses that would otherwise be skipped - it never moves one that already fits."
              value={vrfMode}
              onChange={(v) => setVrfMode(v === "search" ? "search" : "pinned")}
              options={[
                { value: "pinned", label: "Skip the address" },
                { value: "search", label: "Look in other VRFs" },
              ]}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
