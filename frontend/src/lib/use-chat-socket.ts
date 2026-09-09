import { useCallback, useEffect, useRef, useState } from "react"

import type { ChatCardData } from "@/components/chat/chat-card"

/** One turn of the conversation as the panel sees it. */
export interface ChatTurn {
  id: string
  role: "user" | "assistant" | "error"
  text: string
  tools: ChatToolCall[]
  pending?: boolean
  /** A question the assistant put back, rendered as a small form. */
  ask?: ChatAsk | null
}

export interface ChatAskChoice {
  label: string
  hint: string
}

export interface ChatAskStep {
  name: string
  title: string
  choices: ChatAskChoice[]
  endpoint?: string
  object_type?: string
  placeholder?: string
  free_text?: boolean
}

export interface ChatAsk {
  asked: string
  steps: ChatAskStep[]
}

export interface ChatToolCall {
  name: string
  args: Record<string, unknown>
  rows: number
  error: string
  card?: ChatCardData | null
}

/** Which object the person has open, so "this device" resolves. */
export interface PageContext {
  type: string
  id: string
  label: string
}

type Frame =
  | { t: "ready"; model: string; writes: boolean }
  | { t: "start"; conversation: string; title: string }
  | { t: "delta"; d: string }
  | {
      t: "tool"
      name: string
      args: Record<string, unknown>
      rows: number
      error: string
      card?: ChatCardData | null
    }
  | ({ t: "ask" } & ChatAsk)
  | { t: "done"; message: string }
  | { t: "error"; m: string }
  | { t: "pong" }

const PING_MS = 25_000

/** The chat runs over the WebSocket process, not the API: gunicorn's sync
 * workers would hold a request open for the whole answer and still time it
 * out at 60 seconds. */
export function useChatSocket() {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState("")
  const [error, setError] = useState("")
  const socket = useRef<WebSocket | null>(null)
  const conversation = useRef<string | null>(null)

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/chat/`)
    socket.current = ws

    ws.onmessage = (event) => {
      let frame: Frame
      try {
        frame = JSON.parse(event.data as string) as Frame
      } catch {
        return
      }
      if (frame.t === "ready") {
        setConnected(true)
        setModel(frame.model)
        return
      }
      if (frame.t === "start") {
        conversation.current = frame.conversation
        return
      }
      if (frame.t === "delta") {
        setTurns((was) => appendText(was, frame.d))
        return
      }
      if (frame.t === "tool") {
        setTurns((was) => appendTool(was, frame))
        return
      }
      if (frame.t === "ask") {
        setTurns((was) => {
          const last = was.at(-1)
          if (!last || last.role !== "assistant") return was
          return [...was.slice(0, -1), { ...last, ask: frame }]
        })
        return
      }
      if (frame.t === "done") {
        setBusy(false)
        setTurns((was) =>
          was.map((turn) => (turn.pending ? { ...turn, pending: false } : turn))
        )
        return
      }
      if (frame.t === "error") {
        setBusy(false)
        setError(frame.m)
        setTurns((was) => [
          ...was.filter((t) => !t.pending || t.text || t.tools.length),
          { id: crypto.randomUUID(), role: "error", text: frame.m, tools: [] },
        ])
      }
    }
    ws.onclose = () => {
      setConnected(false)
      setBusy(false)
    }
    const ping = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ t: "ping" }))
    }, PING_MS)
    return () => {
      window.clearInterval(ping)
      ws.close()
    }
  }, [])

  const ask = useCallback((text: string, context?: PageContext | null) => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    setError("")
    setBusy(true)
    setTurns((was) => [
      ...was,
      { id: crypto.randomUUID(), role: "user", text, tools: [] },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "",
        tools: [],
        pending: true,
      },
    ])
    ws.send(
      JSON.stringify({
        t: "ask",
        text,
        conversation: conversation.current ?? undefined,
        context: context ?? undefined,
      })
    )
  }, [])

  const reset = useCallback(() => {
    conversation.current = null
    setTurns([])
    setError("")
  }, [])

  const load = useCallback((id: string, loaded: ChatTurn[]) => {
    conversation.current = id
    setTurns(loaded)
    setError("")
  }, [])

  return {
    turns,
    connected,
    busy,
    model,
    error,
    ask,
    reset,
    load,
    conversationId: conversation,
  }
}

function appendText(turns: ChatTurn[], text: string): ChatTurn[] {
  const last = turns.at(-1)
  if (!last || last.role !== "assistant") return turns
  return [...turns.slice(0, -1), { ...last, text: last.text + text }]
}

function appendTool(turns: ChatTurn[], call: ChatToolCall): ChatTurn[] {
  const last = turns.at(-1)
  if (!last || last.role !== "assistant") return turns
  return [
    ...turns.slice(0, -1),
    {
      ...last,
      tools: [
        ...last.tools,
        {
          name: call.name,
          args: call.args,
          rows: call.rows,
          error: call.error,
          card: call.card ?? null,
        },
      ],
    },
  ]
}
