import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { CoverageBulkAddResult } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { DevicePicker } from "@/components/device-picker"
import { FormTextarea } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Mode = "pick" | "serials"

/** Serials as the server splits them: lines, commas, semicolons, spaces. */
export function countSerials(text: string): number {
  const seen = new Set<string>()
  for (const s of text.split(/[\s,;]+/)) {
    const t = s.trim()
    if (t) seen.add(t.toUpperCase())
  }
  return seen.size
}

/** Add devices to a support contract (#421): pick them, or paste serial
 * numbers and let the server match them within the tenant. */
export function SupportCoverageAddDialog({
  contractId,
  open,
  onOpenChange,
}: {
  contractId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<Mode>("pick")
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([])
  const [serials, setSerials] = useState("")
  const [result, setResult] = useState<CoverageBulkAddResult | null>(null)

  const close = (o: boolean) => {
    if (!o) {
      setPicked([])
      setSerials("")
      setResult(null)
      setMode("pick")
    }
    onOpenChange(o)
  }

  const add = useMutation({
    mutationFn: () =>
      api<CoverageBulkAddResult>("/api/support-coverage/bulk-add/", {
        method: "POST",
        body: JSON.stringify(
          mode === "pick"
            ? { contract_id: contractId, device_ids: picked.map((p) => p.id) }
            : { contract_id: contractId, serials }
        ),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["support-contract", contractId] })
      qc.invalidateQueries({ queryKey: ["support-contracts"] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      if (r.unmatched.length || r.ambiguous.length) {
        setResult(r)
        setSerials([...r.unmatched, ...r.ambiguous].join("\n"))
        return
      }
      toast.success(
        r.created === 1 ? "Added 1 device" : `Added ${r.created} devices`
      )
      close(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const nSerials = countSerials(serials)
  const ready = mode === "pick" ? picked.length > 0 : nSerials > 0

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add devices</DialogTitle>
        </DialogHeader>
        <SegmentedTabs<Mode>
          items={[
            { value: "pick", label: "Pick" },
            { value: "serials", label: "Serial numbers" },
          ]}
          value={mode}
          onValueChange={(v) => {
            setMode(v)
            setResult(null)
          }}
        />
        {mode === "pick" ? (
          <div className="grid gap-2">
            <DevicePicker
              label="Devices"
              value={null}
              onChange={() => undefined}
              excludeIds={picked.map((p) => p.id)}
              onPickMany={(items) =>
                setPicked((prev) => [
                  ...prev,
                  ...items.filter((i) => !prev.some((p) => p.id === i.id)),
                ])
              }
            />
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {picked.map((p) => (
                  <Badge key={p.id} variant="secondary" className="gap-1">
                    {p.label}
                    <button
                      type="button"
                      aria-label={`Remove ${p.label}`}
                      onClick={() =>
                        setPicked((prev) => prev.filter((x) => x.id !== p.id))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ) : (
          <FormTextarea
            label="Serial numbers"
            value={serials}
            onChange={setSerials}
            rows={8}
            placeholder="One per line"
          />
        )}
        {result && (
          <div className="grid gap-2 text-sm" data-testid="coverage-result">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="success">{result.created} added</Badge>
              {result.existing > 0 && (
                <Badge variant="secondary">
                  {result.existing} already covered
                </Badge>
              )}
              {result.unmatched.length > 0 && (
                <Badge variant="destructive">
                  {result.unmatched.length} not found
                </Badge>
              )}
              {result.ambiguous.length > 0 && (
                <Badge variant="warning">
                  {result.ambiguous.length} on several devices
                </Badge>
              )}
            </div>
            {result.unmatched.length > 0 && (
              <SerialList label="Not found" serials={result.unmatched} />
            )}
            {result.ambiguous.length > 0 && (
              <SerialList
                label="On several devices"
                serials={result.ambiguous}
              />
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button
            disabled={!ready || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending
              ? "Adding…"
              : mode === "pick"
                ? `Add ${picked.length || ""}`.trim()
                : `Match ${nSerials || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SerialList({ label, serials }: { label: string; serials: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="max-h-24 overflow-auto rounded-md border border-border p-2 font-mono text-xs">
        {serials.join(", ")}
      </div>
    </div>
  )
}
