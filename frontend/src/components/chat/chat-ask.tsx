import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { HelpCircle } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import type { ChatAsk } from "@/lib/use-chat-socket"
import { Button } from "@/components/ui/button"
import { FormCombobox } from "@/components/forms/combobox"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/chat/markdown"

interface AskField {
  name: string
  label: string
  placeholder: string
  endpoint?: string
  object_type?: string
}

/** A question the assistant put back before doing something it would have
 * been guessing at. Answering sends the reply as the next message, so the
 * work carries on where it left off. */
export function ChatAskForm({
  ask,
  onAnswer,
  disabled,
}: {
  ask: ChatAsk
  onAnswer: (answer: string) => void
  disabled: boolean
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [answered, setAnswered] = useState("")
  const locked = disabled || !!answered

  const send = (text: string) => {
    if (!text.trim() || locked) return
    setAnswered(text)
    onAnswer(text)
  }

  const sendFields = () => {
    const filled = ask.fields
      .filter((f) => (values[f.name] ?? "").trim())
      .map((f) => `${f.label}: ${values[f.name]}`)
    if (filled.length) send(filled.join("\n"))
  }

  const ready = ask.fields.some((f) => (values[f.name] ?? "").trim())

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Markdown text={ask.asked} />
        </div>
      </div>

      {ask.options.length > 0 && (
        <div className="space-y-1.5">
          {ask.options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={locked}
              onClick={() => send(option.label)}
              className={
                "block w-full rounded-md border px-3 py-2 text-left text-[13px] hover:bg-muted/60 disabled:opacity-60 " +
                (answered === option.label ? "border-primary" : "border-border")
              }
            >
              {option.label}
              {option.hint && (
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {option.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {ask.fields.length > 0 && (
        <div className="space-y-2">
          {(ask.fields as AskField[]).map((field) => (
            <AskFieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              disabled={locked}
              onChange={(v) => setValues({ ...values, [field.name]: v })}
              onEnter={sendFields}
            />
          ))}
          <Button size="sm" onClick={sendFields} disabled={locked || !ready}>
            Send
          </Button>
        </div>
      )}

      {answered && (
        <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">
          You answered: {answered}
        </p>
      )}
      {ask.options.length === 0 && ask.fields.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          Reply below to carry on.
        </p>
      )}
    </div>
  )
}

function AskFieldInput({
  field,
  value,
  disabled,
  onChange,
  onEnter,
}: {
  field: AskField
  value: string
  disabled: boolean
  onChange: (v: string) => void
  onEnter: () => void
}) {
  // A field bound to an object type offers what exists rather than asking
  // someone to spell a model number.
  const options = useQuery({
    queryKey: ["chat-ask-options", field.endpoint],
    queryFn: () =>
      api<
        Paginated<{
          id: string
          name?: string
          model?: string
          display?: string
          color?: string
        }>
      >(`${field.endpoint}?limit=500`),
    enabled: !!field.endpoint,
    staleTime: 5 * 60_000,
    retry: false,
  })

  if (field.endpoint) {
    const rows = options.data?.results ?? []
    return (
      <FormCombobox
        label={field.label}
        value={value || null}
        onChange={(v) => onChange(v ?? "")}
        options={rows
          .map((row) => {
            const name = row.name ?? row.model ?? row.display ?? ""
            // A coloured catalog object keeps its pill here too.
            return { value: name, label: name, color: row.color ?? null }
          })
          .filter((o) => o.value)}
        placeholder={
          options.isLoading ? "Loading..." : `Pick a ${field.object_type}`
        }
        searchPlaceholder="Search..."
        emptyText="Nothing matches."
        disabled={disabled}
      />
    )
  }

  return (
    <div>
      <label className="text-[11px] text-muted-foreground">{field.label}</label>
      <Input
        value={value}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            onEnter()
          }
        }}
        className="mt-0.5 h-8 text-[13px]"
      />
    </div>
  )
}
