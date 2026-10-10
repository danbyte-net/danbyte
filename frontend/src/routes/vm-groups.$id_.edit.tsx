import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { VirtualMachineGroup } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { VmGroupForm } from "@/components/vm-group-form"

export const Route = createFileRoute("/vm-groups/$id_/edit")({
  component: EditVmGroupPage,
})

function EditVmGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["vm-group", id],
    queryFn: () => api<VirtualMachineGroup>(`/api/vm-groups/${id}/`),
  })
  const back = () => nav({ to: "/vm-groups/$id", params: { id } })

  return (
    <EditPageShell
      crumbs={[
        { label: "VM groups", to: "/vm-groups" },
        q.data
          ? { label: q.data.name, to: "/vm-groups/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit VM group"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && <VmGroupForm group={q.data} onSaved={back} onCancel={back} />}
    </EditPageShell>
  )
}
