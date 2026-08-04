import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, BellRing } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { apiErrorToast } from "@/lib/api-toast"

/** A one-click "email me about this prefix/IP" toggle. Backed by an auto-created
 * scoped channel + a self subscription — the user never has to think about
 * channels. Pass exactly one of `prefix` / `ip` (the object id). */
export function NotifyMeButton({
  prefix,
  ip,
}: {
  prefix?: string
  ip?: string
}) {
  const qc = useQueryClient()
  const qs = prefix ? `prefix=${prefix}` : `ip=${ip}`
  const key = ["watch-state", prefix ?? ip]

  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ watching: boolean; can_watch: boolean }>(
        `/api/monitoring/notifications/watch-state/?${qs}`
      ),
  })

  const m = useMutation({
    mutationFn: (watch: boolean) =>
      api(`/api/monitoring/notifications/${watch ? "watch" : "unwatch"}/`, {
        method: "POST",
        body: JSON.stringify(prefix ? { prefix } : { ip }),
      }),
    onSuccess: (_r, watch) => {
      toast.success(
        watch ? "You'll be emailed on status changes" : "Notifications stopped"
      )
      qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!q.data) return null
  const { watching, can_watch } = q.data
  // Nothing to show if the user can't self-manage and isn't already watching.
  if (!can_watch && !watching) return null

  return (
    <Button
      size="sm"
      variant={watching ? "secondary" : "outline"}
      disabled={m.isPending || (!can_watch && !watching)}
      title={
        !can_watch
          ? "Needs the notification-subscribe permission and an account email"
          : undefined
      }
      onClick={() => m.mutate(!watching)}
    >
      {watching ? (
        <>
          <BellRing className="h-3.5 w-3.5" /> Notifying you
        </>
      ) : (
        <>
          <Bell className="h-3.5 w-3.5" /> Notify me
        </>
      )}
    </Button>
  )
}
