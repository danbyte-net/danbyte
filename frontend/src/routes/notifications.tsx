import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type NotificationChannel,
  type NotificationChannelSummary,
  type NotificationMe,
  type NotificationMeRow,
  type NotificationSubscription,
  type Paginated,
  type RBACGroup,
  type RBACUser,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormSelect } from "@/components/forms"

export const Route = createFileRoute("/notifications")({
  component: NotificationsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    tab: (s.tab as string) === "admin" ? "admin" : "you",
  }),
})

// ─── helpers ────────────────────────────────────────────────────────────────

function sendsLabel(ch: NotificationChannelSummary): string {
  const bits = ["Alerts"]
  if (ch.send_status_changes)
    bits.push(`Status changes (${ch.status_change_mode})`)
  return bits.join(" · ")
}

function scopeLabel(ch: NotificationChannelSummary): string {
  const parts: string[] = []
  if (ch.match_prefix_cidr) parts.push(ch.match_prefix_cidr)
  if (ch.on_statuses?.length) parts.push(ch.on_statuses.join("/"))
  return parts.join(" · ") || "all"
}

function SourceBadge({ source }: { source: string }) {
  if (source === "self") return <Badge variant="info">Self</Badge>
  if (source === "assigned") return <Badge variant="secondary">Assigned</Badge>
  if (source === "direct") return <Badge variant="outline">Direct</Badge>
  if (source.startsWith("group:"))
    return <Badge variant="secondary">via {source.slice(6)}</Badge>
  return <Badge variant="outline">{source}</Badge>
}

// ─── page ─────────────────────────────────────────────────────────────────

function NotificationsPage() {
  const { canManage, canDo } = useMe()
  const nav = useNavigate({ from: Route.fullPath })
  const { tab } = Route.useSearch()
  const canAdmin = canManage || canDo("notificationsubscription", "view")

  const items = [
    { value: "you", label: "For you" },
    ...(canAdmin ? [{ value: "admin", label: "All channels" }] : []),
  ]

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you're subscribed to, and — for admins — every channel and who it
          reaches.
        </p>
      </div>
      <SegmentedTabs
        items={items}
        value={canAdmin ? tab : "you"}
        onValueChange={(v) => nav({ search: { tab: v }, replace: true })}
      />
      {tab === "admin" && canAdmin ? <AdminTab /> : <ForYouTab />}
    </div>
  )
}

// ─── "For you" ──────────────────────────────────────────────────────────────

