import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DnsZone,
  type Paginated,
  type WindowsConnection,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

/**
 * Author a DNS zone. DNS is Danbyte-authoritative for managed content (a push
 * to the DNS backend is a later phase), so this stores the zone locally as a
 * managed zone - sync will never prune it.
 */
export function DnsZoneDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [connection, setConnection] = useState("")
  const [name, setName] = useState("")
  const [isReverse, setIsReverse] = useState(false)

  const conns = useQuery({
    queryKey: ["windows-connections", "dns-picker"],
    queryFn: () =>
      api<Paginated<WindowsConnection>>(
        "/api/windows-connections/?page_size=200"
      ),
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
      reset()
      toast.success("Zone created")
      qc.invalidateQueries({ queryKey: ["dns-zones"] })
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const ready = connection && name.trim()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New DNS zone</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
          className="grid gap-3"
        >
          <FormSelect
            label="Server"
            value={connection || null}
            onChange={(v) => setConnection(v ?? "")}
            placeholder={servers.length ? "Select a server…" : "No DNS servers"}
            options={servers.map((c) => ({ value: c.id, label: c.name }))}
            error={fieldErrors.connection}
          />
          <FormText
            label="Zone name"
            value={name}
            onChange={setName}
            required
            mono
            placeholder="lab.example.com"
            error={fieldErrors.name}
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
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel="Create zone"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
