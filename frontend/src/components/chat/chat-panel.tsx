import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, History, Plus, Send, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { ChatConversation, ChatConversationDetail } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useChatSocket } from "@/lib/use-chat-socket"
import { usePageContext } from "@/lib/use-page-context"
import type { ChatTurn } from "@/lib/use-chat-socket"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { ChatMessage } from "@/components/chat/chat-message"

const SUGGESTIONS = [
  "Which devices are at my largest site?",
  "What changed on my core switches in the last 48 hours?",
  "Which hardware goes end of support within a year?",
]

export function ChatPanel({
  onClose,
  configured,
  model,
}: {
  onClose: () => void
  configured: boolean
  model: string
}) {
  const chat = useChatSocket()
  const pageContext = usePageContext()
  const [text, setText] = useState("")
  const [showHistory, setShowHistory] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  // Opening the panel should land you back where you were, not on a blank
  // page. Restored once per open; "New conversation" opts out.
  const restored = useRef(false)

  const recent = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: () =>
      api<{ results: ChatConversation[] }>("/api/assistant/conversations/"),
  })
  const latestId = recent.data?.results[0]?.id

  const resume = useMutation({
    mutationFn: (id: string) =>
      api<ChatConversationDetail>(`/api/assistant/conversations/${id}/`),
    onSuccess: (detail) => chat.load(detail.id, toTurns(detail)),
  })

  useEffect(() => {
    if (restored.current || !latestId || chat.turns.length > 0) return
    restored.current = true
    resume.mutate(latestId)
  }, [latestId, chat.turns.length, resume])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [chat.turns])

  const send = () => {
    const question = text.trim()
    if (!question || chat.busy || !chat.connected) return
    chat.ask(question, pageContext)
    setText("")
  }

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        // No backdrop blur: this sits open beside the page you are asking
        // about, so that page has to stay readable.
        overlayClassName="backdrop-blur-none supports-backdrop-filter:backdrop-blur-none bg-black/5"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="sr-only">Ask Danbyte</SheetTitle>
        </SheetHeader>

        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
          {showHistory ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back"
              onClick={() => setShowHistory(false)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <span className="text-sm font-medium">Ask Danbyte</span>
          )}
          {showHistory && (
            <span className="text-sm font-medium">Conversations</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!showHistory && (chat.model || model) && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {chat.model || model}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New conversation"
              onClick={() => {
                restored.current = true // do not pull the old one back
                chat.reset()
                setShowHistory(false)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Past conversations"
              onClick={() => setShowHistory((was) => !was)}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {showHistory ? (
          <HistoryList
            onOpen={(id, turns) => {
              restored.current = true
              chat.load(id, turns)
              setShowHistory(false)
            }}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {!configured ? (
                <EmptyState title="No model is configured">
                  A deployment admin connects one under{" "}
                  <Link to="/settings/security" className="link">
                    Settings → Security
                  </Link>
                  .
                </EmptyState>
              ) : resume.isPending ? (
                <p className="py-6 text-center text-[13px] text-muted-foreground">
                  Loading your last conversation...
                </p>
              ) : chat.turns.length === 0 ? (
                <Opening
                  onPick={(q) => chat.ask(q, pageContext)}
                  disabled={!chat.connected}
                  context={pageContext}
                />
              ) : (
                chat.turns.map((turn) => (
                  <ChatMessage
                    key={turn.id}
                    turn={turn}
                    busy={chat.busy}
                    onAnswer={(answer) => chat.ask(answer, pageContext)}
                  />
                ))
              )}
              <div ref={endRef} />
            </div>

            <div className="shrink-0 border-t border-border p-3">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                rows={2}
                placeholder={
                  chat.connected ? "Ask about your network…" : "Connecting…"
                }
                disabled={!chat.connected || !configured}
                className="resize-none text-[13px]"
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {chat.busy
                    ? "Working…"
                    : chat.connected
                      ? "It answers with your own access. Enter to send."
                      : "Not connected."}
                </span>
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={send}
                  disabled={!text.trim() || chat.busy || !chat.connected}
                >
                  <Send className="h-3.5 w-3.5" />
                  {chat.busy ? "Asking…" : "Ask"}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Opening({
  onPick,
  disabled,
  context,
}: {
  onPick: (q: string) => void
  disabled: boolean
  context: { type: string; label: string } | null
}) {
  // On a detail page, offer something about the thing you are looking at.
  const suggestions = context
    ? [
        `What is on this ${context.type}?`,
        `What changed on this ${context.type} in the last 7 days?`,
        ...SUGGESTIONS.slice(0, 2),
      ]
    : SUGGESTIONS
  return (
    <div className="space-y-3 py-6">
      <p className="text-[13px] text-muted-foreground">
        Ask about your own inventory. It reads what you can read, nothing more,
        and every lookup it makes is shown.
      </p>
      {context?.label && (
        <p className="text-[12px] text-muted-foreground">
          You are on <span className="font-medium">{context.label}</span>, so
          "this {context.type}" means that one.
        </p>
      )}
      <div className="space-y-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="block w-full rounded-md border border-border px-3 py-2 text-left text-[13px] hover:bg-muted/50 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function HistoryList({
  onOpen,
}: {
  onOpen: (id: string, turns: ChatTurn[]) => void
}) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: () =>
      api<{ results: ChatConversation[] }>("/api/assistant/conversations/"),
  })
  const open = useMutation({
    mutationFn: (id: string) =>
      api<ChatConversationDetail>(`/api/assistant/conversations/${id}/`),
    onSuccess: (detail) => onOpen(detail.id, toTurns(detail)),
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/assistant/conversations/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat-conversations"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const clear = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/api/assistant/conversations/", {
        method: "DELETE",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat-conversations"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const rows = list.data?.results ?? []
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {rows.length === 0 ? (
        <EmptyState title="Nothing yet">
          Conversations you have are kept here, and only you can see them.
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-1">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => open.mutate(c.id)}
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
                >
                  <div className="truncate text-[13px]">
                    {c.title || "Untitled"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {c.message_count} message{c.message_count === 1 ? "" : "s"}{" "}
                    · <TimeCell iso={c.last_message_at ?? c.created_at} />
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete conversation"
                  onClick={() => remove.mutate(c.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
          >
            Delete all
          </Button>
        </>
      )}
    </div>
  )
}

function toTurns(detail: ChatConversationDetail): ChatTurn[] {
  const out: ChatTurn[] = []
  for (const m of detail.messages) {
    if (m.role === "tool") {
      const last = out.at(-1)
      const call = {
        name: String(m.tool.name ?? ""),
        args: (m.tool.arguments ?? {}) as Record<string, unknown>,
        rows: Number(m.tool.rows ?? 0),
        error: String(m.tool.error ?? ""),
      }
      if (last?.role === "assistant") last.tools.push(call)
      else
        out.push({
          id: m.id,
          role: "assistant",
          text: "",
          tools: [call],
        })
      continue
    }
    out.push({
      id: m.id,
      role:
        m.role === "user" ? "user" : m.role === "error" ? "error" : "assistant",
      text: m.text,
      tools: [],
    })
  }
  return out
}
