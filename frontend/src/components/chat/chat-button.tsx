import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { MessagesSquare } from "lucide-react"

import { api } from "@/lib/api"
import type { ChatStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ChatPanel } from "@/components/chat/chat-panel"

/** Typing somewhere? Then the hotkey belongs to that field, not to us. */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable
  )
}

/** Top-bar entry to the in-app chat. Absent until an admin turns it on for
 * the tenant, so nobody sees a button that cannot work. */
export function ChatButton() {
  const [open, setOpen] = useState(false)
  const status = useQuery({
    queryKey: ["chat-status"],
    queryFn: () => api<ChatStatus>("/api/assistant/status/"),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const available = status.data?.enabled ?? false

  useEffect(() => {
    if (!available) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey)) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      setOpen((was) => !was)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [available])

  if (!available) return null

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Ask Danbyte"
            onClick={() => setOpen(true)}
          >
            <MessagesSquare className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" variant="panel">
          Ask Danbyte
          <span className="ml-2 text-muted-foreground">⌘J</span>
        </TooltipContent>
      </Tooltip>
      {open && (
        <ChatPanel
          onClose={() => setOpen(false)}
          configured={status.data?.configured ?? false}
          model={status.data?.model ?? ""}
        />
      )}
    </>
  )
}
