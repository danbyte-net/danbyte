import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { api, type DeployRun } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { apiErrorToast } from "@/lib/api-toast"

// Re-fire a failed deploy. POSTs /api/deploy-runs/<id>/retry/, which creates a
// fresh linked run (attempt+1, retry_of=this). Invalidates every deploy-runs
// query (list + per-device) so both views refresh.
export function DeployRetryButton({
  run,
  size = "sm",
}: {
  run: DeployRun
  size?: "sm" | "icon"
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<DeployRun>(`/api/deploy-runs/${run.id}/retry/`, { method: "POST" }),
    onSuccess: (r) => {
      toast.success(`Retrying — attempt ${r.attempt}`)
      qc.invalidateQueries({ queryKey: ["deploy-runs"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!run.can_retry) return null

  if (size === "icon") {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        title="Retry deploy"
        disabled={m.isPending}
        onClick={() => m.mutate()}
      >
        {m.isPending ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
        <span className="sr-only">Retry deploy</span>
      </Button>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending ? (
        <Spinner className="size-3.5" />
      ) : (
        <RotateCcw className="size-3.5" />
      )}
      Retry
    </Button>
  )
}
