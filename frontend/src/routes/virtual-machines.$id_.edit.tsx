import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type VirtualMachine } from "@/lib/api"
import { VmForm } from "@/components/vm-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/virtual-machines/$id_/edit")({
  component: EditVmPage,
})

function EditVmPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["virtual-machine", id],
    queryFn: () => api<VirtualMachine>(`/api/virtual-machines/${id}/`),
  })
  const backToDetail = () =>
    nav({ to: "/virtual-machines/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "Virtual machines", to: "/virtual-machines" },
        q.data
          ? { label: q.data.name, to: "/virtual-machines/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit virtual machine"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <VmForm vm={q.data} onSaved={backToDetail} onCancel={backToDetail} />
      )}
    </EditPageShell>
  )
}
