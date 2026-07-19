import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Send } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type Webhook, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { WebhookDeleteDialog } from "@/components/webhook-delete-dialog"
import { apiErrorToast } from "@/lib/api-toast"

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

function triggers(w: Webhook): string {
  return (
    [w.on_create && "create", w.on_update && "update", w.on_delete && "delete"]
      .filter(Boolean)
      .join(" · ") || "—"
  )
}

export const Route = createFileRoute("/webhooks/")({ component: WebhooksPage })

function WebhooksPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Webhook | null>(null)

  const query = useQuery({
    queryKey: ["webhooks", q],
    queryFn: () =>
      api<Paginated<Webhook>>(
        `/api/webhooks/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((w: Webhook) => setDeleting(w), [])
  const columns = useMemo<ColumnDef<Webhook>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/webhooks/$id/edit"
            params={{ id: row.original.id }}
            className="flex items-center gap-2 font-medium hover:underline"
          >
            {row.original.name}
            {!row.original.enabled && (
              <Badge variant="secondary" className="text-[10px]">
                disabled
              </Badge>
            )}
          </Link>
        ),
      },
      {
        id: "url",
        accessorKey: "payload_url",
        header: "URL",
        cell: ({ row }) => (
          <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
            {row.original.http_method} {row.original.payload_url}
          </span>
        ),
      },
      {
        id: "types",
        accessorFn: (w) => w.object_types.join(", "),
        header: "Object types",
        cell: ({ row }) => {
          const ts = row.original.object_types
          return (
            <span className="font-mono text-[11px] text-muted-foreground">
              {ts.includes("*") ? "All" : ts.join(", ") || "—"}
            </span>
          )
        },
      },
      {
        id: "triggers",
        header: "Triggers",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {triggers(row.original)}
          </span>
        ),
      },
      {
        id: "secret",
        header: "Signed",
        cell: ({ row }) =>
          row.original.secret_set ? (
            <Badge variant="secondary" className="text-[10px]">
              HMAC
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/webhooks/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
            extra={<TestButton webhook={row.original} />}
          />
        ),
      },
    ],
    [onDelete]
  )

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
          <Button size="sm" asChild>
            <Link to="/webhooks/new">Add webhook</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="url"
        tableId="webhooks"
      />
      <WebhookDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
