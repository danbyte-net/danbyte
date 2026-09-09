import { useState } from "react"
import { ChevronRight, Wrench } from "lucide-react"

import type { ChatToolCall, ChatTurn } from "@/lib/use-chat-socket"
import { Badge } from "@/components/ui/badge"
import { ChatCard } from "@/components/chat/chat-card"
import { Markdown } from "@/components/chat/markdown"
import { cn } from "@/lib/utils"

/** One turn. Bordered card, author line, wrapped body - the shape the
 * journal panel already uses, so a transcript looks like the product. */
export function ChatMessage({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user"
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        isUser
          ? "border-border bg-muted/40"
          : turn.role === "error"
            ? "border-destructive/40 bg-destructive/10"
            : "border-border bg-card"
      )}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">
          {isUser ? "You" : turn.role === "error" ? "Problem" : "Danbyte"}
        </span>
        {turn.pending && !turn.text && <span>thinking…</span>}
      </div>

      {turn.tools.map((call, i) => (
        <ToolLine key={`${call.name}-${i}`} call={call} />
      ))}

      {turn.text && <Markdown text={turn.text} />}

      {cardsIn(turn).map((card) => (
        <div key={card.id} className="mt-2">
          <ChatCard card={card} />
        </div>
      ))}
    </div>
  )
}

/** What the assistant looked up, so an answer can be checked rather than
 * taken on trust. Collapsed to one line; expands to the arguments. */
function ToolLine({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false)
  const summary = call.error
    ? call.error
    : `${call.name} · ${call.rows} row${call.rows === 1 ? "" : "s"}`
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted/50"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <Wrench className="h-3 w-3" />
        <span className="truncate">{summary}</span>
        {call.error && (
          <Badge variant="destructive" className="ml-auto">
            refused
          </Badge>
        )}
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
          {JSON.stringify(call.args, null, 2)}
        </pre>
      )}
    </div>
  )
}

/** One card per object the answer touched, newest wins if a tool ran twice
 * against the same row. */
function cardsIn(turn: ChatTurn) {
  const seen = new Map<string, NonNullable<ChatToolCall["card"]>>()
  for (const call of turn.tools) {
    if (call.card) seen.set(call.card.id, call.card)
  }
  return [...seen.values()]
}
