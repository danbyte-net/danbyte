import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ChatStatus } from "@/lib/api"
import { useChatDock } from "@/components/chat/chat-dock"
import { ChatPanel } from "@/components/chat/chat-panel"

/** Mounts the chat as a column beside the app.
 *
 * Kept apart from the provider so the layout can render it without the
 * top-bar button pulling the whole panel into every page. */
export function ChatDock() {
  const { open, setOpen } = useChatDock()
  const status = useQuery({
    queryKey: ["chat-status"],
    queryFn: () => api<ChatStatus>("/api/assistant/status/"),
    staleTime: 5 * 60_000,
    retry: false,
  })

  if (!open || !status.data?.enabled) return null
  return (
    <ChatPanel
      onClose={() => setOpen(false)}
      configured={status.data.configured}
      model={status.data.model}
    />
  )
}
