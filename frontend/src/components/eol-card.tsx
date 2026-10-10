import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Unlink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  EolInfo,
  EolProductRow,
  EolRelease,
  EolSuggestion,
  Platform,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCombobox, FormFooter } from "@/components/forms"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EolBadge } from "@/components/cells/eol-cell"

// "End of life" overview card on the platform page (#8): the endoflife.date
// product + cycle the platform is mapped to and the cycle's facts. Only
// rendered while a deployment admin has the feature on (platform.eol != null).

export function EolCard({
  platform,
  canEdit,
}: {
  platform: Platform
  canEdit: boolean
}) {
  const { formatDate } = useDateFormat()
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const info = platform.eol
  const unmap = useMutation({
    mutationFn: () =>
      api(`/api/eol/platforms/${platform.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform", platform.id] })
      toast.success("Mapping removed")
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!info) return null
  const fmt = (d: string | null | undefined) =>
    d ? <span className="num">{formatDate(d)}</span> : dash
  const mapped = !!info.product
  const rows: KvRow[] = [
    { label: "Status", value: <EolBadge info={info} /> },
    ...(mapped
      ? [
          {
            label: "Product",
            value: (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-xs">
                  {info.product} {info.cycle}
                </span>
                {info.lts && <Badge variant="secondary">LTS</Badge>}
                {info.missing && (
                  <Badge variant="warning">Not in catalog</Badge>
                )}
              </span>
            ),
          },
          { label: "Released", value: fmt(info.release_date) },
          { label: "Active support until", value: fmt(info.support_until) },
          { label: "End of life", value: fmt(info.eol_date) },
          {
            label: "Latest version",
            value: info.latest_version ? (
              <span className="font-mono text-xs">{info.latest_version}</span>
            ) : (
              dash
            ),
          },
        ]
      : [
          {
            label: "Product",
            value: <span className="text-muted-foreground">Not mapped</span>,
          },
        ]),
  ]
  return (
    <div className="space-y-2">
      <KvCard title="End of life" rows={rows} />
      {canEdit && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5" /> {mapped ? "Change" : "Map"}
          </Button>
          {mapped && (
            <Button
              variant="ghost"
              size="sm"
              disabled={unmap.isPending}
              onClick={() => unmap.mutate()}
            >
              <Unlink className="h-3.5 w-3.5" />
              {unmap.isPending ? "Removing…" : "Remove"}
            </Button>
          )}
        </div>
      )}
      {open && (
        <EolMappingDialog
          platform={platform}
          info={info}
          onOpenChange={setOpen}
        />
      )}
    </div>
  )
}

function EolMappingDialog({
  platform,
  info,
  onOpenChange,
}: {
  platform: Platform
  info: EolInfo
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { formatDate } = useDateFormat()
  const [product, setProduct] = useState<string | null>(info.product ?? null)
  const [cycle, setCycle] = useState<string | null>(info.cycle ?? null)

  const catalog = useQuery({
    queryKey: ["eol-products", platform.id],
    queryFn: () =>
      api<{ results: EolProductRow[]; suggestions: EolSuggestion[] }>(
        `/api/eol/products/?limit=2000&platform=${platform.id}`
      ),
    staleTime: 5 * 60_000,
  })
  const releases = useQuery({
    queryKey: ["eol-product", product],
    queryFn: () =>
      api<EolProductRow & { releases: EolRelease[] }>(
        `/api/eol/products/endoflife_date/${encodeURIComponent(product!)}/`
      ),
    enabled: !!product,
    staleTime: 5 * 60_000,
  })

  const suggestions = catalog.data?.suggestions ?? []
  // Suggestions lead, under their own heading. They are offered, never
  // applied: nothing maps until the form is saved.
  const productOptions = useMemo(() => {
    const suggested = new Set(suggestions.map((s) => s.name))
    return [
      ...suggestions.map((s) => ({
        value: s.name,
        label: s.label,
        group: "Suggested",
        hint: s.name,
      })),
      ...(catalog.data?.results ?? [])
        .filter((p) => !suggested.has(p.name))
        .map((p) => ({
          value: p.name,
          label: p.label,
          group: "All products",
          hint: p.name,
        })),
    ]
  }, [catalog.data, suggestions])

  const cycleOptions = (releases.data?.releases ?? []).map((r) => ({
    value: r.name,
    label: r.label || r.name,
    hint: r.eol_date
      ? `EoL ${formatDate(r.eol_date)}`
      : r.eol
        ? "End of life"
        : undefined,
  }))

  const save = useMutation({
    mutationFn: () =>
      api<EolInfo>(`/api/eol/platforms/${platform.id}/`, {
        method: "PUT",
        body: JSON.stringify({ product, cycle }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform", platform.id] })
      toast.success(`Mapped ${platform.name}`)
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End-of-life mapping</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (product && cycle) save.mutate()
          }}
          className="grid gap-4"
        >
          <FormCombobox
            label="Product"
            required
            value={product}
            onChange={(v) => {
              setProduct(v)
              const s = suggestions.find((x) => x.name === v)
              setCycle(s?.cycle || null)
            }}
            options={productOptions}
            placeholder={catalog.isLoading ? "Loading…" : "Pick a product"}
            searchPlaceholder="Search products…"
            emptyText="No products - refresh or import the catalog."
          />
          <FormCombobox
            label="Cycle"
            required
            value={cycle}
            onChange={setCycle}
            options={cycleOptions}
            disabled={!product}
            placeholder={releases.isLoading ? "Loading…" : "Pick a cycle"}
            searchPlaceholder="Search cycles…"
            emptyText="No cycles."
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel="Save mapping"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
