import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Eye } from "lucide-react"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { CopyButton } from "@/components/kv-card"

/** Fetch an SSID's pre-shared key on demand (#68).
 *
 * The key is never part of the page payload: it lives in the deployment's
 * secret store and each reveal is its own audited request, so the change log
 * records who looked and when. */
export function RevealPskButton({ id }: { id: string }) {
  const [value, setValue] = useState<string | null>(null)
  const reveal = useMutation({
    mutationFn: () =>
      api<{ psk: string }>(`/api/wireless-lans/${id}/reveal-psk/`, {
        method: "POST",
      }),
    onSuccess: (r) => setValue(r.psk),
    onError: (e) => apiErrorToast(e, "Couldn't reveal the key"),
  })
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        title="Reveal the pre-shared key"
        disabled={reveal.isPending}
        onClick={() => reveal.mutate()}
      >
        <Eye className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog
        open={value != null}
        onOpenChange={(o) => !o && setValue(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pre-shared key</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border p-3">
            <code className="min-w-0 flex-1 font-mono text-sm break-all">
              {value}
            </code>
            {value && <CopyButton value={value} />}
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setValue(null)}>
              Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
