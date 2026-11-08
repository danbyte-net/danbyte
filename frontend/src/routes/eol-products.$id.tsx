import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink, Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Application, EolCustomProduct } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EolCyclesEditor } from "@/components/eol-cycles-editor"
import { EolProductDeleteDialog } from "@/components/eol-product-delete-dialog"

export const Route = createFileRoute("/eol-products/$id")({
  component: EolProductDetail,
})

function EolProductDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["eol-custom-product", id],
    queryFn: () => api<EolCustomProduct>(`/api/eol/custom-products/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body product={q.data} />
}

type Tab = "overview" | "applications" | "journal" | "history"

function Body({ product: p }: { product: EolCustomProduct }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<EolCustomProduct | null>(null)
  const goBack = useCallback(() => nav({ to: "/eol-products" }), [nav])
  const { canDo } = useMe()

  const rows: KvRow[] = [
    { label: "Name", value: p.label, copy: p.label },
    { label: "Key", value: mono(p.name), copy: p.name },
    { label: "Source", value: <Badge variant="secondary">Custom</Badge> },
    {
      label: "Link",
      value: p.link ? (
        <a
          href={p.link}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex items-center gap-1"
        >
          {p.link}
          <ExternalLink className="h-3 w-3 text-muted-foreground" />
        </a>
      ) : (
        dash
      ),
    },
    {
      label: "Platforms",
      value: <span className="num">{p.platform_count}</span>,
    },
    { label: "Notes", value: p.notes || dash },
  ]

  return (
    <DetailShell
      backTo="/eol-products"
      backLabel="End-of-life products"
      title={p.label}
      presence={{ type: "eolproduct", id: p.id }}
      actions={
        <>
          {canDo("eolproduct", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/eol-products/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("eolproduct", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(p)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={p.label}
          badges={<Badge variant="secondary">Custom</Badge>}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "applications",
          label: "Applications",
          count: p.application_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-4">
          <div className="max-w-xl">
            <KvCard title="End-of-life product" rows={rows} />
          </div>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Cycles</h2>
            <EolCyclesEditor
              product={p}
              canEdit={canDo("eolproduct", "change")}
            />
          </section>
        </div>
      </DetailTab>
      <DetailTab value="applications">
        <ProductApplications product={p} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="compliance.eolproduct" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="compliance.eolproduct" objectId={p.id} />
      </DetailTab>

      <EolProductDeleteDialog
        product={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The applications mapped to the product. */
function ProductApplications({ product }: { product: EolCustomProduct }) {
  const q = useQuery({
    queryKey: ["applications", "eol-product", product.name],
    queryFn: () =>
      apiAll<Application>(
        `/api/applications/?${new URLSearchParams({
          eol_source: product.source,
          eol_product: product.name,
        }).toString()}`
      ),
  })
  const columns = useMemo<ColumnDef<Application>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <Link
            to="/applications/$id"
            params={{ id: row.original.id }}
            hash="eol"
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "installs",
        accessorKey: "install_count",
        header: "Installs",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.install_count}</span>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "-"}
          </span>
        ),
      },
    ],
    []
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (!rows.length)
    return (
      <EmptyState title="No applications">
        Map an application to this product from its End of life card.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="eol-product-applications"
      flexColumn="description"
      embedded
    />
  )
}
