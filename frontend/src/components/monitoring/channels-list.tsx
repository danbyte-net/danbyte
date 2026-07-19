import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus, Send } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type ChannelKind,
  type MinSeverity,
  type NotificationChannel,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const CHANNEL_KINDS: { value: ChannelKind; label: string }[] = [
  { value: "slack", label: "Slack" },
  { value: "teams", label: "Microsoft Teams" },
  { value: "discord", label: "Discord" },
  { value: "pagerduty", label: "PagerDuty" },
  { value: "webhook", label: "Webhook" },
  { value: "email", label: "Email" },
]

const KIND_LABEL: Record<ChannelKind, string> = Object.fromEntries(
  CHANNEL_KINDS.map((k) => [k.value, k.label])
) as Record<ChannelKind, string>

const SEV_VARIANT: Record<
  MinSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

export function ChannelsList() {
  const { canDo } = useMe()
  const canAdd = canDo("notificationchannel", "add")
  const canEdit = canDo("notificationchannel", "change")
  const canDelete = canDo("notificationchannel", "delete")
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["channels"],
    queryFn: () =>
      api<Paginated<NotificationChannel>>("/api/monitoring/channels/"),
  })
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null)
  const rows = q.data?.results ?? []

  const testM = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/channels/${id}/test/`, { method: "POST" }),
    onSuccess: () => toast.success("Test alert sent"),
    onError: (err) => apiErrorToast(err),
  })

  const columns: ColumnDef<NotificationChannel>[] = [
    {
      id: "channel",
      accessorFn: (c) => c.name,
      header: ({ column }) => <SortHeader column={column} label="Channel" />,
      cell: ({ row }) => (
        <>
          <Link
            to="/channels/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          {!row.original.enabled && (
            <Badge variant="outline" className="ml-2 h-4 px-1.5 text-[10px]">
              off
            </Badge>
          )}
        </>
      ),
    },
    {
      id: "transport",
      accessorFn: (c) => KIND_LABEL[c.kind] ?? c.kind,
      header: ({ column }) => <SortHeader column={column} label="Transport" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {KIND_LABEL[row.original.kind] ?? row.original.kind}
        </span>
      ),
    },
    {
      id: "min_severity",
      accessorFn: (c) => c.min_severity,
      header: ({ column }) => (
        <SortHeader column={column} label="Min severity" />
      ),
      cell: ({ row }) => (
        <Badge
          variant={SEV_VARIANT[row.original.min_severity]}
          className="capitalize"
        >
          {row.original.min_severity}+
        </Badge>
      ),
    },
    {
      id: "status",
      enableSorting: false,
      header: "Status",
      cell: ({ row }) => (
        <span className="text-[12px] text-muted-foreground">
          {row.original.on_statuses.length
            ? row.original.on_statuses.join("/")
            : "any bad status"}
        </span>
      ),
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: "",
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/channels/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => setDeleting(row.original) : undefined}
          extra={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Send test alert"
              disabled={testM.isPending}
              onClick={() => testM.mutate(row.original.id)}
            >
              <Send className="h-3.5 w-3.5" />
              <span className="sr-only">Send test alert</span>
            </Button>
          }
        />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Where alerts are delivered. Each firing or resolved alert is routed to
          every enabled channel that passes its minimum-severity gate.
        </p>
        {canAdd && (
          <Button size="sm" className="ml-auto" asChild>
            <Link to="/channels/new">
              <Plus className="h-3.5 w-3.5" /> New channel
            </Link>
          </Button>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
          No channels yet — alerts are recorded but not delivered anywhere.
        </div>
      ) : (
        <DataTable
          tableId="channels"
          data={rows}
          columns={columns}
          flexColumn="channel"
        />
      )}

      <DeleteChannel
        channel={deleting}
        onDeleted={() => {
          qc.invalidateQueries({ queryKey: ["channels"] })
          setDeleting(null)
        }}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function DeleteChannel({
  channel,
  onDeleted,
  onOpenChange,
}: {
  channel: NotificationChannel | null
  onDeleted: () => void
  onOpenChange: (o: boolean) => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/channels/${channel!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${channel!.name}`)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!channel} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {channel?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Alerts will no longer be delivered through this channel.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
