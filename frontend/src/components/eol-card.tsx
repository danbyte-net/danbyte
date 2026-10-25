import { useEffect, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Pencil,
  RefreshCw,
  Unlink,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Application,
  ApplicationEol,
  ApplicationEolDetail,
  ApplicationEolDetailCycle,
  EolInfo,
  EolProductRow,
  EolRelease,
  EolSuggestion,
  Platform,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
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
import { EolBadge, useEolSettings } from "@/components/cells/eol-cell"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

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

type CycleRow = ApplicationEolDetailCycle & {
  id: string
  /** The installs no cycle took. */
  unmapped?: boolean
  /** A catalog cycle nothing runs. */
  idle?: boolean
}

/** The settings card where the end-of-life source is configured. */
const EOL_SETTINGS_HASH = "end-of-life-data"

/** "End of life" card on the application page: the product the application
 * is mapped to, linked to the source's page, and a table of its cycles -
 * each with its dates, time left and the installs on it, linked to the
 * Installed on tab filtered to that cycle. Each install's version picks its
 * cycle, so the dialog asks for the product only. Rendered while the
 * feature is on (`application.eol`); `#eol` scrolls to it. */
export function ApplicationEolCard({
  application,
  canEdit,
}: {
  application: Application
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const [allCycles, setAllCycles] = useState(false)
  const qc = useQueryClient()
  const { canManageDeployment } = useMe()
  const settings = useEolSettings()
  const info = application.eol
  const detail = useQuery({
    queryKey: ["application", application.id, "eol"],
    queryFn: () =>
      api<ApplicationEolDetail>(`/api/applications/${application.id}/eol/`),
    enabled: !!info,
  })
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
  const refresh = useMutation({
    mutationFn: () => api("/api/eol/refresh/", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["eol-settings"] })
      toast.success("Refresh queued")
    },
    onError: (err) => apiErrorToast(err),
  })
  const loaded = !!detail.data
  useEffect(() => {
    if (loaded && window.location.hash === "#eol")
      document.getElementById("eol")?.scrollIntoView({ block: "start" })
  }, [loaded])

  const columns = useMemo(
    () => eolCycleColumns(application.id, settings.data?.warning_days ?? null),
    [application.id, settings.data?.warning_days]
  )
  if (!info) return null
  const d = detail.data
  const mapped = !!(d?.product ?? info.product)

  const rows: KvRow[] = []
  if (d && mapped) {
    rows.push({
      label: "Source",
      value: canManageDeployment ? (
        <Link to="/settings/admin" hash={EOL_SETTINGS_HASH} className="link">
          {d.source_label ?? d.source}
        </Link>
      ) : (
        (d.source_label ?? d.source)
      ),
    })
  }
  rows.push({
    label: "Product",
    value: !mapped ? (
      <span className="text-muted-foreground">Not mapped</span>
    ) : (
      <ProductLink detail={d} product={(d?.product ?? info.product)!} />
    ),
  })
  const onCycles = (d?.cycles ?? []).reduce((n, c) => n + c.install_count, 0)
  const note = !d
    ? null
    : d.in_catalog === false
      ? "Not in the cached catalog."
      : mapped && onCycles === 0 && d.unmapped_installs > 0
        ? "No install's version matches a cycle of this product."
        : null

  const tableRows: CycleRow[] = d
    ? [
        ...d.cycles.map((c) => ({ ...c, id: `c:${c.cycle}` })),
        ...(d.unmapped_installs > 0
          ? [
              {
                id: "unmapped",
                unmapped: true,
                cycle: "",
                status: "unknown" as const,
                install_count: d.unmapped_installs,
              },
            ]
          : []),
        ...(allCycles
          ? d.other_cycles.map((c) => ({
              ...c,
              id: `o:${c.cycle}`,
              idle: true,
            }))
          : []),
      ]
    : []

  return (
    <section id="eol" className="scroll-mt-4 space-y-2">
      <KvCard title="End of life" rows={rows} />
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {detail.isLoading && <Loading />}
      {detail.isError && <QueryError error={detail.error} />}
      {d && mapped && tableRows.length > 0 && (
        <DataTable
          data={tableRows}
          columns={columns}
          tableId="application-eol-cycles"
          flexColumn="cycle"
          embedded
          rowClassName={(r) => (r.idle ? "text-muted-foreground" : undefined)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5" />
            {mapped ? "Change product" : "Map"}
          </Button>
        )}
        {canEdit && mapped && (
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
        {canManageDeployment && mapped && (
          <Button
            variant="ghost"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {refresh.isPending ? "Refreshing…" : "Refresh now"}
          </Button>
        )}
        {d && d.other_cycles.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={allCycles}
            onClick={() => setAllCycles((v) => !v)}
          >
            {allCycles ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {allCycles ? "Fewer cycles" : "All cycles"}
            {!allCycles && (
              <Badge variant="secondary" className="num">
                {d.other_cycles.length}
              </Badge>
            )}
          </Button>
        )}
      </div>
      {open && (
        <ApplicationEolDialog
          application={application}
          onOpenChange={setOpen}
          onSaved={invalidate}
        />
      )}
    </section>
  )
}

function ProductLink({
  detail,
  product,
}: {
  detail: ApplicationEolDetail | undefined
  product: string
}) {
  const label = detail?.product_label
  const name = (
    <>
      {label ?? <span className="font-mono text-xs">{product}</span>}
      {label && label !== product && (
        <span className="ml-1.5 font-mono text-xs text-muted-foreground">
          {product}
        </span>
      )}
    </>
  )
  if (!detail?.product_url) return name
  return (
    <a
      href={detail.product_url}
      target="_blank"
      rel="noreferrer"
      className="link inline-flex items-center gap-1"
    >
      {name}
      <ExternalLink className="h-3 w-3 text-muted-foreground" />
    </a>
  )
}

function InstallsLink({ appId, row }: { appId: string; row: CycleRow }) {
  if (row.install_count === 0)
    return <span className="num text-muted-foreground">0</span>
  return (
    <Link
      to="/applications/$id"
      params={{ id: appId }}
      search={{ tab: "installs", cycle: row.unmapped ? "none" : row.cycle }}
      className="link num"
    >
      {row.install_count}
    </Link>
  )
}

function DateCell({ value }: { value: string | null | undefined }) {
  const { formatDate } = useDateFormat()
  if (!value) return dash
  return <span className="num whitespace-nowrap">{formatDate(value)}</span>
}

function eolCycleColumns(
  appId: string,
  warningDays: number | null
): ColumnDef<CycleRow, unknown>[] {
  const none = (r: CycleRow) => r.unmapped
  return [
    {
      id: "cycle",
      accessorKey: "cycle",
      header: "Cycle",
      enableSorting: false,
      cell: ({ row }) =>
        none(row.original) ? (
          <span className="text-muted-foreground">Unmapped</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">{row.original.cycle}</span>
            {row.original.missing && (
              <Badge variant="warning">Not in catalog</Badge>
            )}
          </span>
        ),
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) =>
        none(row.original) ? dash : <EolBadge info={row.original} />,
    },
    {
      id: "release_date",
      header: "Released",
      enableSorting: false,
      cell: ({ row }) => <DateCell value={row.original.release_date} />,
    },
    {
      id: "eol_date",
      header: "End of life",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.eol_date ? (
          <span className="inline-flex items-center gap-2">
            <DateCell value={row.original.eol_date} />
            <LifetimeBar
              start={row.original.release_date}
              end={row.original.eol_date}
              warningDays={warningDays}
            />
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "latest_version",
      header: "Latest",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.latest_version ? (
          <span className="font-mono text-xs">
            {row.original.latest_version}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "lts",
      header: "LTS",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.lts ? <Badge variant="secondary">LTS</Badge> : dash,
    },
    {
      id: "installs",
      header: "Installs",
      enableSorting: false,
      cell: ({ row }) => <InstallsLink appId={appId} row={row.original} />,
    },
  ]
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
