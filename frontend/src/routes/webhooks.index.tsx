import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Send } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Webhook } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useMe } from "@/lib/use-me"
import { ListPageShell } from "@/components/list-page-shell"
import { buildWebhookColumns } from "@/components/columns/webhook-columns"
import { WebhookDeleteDialog } from "@/components/webhook-delete-dialog"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { BulkFlagActions } from "@/components/bulk-flag-actions"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlSearch } from "@/lib/url-filters"

// One-click "send a test delivery" for a row.
function TestButton({ webhook }: { webhook: Webhook }) {
  const m = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status_code?: number; error?: string }>(
        `/api/webhooks/${webhook.id}/test/`,
        { method: "POST" }
      ),
    onSuccess: (r) =>
      r.ok
        ? toast.success(`Test OK${r.status_code ? ` (${r.status_code})` : ""}`)
        : toast.error(`Test failed: ${r.error ?? r.status_code}`),
    onError: (err) => apiErrorToast(err),
  })
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title="Send a test delivery"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <Send className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">Send test</span>
    </Button>
  )
}

export const Route = createFileRoute("/webhooks/")({ component: WebhooksPage })

const ENDPOINT = "/api/webhooks/"
const NOUN: [string, string] = ["webhook", "webhooks"]

function WebhooksPage() {
  const { canDo } = useMe()
  const canAdd = canDo("webhook", "add")
  const canEdit = canDo("webhook", "change")
  const canDelete = canDo("webhook", "delete")
  const selectable = canEdit || canDelete
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const [selected, setSelected] = useState<Webhook[]>([])

  const query = useQuery({
    queryKey: ["webhooks", q],
    queryFn: () =>
      apiAll<Webhook>(
        `${ENDPOINT}?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((w: Webhook) => setDeleting(w), [])
  const columns = useMemo(
    () =>
      buildWebhookColumns({
        selection: selectable,
        actions: {
          editTo: "/webhooks/$id/edit",
          editParams: (w) => ({ id: w.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
          extra: (w) => <TestButton webhook={w} />,
        },
      }),
    [onDelete, canEdit, canDelete, selectable]
  )
  const clear = () => setSelected([])

  return (
    <ListPageShell
      title="Webhooks"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter webhooks…",
      }}
      actions={
        <>
          <TableActions ioType="webhook" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/webhooks/new">Add webhook</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        total={query.data?.count}
        columns={columns}
        flexColumn="url"
        tableId="webhooks"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={NOUN}
        invalidate={[["webhooks"]]}
        onCleared={clear}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="webhook"
        actions={
          canEdit && (
            <BulkFlagActions
              endpoint={ENDPOINT}
              field="enabled"
              ids={selected.map((w) => w.id)}
              noun={NOUN}
              invalidate={[["webhooks"]]}
              onDone={clear}
            />
          )
        }
      />
      <WebhookDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