function ForYouTab() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["notifications-me"],
    queryFn: () => api<NotificationMe>("/api/monitoring/notifications/me/"),
  })

  const unsub = useMutation({
    mutationFn: (channel: string) =>
      api("/api/monitoring/notifications/unsubscribe/", {
        method: "POST",
        body: JSON.stringify({ channel }),
      }),
    onSuccess: () => {
      toast.success("Unsubscribed")
      qc.invalidateQueries({ queryKey: ["notifications-me"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const sub = useMutation({
    mutationFn: (channel: string) =>
      api("/api/monitoring/notifications/subscribe/", {
        method: "POST",
        body: JSON.stringify({ channel }),
      }),
    onSuccess: () => {
      toast.success("Subscribed")
      qc.invalidateQueries({ queryKey: ["notifications-me"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<NotificationMeRow>[]>(
    () => [
      {
        id: "channel",
        header: "Channel",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.channel.name}</span>
        ),
      },
      {
        id: "sends",
        header: "Sends",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {sendsLabel(row.original.channel)}
          </span>
        ),
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <span className="font-mono text-[12px] text-muted-foreground">
            {scopeLabel(row.original.channel)}
          </span>
        ),
      },
      {
        id: "source",
        header: "Via",
        cell: ({ row }) => <SourceBadge source={row.original.source} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          row.original.can_unsubscribe ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={unsub.isPending}
                onClick={() => unsub.mutate(row.original.channel.id)}
              >
                Unsubscribe
              </Button>
            </div>
          ) : (
            <div className="flex justify-end pr-2 text-[11px] text-muted-foreground">
              {row.original.mandatory ? "Required" : ""}
            </div>
          ),
      },
    ],
    [unsub]
  )

  if (q.isError) return <QueryError error={q.error} />
  const data = q.data
  const subs = data?.subscriptions ?? []
  const available = data?.available ?? []

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Subscribed</h2>
        {subs.length === 0 ? (
          <EmptyState title="You're not subscribed to anything yet.">
            Admin- and group-assigned notifications appear here automatically.
            Anything you can opt into is listed below.
          </EmptyState>
        ) : (
          <DataTable data={subs} columns={columns} tableId="my-subscriptions" />
        )}
      </section>

      {available.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Available to join</h2>
          <div className="divide-y divide-border rounded-lg border border-border">
            {available.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <div className="font-medium">{ch.name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {sendsLabel(ch)} · {scopeLabel(ch)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!data?.can_subscribe || sub.isPending}
                  onClick={() => sub.mutate(ch.id)}
                >
                  <Plus className="h-3.5 w-3.5" /> Subscribe
                </Button>
              </div>
            ))}
          </div>
          {!data?.can_subscribe && (
            <p className="text-[11px] text-muted-foreground">
              You don't have permission to change your own subscriptions — ask
              an administrator.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

// ─── admin: all channels + subscriptions ────────────────────────────────────

function AdminTab() {
  const { canDo, canManage } = useMe()
  const canWrite = canManage || canDo("notificationsubscription", "add")
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)

  const subsQ = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () =>
      api<Paginated<NotificationSubscription>>(
        "/api/monitoring/subscriptions/"
      ),
  })
  const delM = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/subscriptions/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed")
      qc.invalidateQueries({ queryKey: ["subscriptions"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<NotificationSubscription>[]>(
    () => [
      {
        id: "channel",
        header: "Channel",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.channel_name}</span>
        ),
      },
      {
        id: "subscriber",
        header: "Subscriber",
        cell: ({ row }) =>
          row.original.group ? (
            <Badge variant="secondary">group · {row.original.group_name}</Badge>
          ) : (
            <span>{row.original.user_username}</span>
          ),
      },
      {
        id: "mandatory",
        header: "Type",
        cell: ({ row }) =>
          row.original.mandatory ? (
            <Badge variant="secondary">Mandatory</Badge>
          ) : (
            <Badge variant="outline">Self</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={delM.isPending}
                onClick={() => delM.mutate(row.original.id)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </div>
          ) : null,
      },
    ],
    [canWrite, delM]
  )

  if (subsQ.isError) return <QueryError error={subsQ.error} />
  const rows = subsQ.data?.results ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Every subscription across channels — the groups and users each channel
          reaches. Group subscriptions fan out to members; mandatory ones can't
          be self-removed.
        </p>
        {canWrite && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add subscription
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No subscriptions yet.">
          Attach a group or user to an email channel so they receive its
          notifications. No channels yet?{" "}
          <Link
            to="/channels/new"
            className="font-medium text-primary underline"
          >
            Create one
          </Link>
          . For a single prefix or IP, the quickest path is the{" "}
          <span className="font-medium">Notify me</span> button on its
          Monitoring tab.
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} tableId="subscriptions" />
      )}
      {adding && (
        <AddSubscriptionDialog
          open={adding}
          onOpenChange={setAdding}
          onSaved={() => qc.invalidateQueries({ queryKey: ["subscriptions"] })}
        />
      )}
    </div>
  )
}

function AddSubscriptionDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const [channel, setChannel] = useState<string | null>(null)
  const [kind, setKind] = useState<"group" | "user">("group")
  const [group, setGroup] = useState<string | null>(null)
  const [user, setUser] = useState<string | null>(null)
  const [mandatory, setMandatory] = useState(true)

  const channelsQ = useQuery({
    queryKey: ["channels"],
    queryFn: () =>
      api<Paginated<NotificationChannel>>("/api/monitoring/channels/"),
  })
  const groupsQ = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
  })
  const usersQ = useQuery({
    queryKey: ["users", ""],
    queryFn: () => api<Paginated<RBACUser>>("/api/users/"),
  })

  const save = useMutation({
    mutationFn: () =>
      api("/api/monitoring/subscriptions/", {
        method: "POST",
        body: JSON.stringify({
          channel,
          group: kind === "group" ? Number(group) : null,
          user: kind === "user" ? Number(user) : null,
          mandatory,
        }),
      }),
    onSuccess: () => {
      toast.success("Subscription added")
      onSaved()
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const emailChannels = (channelsQ.data?.results ?? []).filter(
    (c) => c.kind === "email"
  )
  const ready = channel && (kind === "group" ? group : user)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add subscription</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {emailChannels.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
              No email channels yet. A channel is the email list a subscription
              points at.{" "}
              <Link
                to="/channels/new"
                className="font-medium text-primary underline"
              >
                Create one
              </Link>{" "}
              first, or use the per-prefix/IP{" "}
              <span className="font-medium">Notify me</span> button on a
              prefix's Monitoring tab.
            </div>
          ) : (
            <FormSelect
              label="Channel"
              value={channel}
              onChange={setChannel}
              placeholder="Pick an email channel"
              options={emailChannels.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
          )}
          <FormSelect
            label="Subscriber type"
            value={kind}
            onChange={(v) => setKind((v as "group" | "user") ?? "group")}
            options={[
              { value: "group", label: "Group" },
              { value: "user", label: "User" },
            ]}
          />
          {kind === "group" ? (
            <FormSelect
              label="Group"
              value={group}
              onChange={setGroup}
              placeholder="Pick a group"
              options={(groupsQ.data?.results ?? []).map((g) => ({
                value: String(g.id),
                label: g.name,
              }))}
            />
          ) : (
            <FormSelect
              label="User"
              value={user}
              onChange={setUser}
              placeholder="Pick a user"
              options={(usersQ.data?.results ?? []).map((u) => ({
                value: String(u.id),
                label: u.email ? `${u.username} · ${u.email}` : u.username,
              }))}
            />
          )}
          <FormCheckbox
            label="Mandatory"
            checked={mandatory}
            onChange={setMandatory}
            hint="The subscriber can't remove this themselves. Group subscriptions are always mandatory for members."
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
