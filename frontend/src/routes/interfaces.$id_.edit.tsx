import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Interface } from "@/lib/api"
import { safeReturnPath } from "@/lib/return-url"
import { InterfaceForm } from "@/components/interface-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { PendingFieldsProvider } from "@/lib/pending-fields"
import { planSearch } from "@/lib/save-object"

export const Route = createFileRoute("/interfaces/$id_/edit")({
  // Plan mode: ?plan=<taskId>&planBoard=<boardId> turns this form into
  // "record what changed on that task" instead of writing.
  // `?ret=` (issue #76): opened from a device tab or list, save/cancel
  // return there instead of the interface detail page.
  validateSearch: (s: Record<string, unknown>) => {
    const ret = safeReturnPath(s.ret)
    return { ...planSearch(s), ...(ret ? { ret } : {}) }
  },
  component: EditInterfacePage,
})

function EditInterfacePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const router = useRouter()
  const { ret } = Route.useSearch()
  const q = useQuery({
    queryKey: ["interface", id],
    queryFn: () => api<Interface>(`/api/interfaces/${id}/`),
  })
  const back = () => {
    if (ret) router.history.push(ret)
    else void nav({ to: "/interfaces/$id", params: { id } })
  }
  return (
    <EditPageShell
      className="max-w-5xl"
      crumbs={[
        { label: "Interfaces", to: "/interfaces" },
        q.data
          ? { label: q.data.name, to: "/interfaces/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit interface"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      <PendingFieldsProvider objectType="api.interface" objectId={id}>
        {q.data && (
          <InterfaceForm iface={q.data} onSaved={back} onCancel={back} />
        )}
      </PendingFieldsProvider>
    </EditPageShell>
  )
}
