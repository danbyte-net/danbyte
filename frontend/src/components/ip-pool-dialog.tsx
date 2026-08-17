import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DhcpScopeRange,
  type IPRoleOption,
  type Paginated,
  type StatusOption,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { cidrHostRange, ipToBigInt } from "@/lib/prefix-tree"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormSelect, FormText } from "@/components/forms"

// Matches api/viewsets.py PrefixViewSet.populate POOL_MAX.
const POOL_MAX = 1024

/**
 * Bulk-create a pool of host IPs across a range in one prefix. Presets fill the
 * range from a DHCP scope pool or the prefix's usable hosts; the backend skips
 * addresses that already exist and the prefix's network/broadcast.
 */
export function IpPoolDialog({
  prefixId,
  cidr,
  dhcpRanges,
  existingAddresses,
  onOpenChange,
}: {
  prefixId: string
  cidr: string
  dhcpRanges?: DhcpScopeRange[]
  /** Addresses already registered in the prefix — for the live skip count. */
  existingAddresses: string[]
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const usable = useMemo(() => cidrHostRange(cidr), [cidr])
  const [start, setStart] = useState(dhcpRanges?.[0]?.start ?? usable?.start ?? "")
  const [end, setEnd] = useState(dhcpRanges?.[0]?.end ?? usable?.end ?? "")
  const [statusId, setStatusId] = useState("")
  const [roleId, setRoleId] = useState("")
  const [description, setDescription] = useState("")

  const statuses = useQuery({
    queryKey: ["statuses-picker"],
    queryFn: () => api<Paginated<StatusOption>>("/api/statuses/"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["ip-roles-picker"],
    queryFn: () => api<Paginated<IPRoleOption>>("/api/ip-roles/"),
    staleTime: 10 * 60_000,
  })

  // Range presets: each DHCP scope pool, then the whole usable prefix.
  const presets = useMemo(() => {
    const out: { value: string; label: string; start: string; end: string }[] = []
    for (const r of dhcpRanges ?? [])
      out.push({
        value: `dhcp:${r.scope_id}`,
        label: `DHCP pool: ${r.name || r.scope_id} (${r.start}–${r.end})`,
        start: r.start,
        end: r.end,
      })
    if (usable)
      out.push({
        value: "prefix",
        label: `Whole prefix (${usable.start}–${usable.end})`,
        start: usable.start,
        end: usable.end,
      })
    return out
  }, [dhcpRanges, usable])

  const applyPreset = (v: string | null) => {
    const p = presets.find((x) => x.value === v)
    if (p) {
      setStart(p.start)
      setEnd(p.end)
    }
  }

  // Live totals: how many the range spans, and how many already exist.
  const { total, skip } = useMemo(() => {
    const s = ipToBigInt(start.trim())
    const e = ipToBigInt(end.trim())
    if (s == null || e == null || e < s) return { total: 0, skip: 0 }
    const span = Number(e - s + 1n)
    if (span > POOL_MAX * 4) return { total: span, skip: 0 } // too big to scan
    const taken = new Set(
      existingAddresses.map((a) => ipToBigInt(a)?.toString())
    )
    let skip = 0
    for (let n = s; n <= e; n++) if (taken.has(n.toString())) skip++
    return { total: span, skip }
  }, [start, end, existingAddresses])

  const toCreate = Math.max(total - skip, 0)
  const rangeValid = total > 0
  const overCap = total > POOL_MAX

  const save = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number }>(
        `/api/prefixes/${prefixId}/populate/`,
        {
          method: "POST",
          body: JSON.stringify({
            start: start.trim(),
            end: end.trim(),
            status_id: statusId || null,
            role_id: roleId || null,
            description: description.trim(),
          }),
        }
      ),
    onSuccess: (r) => {
      toast.success(
        `Added ${r.created} address${r.created === 1 ? "" : "es"}` +
          (r.skipped ? `, skipped ${r.skipped} existing` : "")
      )
      qc.invalidateQueries({ queryKey: ["prefix-ips", prefixId] })
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add IP pool</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {presets.length > 0 && (
            <FormSelect
              label="Populate from"
              value={null}
              onChange={applyPreset}
              noneLabel="Custom range"
              options={presets.map((p) => ({ value: p.value, label: p.label }))}
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Start address"
              value={start}
              onChange={setStart}
              required
              mono
              placeholder={usable?.start}
            />
            <FormText
              label="End address"
              value={end}
              onChange={setEnd}
              required
              mono
              placeholder={usable?.end}
            />
          </div>
          <FormSelect
            label="Status"
            value={statusId || null}
            onChange={(v) => setStatusId(v ?? "")}
            noneLabel="No status"
            options={(statuses.data?.results ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            }))}
          />
          <FormSelect
            label="Role"
            value={roleId || null}
            onChange={(v) => setRoleId(v ?? "")}
            noneLabel="No role"
            options={(roles.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional — applied to every address"
          />
          <p className="text-[11px] text-muted-foreground">
            {!rangeValid ? (
              "Enter a start and end address inside this prefix."
            ) : overCap ? (
              <span className="text-destructive">
                That range is {total.toLocaleString()} addresses — the limit is{" "}
                {POOL_MAX.toLocaleString()} per pool. Narrow the range.
              </span>
            ) : (
              <>
                Will add <strong>{toCreate.toLocaleString()}</strong> address
                {toCreate === 1 ? "" : "es"}
                {skip > 0 && ` (${skip.toLocaleString()} already exist, skipped)`}
                . The prefix's network and broadcast addresses are never created.
              </>
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || !rangeValid || overCap || toCreate < 1}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Adding…" : `Add ${toCreate.toLocaleString()} IPs`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
