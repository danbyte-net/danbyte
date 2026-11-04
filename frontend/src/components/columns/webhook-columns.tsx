import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Webhook } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of webhooks" - /webhooks builds here.
// The signing secret and the headers are write-only: the table shows only
// whether a secret is set.

export type WebhookColumnId = "name" | "url" | "types" | "triggers" | "secret"

const CANONICAL_ORDER: WebhookColumnId[] = [
  "name",
  "url",
  "types",
  "triggers",
  "secret",
]

export interface WebhookColumnOpts<T extends Webhook = Webhook> {
  omit?: WebhookColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** The events a webhook fires on, in a few words. */
export function webhookTriggers(w: Webhook): string {
  return (
    [w.on_create && "create", w.on_update && "update", w.on_delete && "delete"]
      .filter(Boolean)
      .join(" · ") || "-"
  )
}

export function buildWebhookColumns<T extends Webhook = Webhook>(
  opts: WebhookColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<WebhookColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/webhooks/$id/edit"
          params={{ id: row.original.id }}
          className="link flex items-center gap-2 font-medium"
        >
          {row.original.name}
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </Link>
      ),
    }),
    url: () => ({
      id: "url",
      accessorKey: "payload_url",
      header: "URL",
      cell: ({ row }) => (
        <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
          {row.original.http_method} {row.original.payload_url}
        </span>
      ),
    }),
    types: () => ({
      id: "types",
      accessorFn: (w) => w.object_types.join(", "),
      header: "Object types",
      cell: ({ row }) => {
        const ts = row.original.object_types
        return (
          <span className="font-mono text-[11px] text-muted-foreground">
            {ts.includes("*") ? "All" : ts.join(", ") || "-"}
          </span>
        )
      },
    }),
    triggers: () => ({
      id: "triggers",
      header: "Triggers",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {webhookTriggers(row.original)}
        </span>
      ),
    }),
    secret: () => ({
      id: "secret",
      header: "Signed",
      cell: ({ row }) =>
        row.original.secret_set ? (
          <Badge variant="secondary" className="text-[10px]">
            HMAC
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
