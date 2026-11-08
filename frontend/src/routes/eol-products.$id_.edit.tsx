import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { EolCustomProduct } from "@/lib/api"
import { EolProductForm } from "@/components/eol-product-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/eol-products/$id_/edit")({
  component: EditEolProductPage,
})

function EditEolProductPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["eol-custom-product", id],
    queryFn: () => api<EolCustomProduct>(`/api/eol/custom-products/${id}/`),
  })
  const back = () => nav({ to: "/eol-products/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "End-of-life products", to: "/eol-products" },
        q.data
          ? { label: q.data.label, to: "/eol-products/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.label}` : "Edit end-of-life product"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <EolProductForm product={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
