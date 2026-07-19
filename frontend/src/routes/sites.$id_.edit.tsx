import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api, type Paginated, type Prefix, type Site } from "@/lib/api"
import { SiteForm } from "@/components/site-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/sites/$id_/edit")({
  component: EditSitePage,
})

function EditSitePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["site", id],
    queryFn: () => api<Site>(`/api/sites/${id}/`),
  })
  const backToDetail = () => nav({ to: "/sites/$id", params: { id } })

  return (
    <EditPageShell
      presenceType="site"
      presenceId={id}
      crumbs={[
        { label: "Sites", to: "/sites" },
        q.data
          ? { label: q.data.name, to: "/sites/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit site"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <>
          <SiteForm
            site={q.data}
            onSaved={backToDetail}
            onCancel={backToDetail}
          />
          <AddressScopePanel siteId={id} />
        </>
      )}
    </EditPageShell>
  )
}

/**
 * Compact pointer to the site's address scope. The ranges themselves are
 * managed on the detail page's Prefixes tab (a site can own several), but
 * people instinctively look for "this site's subnet" on the edit form — so
 * show what's assigned and link straight to where it's managed.
 */
function AddressScopePanel({ siteId }: { siteId: string }) {
  const { canDo } = useMe()
  const q = useQuery({
    queryKey: ["site-prefixes", siteId],
    queryFn: () =>
      api<Paginated<Prefix>>(`/api/prefixes/?site=${siteId}&page_size=500`),
  })
  const rows = q.data?.results ?? []

  return (
    <section className="mt-8 max-w-2xl rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Address scope</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Prefix ranges assigned to this site. Site-scoped users can only
            carve child prefixes within these. Managed on the{" "}
            <Link
              to="/sites/$id"
              params={{ id: siteId }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Prefixes tab
            </Link>
            .
          </p>
        </div>
        {canDo("prefix", "add") && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            asChild
          >
            <Link
              to="/prefixes/new"
              search={{
                cidr: undefined,
                vrf: undefined,
                site: siteId,
                location: undefined,
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add prefix range
            </Link>
          </Button>
        )}
      </div>

      <div className="mt-3">
        {q.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading ranges…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No address ranges assigned yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {rows.map((p) => (
              <li key={p.id}>
                <Link
                  to="/prefixes/$id"
                  params={{ id: p.id }}
                  className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {p.cidr}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
