import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { ChevronDown, Mail } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Email a period's report: to the agreement's recipients, or once to
 * addresses typed here (not saved on the agreement). */
export function SlaEmailReport({
  base,
  period,
  recipients,
}: {
  /** The agreement's API path, without the trailing slash. */
  base: string
  period: string
  recipients: string[]
}) {
  const [open, setOpen] = useState(false)
  const [other, setOther] = useState("")
  const send = useMutation({
    mutationFn: (to: string[] | null) =>
      api(`${base}/send-report/`, {
        method: "POST",
        body: JSON.stringify(to ? { period, recipients: to } : { period }),
      }),
    onSuccess: (_d, to) => {
      toast.success(`Report sent to ${(to ?? recipients).join(", ")}`)
      setOpen(false)
      setOther("")
    },
    onError: (e) => apiErrorToast(e),
  })
  const typed = other
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={send.isPending}>
          <Mail className="h-3.5 w-3.5" />
          {send.isPending ? "Sending..." : "Email report"}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-start"
          disabled={send.isPending || recipients.length === 0}
          onClick={() => send.mutate(null)}
        >
          <span className="truncate">
            {recipients.length
              ? `Recipients: ${recipients.join(", ")}`
              : "No recipients set"}
          </span>
        </Button>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.length) send.mutate(typed)
          }}
        >
          <label
            htmlFor="sla-report-once"
            className="text-xs whitespace-nowrap text-muted-foreground"
          >
            Send once to
          </label>
          <div className="flex gap-2">
            <Input
              id="sla-report-once"
              type="text"
              inputMode="email"
              className="h-8"
              placeholder="name@example.com"
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              disabled={send.isPending || typed.length === 0}
            >
              Send
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
