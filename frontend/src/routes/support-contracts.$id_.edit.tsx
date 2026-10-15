import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { SupportContract } from "@/lib/api"
import { SupportContractForm } from "@/components/support-contract-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/support-contracts/$id_/edit")({
  component: EditSupportContractPage,
})

function EditSupportContractPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["support-contract", id],
    queryFn: () => api<SupportContract>(`/api/support-contracts/${id}/`),
  })
  const back = () => nav({ to: "/support-contracts/$id", params: { id } })
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Support contracts", to: "/support-contracts" },
        { label: q.data?.contract_number ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit contract"
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <SupportContractForm contract={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
