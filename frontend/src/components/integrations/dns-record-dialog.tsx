import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DnsRecord,
  type DnsRecordType,
  type DnsZone,
  type Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { FormSelect, FormText } from "@/components/forms"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const TYPES: DnsRecordType[] = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "SRV",
  "PTR",
  "CAA",
]

// Per-type hint for the value field — mirrors the server-side validation.
const VALUE_HINT: Record<DnsRecordType, string> = {
  A: "IPv4 address, e.g. 10.0.0.5",
  AAAA: "IPv6 address, e.g. 2a09:…::5",
  CNAME: "Target hostname, e.g. www.example.com",
  MX: '"<priority> <mail-host>", e.g. 10 mail.example.com',
  TXT: "Free text, e.g. v=spf1 -all",
  NS: "Nameserver host, e.g. ns1.example.com",
  SRV: '"<pri> <weight> <port> <target>"',
  PTR: "Target hostname",
  CAA: '"<flags> <tag> <value>", e.g. 0 issue letsencrypt.org',
}

/** Create or edit an authored (managed) DNS record — the "Add record" form.
 * `record` prefills for editing; `zoneId` locks the zone for a zone page. */
export function DnsRecordDialog({
  open,
  onOpenChange,
  record,
  zoneId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  record?: DnsRecord | null
  zoneId?: string
}) {
  const qc = useQueryClient()
  const isEdit = !!record

  const zones = useQuery({
    queryKey: ["dns-zones", "picker"],
    queryFn: () => api<Paginated<DnsZone>>("/api/dns-zones/?page_size=500"),
    enabled: open && !zoneId && !isEdit,
  })

  const [zone, setZone] = useState("")
  const [name, setName] = useState("")
  const [type, setType] = useState<DnsRecordType>("A")
  const [data, setData] = useState("")
  const [ttl, setTtl] = useState("")

  useEffect(() => {
    if (!open) return
    setZone(record?.zone ?? zoneId ?? "")
    setName(record?.name ?? "")
    setType(record?.record_type ?? "A")
    setData(record?.data ?? "")
    setTtl(record?.ttl ?? "")
  }, [open, record, zoneId])

  const save = useMutation({
    mutationFn: () => {
      const body = {
        zone,
        name: name.trim(),
        record_type: type,
        data: data.trim(),
        ttl: ttl.trim(),
      }
      return isEdit
        ? api(`/api/dns-records/${record!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/dns-records/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dns-records"] })
      toast.success(isEdit ? "Record saved" : "Record created")
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const valid = zone && name.trim() && data.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit DNS record" : "Add DNS record"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {!zoneId && !isEdit && (
            <FormSelect
              label="Zone"
              value={zone}
              onChange={(v) => setZone(v ?? "")}
              options={(zones.data?.results ?? []).map((z) => ({
                value: z.id,
                label: z.name,
              }))}
            />
          )}
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            mono
            placeholder="www.example.com  ·  @ for the apex"
          />
          <FormSelect
            label="Type"
            value={type}
            onChange={(v) => setType((v as DnsRecordType) ?? "A")}
            options={TYPES.map((t) => ({ value: t, label: t }))}
          />
          <FormText
            label="Value"
            value={data}
            onChange={setData}
            mono
            hint={VALUE_HINT[type]}
          />
          <FormText
            label="TTL"
            value={ttl}
            onChange={setTtl}
            placeholder="optional (zone default)"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Add record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
