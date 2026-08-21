import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Bell } from "lucide-react"

import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { TimeCell } from "@/components/cells/time-ago"

/** One in-app notification, as /api/notifications/ serves it. */
interface AppNotification {
  id: string
  kind: string
  title: string
  body: string
  url: string
  actor_name: string
  read_at: string | null
  created_at: string
}

interface NotificationPayload {
  unread: number
  results: AppNotification[]
}

/**
 * The topbar bell: task assignments, team-queue arrivals, comments and
 * @mentions land here the moment they happen (emails are the opt-out channel;
 * the bell always hears). Clicking a row opens its object and marks it read.
 */
export function NotificationBell() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["app-notifications"],
    queryFn: () => api<NotificationPayload>("/api/notifications/"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const unread = q.data?.unread ?? 0
  const rows = q.data?.results ?? []

  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) =>
      api<NotificationPayload>("/api/notifications/read/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => qc.setQueryData(["app-notifications"], data),
  })

  const open = (n: AppNotification) => {
    if (!n.read_at) markRead.mutate({ ids: [n.id] })
    if (n.url) nav({ to: n.url })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="num absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          {/* The popup is the overview; the title is the way into the full
              page (the sidebar entry moved here, issue #62). */}
          <Link
            to="/notifications"
            search={{ tab: "you" }}
            className="link text-[12px] font-semibold"
            title="Open all notifications"
          >
            Notifications
          </Link>
          {unread > 0 && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {rows.length === 0 && (
            <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              Nothing yet - task assignments, comments and @mentions land here.
            </p>
          )}
          {rows.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => open(n)}
              className="flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted/60"
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  n.read_at ? "bg-transparent" : "bg-primary"
                }`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12.5px] ${
                    n.read_at ? "" : "font-medium"
                  }`}
                >
                  {n.title}
                </span>
                {n.body && (
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {n.body}
                  </span>
                )}
                <span className="block text-[10.5px] text-muted-foreground">
                  <TimeCell iso={n.created_at} />
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
