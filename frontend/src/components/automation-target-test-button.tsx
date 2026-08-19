import { useMutation } from "@tanstack/react-query"
import { Plug } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { AutomationTarget } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { apiErrorToast } from "@/lib/api-toast"

/** One-click "is this target reachable" probe - POST /automation-targets/<id>/test/.
 * Shared by the list row and the target's detail header so the probe behaves
 * identically in both. */
export function AutomationTargetTestButton({
  target,
  variant = "icon",
}: {
  target: AutomationTarget
  /** `icon` for a table row, `button` for a labelled header action. */
  variant?: "icon" | "button"
}) {
  const m = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status_code?: number; error?: string }>(
        `/api/automation-targets/${target.id}/test/`,
        { method: "POST" }
      ),
    onSuccess: (r) =>
      r.ok
        ? toast.success(
            `Reachable${r.status_code ? ` (${r.status_code})` : ""}`
          )
        : toast.error(`Test failed: ${r.error ?? r.status_code}`),
    onError: (err) => apiErrorToast(err),
  })

  if (variant === "button")
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={m.isPending}
        onClick={() => m.mutate()}
      >
        <Plug className="h-3.5 w-3.5" />
        {m.isPending ? "Testing…" : "Test"}
      </Button>
    )

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title="Test connection"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <Plug className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">Test connection</span>
    </Button>
  )
}
