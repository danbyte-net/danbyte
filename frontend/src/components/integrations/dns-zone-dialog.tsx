import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DnsZone,
  type Paginated,
  type WindowsConnection,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormSelect, FormText } from "@/components/forms"

/**
 * Author a DNS zone. DNS is Danbyte-authoritative for managed content (a push
 * to the DNS backend is a later phase), so this stores the zone locally as a
 * managed zone — sync will never prune it.
 */
export function DnsZoneDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [connection, setConnection] = useState("")
  const [name, setName] = useState("")
  const [isReverse, setIsReverse] = useState(false)

  const conns = useQuery({
    queryKey: ["windows-connections", "dns-picker"],
    queryFn: () =>
      api<Paginated<WindowsConnection>>("/api/windows-connections/?page_size=200"),
    staleTime: 5 * 60_000,
  })
  const servers = useMemo(
    () => (conns.data?.results ?? []).filter((c) => c.dns_enabled),
    [conns.data]
  )

  const save = useMutation({
    mutationFn: () =>
      api<DnsZone>("/api/dns-zones/", {
        method: "POST",
        body: JSON.stringify({
          connection,
          name: name.trim(),
          is_reverse: isReverse,
        }),
      }),
    onSuccess: () => {
      toast.success("Zone created")
      qc.invalidateQueries({ queryKey: ["dns-zones"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const ready = connection && name.trim()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New DNS zone</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <FormSelect
            label="Server"
            value={connection || null}
            onChange={(v) => setConnection(v ?? "")}
            placeholder={servers.length ? "Select a server…" : "No DNS servers"}
            options={servers.map((c) => ({ value: c.id, label: c.name }))}
          />
          <FormText
            label="Zone name"
            value={name}
            onChange={setName}
            required
            mono
            placeholder="lab.example.com"
          />
          <FormCheckbox
            label="Reverse zone"
            checked={isReverse}
            onChange={setIsReverse}
            hint="A reverse-lookup (PTR) zone, e.g. 0.77.10.in-addr.arpa."
          />
          <p className="text-[11px] text-muted-foreground">
            The zone is authored in Danbyte and never pruned by sync. Pushing
            zones to the DNS server is a later phase.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending || !ready} onClick={() => save.mutate()}>
            {save.isPending ? "Creating…" : "Create zone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
