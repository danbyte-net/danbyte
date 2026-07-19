import { useEffect, useState } from "react"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPAddress,
  type Paginated,
  type Prefix,
  type SiteOption,
  type VRFOption,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Combobox } from "@/components/ui/combobox"
import { apiErrorToast } from "@/lib/api-toast"

export interface AssignIpTarget {
  deviceId: string
  /** Omit to attach the IP to the device itself (no interface). */
  interfaceId?: string | null
  interfaceName?: string | null
  /** Display name of the target — the device name for a device-level assign. */
  deviceName?: string
}

// Cap on candidates pulled into the picker. Danbyte instances can hold millions
// of IPs, so we never list them all — the user narrows with the filters below
// and the server returns at most this many matches.
const RESULT_CAP = 50

/**
 * Attach an *existing* IP to a device interface — the complement to "Add IP"
 * (which creates a new one). Filters (site / VRF / subnet / search) narrow the
 * candidate set **server-side** so this scales to huge address spaces.
 */
export function AssignIpDialog({
  target,
  onOpenChange,
}: {
  target: AssignIpTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const open = !!target

  const [site, setSite] = useState<string | null>(null)
  const [vrf, setVrf] = useState<string | null>(null)
  const [prefix, setPrefix] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [ipId, setIpId] = useState<string | null>(null)

  // Debounce the free-text search so each keystroke doesn't hit the server.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  function close(next: boolean) {
    if (!next) {
      setSite(null)
      setVrf(null)
      setPrefix(null)
      setSearch("")
      setDebounced("")
      setIpId(null)
    }
    onOpenChange(next)
  }

  // Filter option sources (small, tenant-scoped — safe to load whole).
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/?picker=1"),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const prefixes = useQuery({
    queryKey: ["prefixes-picker", vrf, site],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: "500" })
      if (vrf) p.set("vrf", vrf)
      if (site) p.set("site", site)
      return api<Paginated<Prefix>>(`/api/prefixes/?${p}`)
    },
    enabled: open,
    staleTime: 60_000,
  })

  // The candidate IPs — narrowed server-side, capped at RESULT_CAP.
  const ips = useQuery({
    queryKey: ["ips-assign", site, vrf, prefix, debounced],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: String(RESULT_CAP) })
      if (site) p.set("site", site)
      if (vrf) p.set("vrf", vrf)
      if (prefix) p.set("prefix", prefix)
      if (debounced) p.set("search", debounced)
      return api<Paginated<IPAddress>>(`/api/ips/?${p}`)
    },
    enabled: open,
    placeholderData: keepPreviousData,
  })

  const m = useMutation({
    mutationFn: () =>
      api<IPAddress>(`/api/ips/${ipId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_device_id: target!.deviceId,
          // null → attach to the device itself (no interface).
          assigned_interface_id: target!.interfaceId ?? null,
        }),
      }),
    onSuccess: (ip) => {
      const where = target!.interfaceName ?? target!.deviceName ?? "this device"
      toast.success(`Assigned ${ip.ip_address} to ${where}`)
      qc.invalidateQueries({
        queryKey: ["device-interfaces", target!.deviceId],
      })
      qc.invalidateQueries({ queryKey: ["device-ips", target!.deviceId] })
      qc.invalidateQueries({ queryKey: ["device", target!.deviceId] })
      // The whole-stack table (device page's "Whole stack" scope + the virtual
      // chassis page) reads interfaces under its own key — refresh it too, or an
      // assign made from that table wouldn't show up.
      qc.invalidateQueries({
        queryKey: ["vc-member-interfaces", target!.deviceId],
      })
      if (target!.interfaceId) {
        qc.invalidateQueries({
          queryKey: ["interface-ips", target!.interfaceId],
        })
        qc.invalidateQueries({ queryKey: ["interface", target!.interfaceId] })
      }
      close(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = ips.data?.results ?? []
  const total = ips.data?.count ?? 0
  const truncated = total > rows.length

  const siteOpts = (sites.data?.results ?? []).map((s) => ({
    value: s.id,
    label: s.name,
  }))
  const vrfOpts = (vrfs.data?.results ?? []).map((v) => ({
    value: v.id,
    label: v.name,
  }))
  const prefixOpts = (prefixes.data?.results ?? []).map((p) => ({
    value: p.id,
    label: p.cidr,
  }))

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign existing IP</DialogTitle>
          <DialogDescription>
            Attach an existing IP address to{" "}
            <span className="font-mono">
              {target?.interfaceName ?? target?.deviceName ?? "this device"}
            </span>
            . Narrow the list by site, VRF, subnet, or search.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Combobox
            value={site}
            onChange={(v) => {
              setSite(v)
              setPrefix(null)
            }}
            options={siteOpts}
            noneLabel="Any site"
            placeholder="Any site"
            searchPlaceholder="Search sites…"
            emptyText="No sites."
          />
          <Combobox
            value={vrf}
            onChange={(v) => {
              setVrf(v)
              setPrefix(null)
            }}
            options={vrfOpts}
            noneLabel="Any VRF"
            placeholder="Any VRF"
            searchPlaceholder="Search VRFs…"
            emptyText="No VRFs."
          />
          <Combobox
            value={prefix}
            onChange={setPrefix}
            options={prefixOpts}
            noneLabel="Any subnet"
            placeholder="Any subnet"
            searchPlaceholder="Search subnets…"
            emptyText="No subnets."
          />
        </div>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by address or DNS name…"
        />

        <div className="max-h-64 overflow-auto rounded-md border border-border">
          {ips.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No matching IPs. Try widening the filters.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((ip) => {
                const selected = ip.id === ipId
                return (
                  <li key={ip.id}>
                    <button
                      type="button"
                      onClick={() => setIpId(ip.id)}
                      className={
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-muted/60 " +
                        (selected ? "bg-muted" : "")
                      }
                    >
                      <span className="font-mono">{ip.ip_address}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {ip.assigned_interface
                          ? `on ${ip.assigned_interface.device.name}/${ip.assigned_interface.name}`
                          : (ip.dns_name ?? "")}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {truncated && (
          <p className="text-xs text-muted-foreground">
            Showing first {rows.length} of {total} — refine the filters to
            narrow the list.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close(false)}
            disabled={m.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={!ipId || m.isPending}>
            {m.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
