import type { ColumnDef } from "@tanstack/react-table"
import { RotateCw } from "lucide-react"

import type { ItemState, ProductState } from "@/lib/vuln-browser-sync"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// The products of a browser sync (#451): one row per CPE product the run
// fetches from NVD, with how far it got. Only the sync page shows them.

export const SYNC_STATE_LABEL: Record<ItemState, string> = {
  waiting: "Waiting",
  fetching: "Fetching",
  done: "Posted",
  failed: "Failed",
}

export const SYNC_STATE_VARIANT: Record<
  ItemState,
  "secondary" | "info" | "success" | "destructive"
> = {
  waiting: "secondary",
  fetching: "info",
  done: "success",
  failed: "destructive",
}

export function SyncStateBadge({ state }: { state: ItemState }) {
  return (
    <Badge variant={SYNC_STATE_VARIANT[state]}>{SYNC_STATE_LABEL[state]}</Badge>
  )
}

export function vulnSyncProductColumns(opts: {
  onRetry?: (product: string) => void
}): ColumnDef<ProductState>[] {
  return [
    {
      id: "product",
      accessorKey: "product",
      header: "Product",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          cpe:2.3:{row.original.product}
        </span>
      ),
    },
    {
      id: "state",
      accessorKey: "state",
      header: "State",
      cell: ({ row }) => <SyncStateBadge state={row.original.state} />,
    },
    {
      id: "records",
      header: "Records",
      cell: ({ row }) => {
        const p = row.original
        return (
          <span className="num text-xs text-muted-foreground">
            {p.total === null ? "…" : `${p.startIndex} / ${p.total}`}
          </span>
        )
      },
    },
    {
      id: "error",
      accessorKey: "error",
      header: "Problem",
      cell: ({ row }) => (
        <span className="text-xs text-destructive">{row.original.error}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableHiding: false,
      cell: ({ row }) =>
        row.original.state === "failed" && opts.onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => opts.onRetry?.(row.original.product)}
          >
            <RotateCw />
            Retry
          </Button>
        ) : null,
    },
  ]
}
