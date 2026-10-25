import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Unlink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Application,
  ApplicationEol,
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

  const { catalog, suggestions, productOptions } = useProductOptions(
    "platform",
    platform.id
  )
  const releases = useQuery({
    queryKey: ["eol-product", product],
    queryFn: () =>
      api<EolProductRow & { releases: EolRelease[] }>(
        `/api/eol/products/endoflife_date/${encodeURIComponent(product!)}/`
      ),
    enabled: !!product,
    staleTime: 5 * 60_000,
  })

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

/** The cached catalog as combobox options, the subject's suggestions first
 * under their own heading. Offered, never applied: nothing maps until the
 * form is saved. */
function useProductOptions(kind: "platform" | "application", id: string) {
  const catalog = useQuery({
    queryKey: ["eol-products", kind, id],
    queryFn: () =>
      api<{ results: EolProductRow[]; suggestions: EolSuggestion[] }>(
        `/api/eol/products/?limit=2000&${kind}=${id}`
      ),
    staleTime: 5 * 60_000,
  })
  const suggestions = useMemo(
    () => catalog.data?.suggestions ?? [],
    [catalog.data]
  )
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
  return { catalog, suggestions, productOptions }
}

// ─── applications (#436) ─────────────────────────────────────────────────

/** "End of life" card on the application page: the product the
 * application is mapped to and, per cycle its installs run, the cycle's
 * facts. Each install's version picks its cycle, so the dialog asks for the
 * product only. Rendered while the feature is on (`application.eol`). */
export function ApplicationEolCard({
  application,
  canEdit,
}: {
  application: Application
  canEdit: boolean
}) {
  const { formatDate } = useDateFormat()
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const info = application.eol
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["application", application.id] })
    qc.invalidateQueries({ queryKey: ["installed-software"] })
    qc.invalidateQueries({ queryKey: ["lifecycle"] })
  }
  const unmap = useMutation({
    mutationFn: () =>
      api(`/api/applications/${application.id}/eol/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      toast.success("Mapping removed")
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!info) return null
  const mapped = !!info.product
  const rows: KvRow[] = [
    {
      label: "Product",
      value: mapped ? (
        <span className="font-mono text-xs">{info.product}</span>
      ) : (
        <span className="text-muted-foreground">Not mapped</span>
      ),
    },
    ...info.cycles.map((c) => ({
      label: c.cycle,
      value: (
        <span className="inline-flex items-center gap-1.5">
          <EolBadge info={c} />
          {c.eol_date && (
            <span className="num text-xs text-muted-foreground">
              {formatDate(c.eol_date)}
            </span>
          )}
          {c.lts && <Badge variant="secondary">LTS</Badge>}
          {c.missing && <Badge variant="warning">Not in catalog</Badge>}
        </span>
      ),
    })),
    ...(mapped && info.cycles.length === 0
      ? [{ label: "Cycles", value: dash }]
      : []),
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
        <ApplicationEolDialog
          application={application}
          onOpenChange={setOpen}
          onSaved={invalidate}
        />
      )}
    </div>
  )
}

function ApplicationEolDialog({
  application,
  onOpenChange,
  onSaved,
}: {
  application: Application
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [product, setProduct] = useState<string | null>(
    application.eol?.product ?? null
  )
  const { catalog, productOptions } = useProductOptions(
    "application",
    application.id
  )
  const save = useMutation({
    mutationFn: () =>
      api<ApplicationEol>(`/api/applications/${application.id}/eol/`, {
        method: "PUT",
        body: JSON.stringify({ product }),
      }),
    onSuccess: () => {
      onSaved()
      toast.success(`Mapped ${application.name}`)
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
            if (product) save.mutate()
          }}
          className="grid gap-4"
        >
          <FormCombobox
            label="Product"
            required
            value={product}
            onChange={setProduct}
            options={productOptions}
            placeholder={catalog.isLoading ? "Loading…" : "Pick a product"}
            searchPlaceholder="Search products…"
            emptyText="No products - refresh or import the catalog."
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
