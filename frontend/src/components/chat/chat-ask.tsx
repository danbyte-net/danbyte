import { useState } from "react"
import { HelpCircle } from "lucide-react"

import type { ChatAsk } from "@/lib/use-chat-socket"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

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

  const send = (text: string) => {
    if (!text.trim() || disabled || answered) return
    setAnswered(text)
    onAnswer(text)
  }

  const sendFields = () => {
    const filled = ask.fields
      .map((f) => `${f.label}: ${values[f.name] ?? ""}`.trim())
      .filter((line) => !line.endsWith(":"))
    if (filled.length) send(filled.join("\n"))
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[13px] font-medium">{ask.asked}</p>
      </div>

      {ask.options.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {ask.options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={disabled || !!answered}
              onClick={() => send(option.label)}
              className={
                "block w-full rounded-md border border-border px-3 py-2 text-left text-[13px] hover:bg-muted/60 disabled:opacity-60 " +
                (answered === option.label ? "border-primary" : "")
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
        <div className="mt-2 space-y-2">
          {ask.fields.map((field) => (
            <div key={field.name}>
              <label className="text-[11px] text-muted-foreground">
                {field.label}
              </label>
              <Input
                value={values[field.name] ?? ""}
                placeholder={field.placeholder}
                disabled={disabled || !!answered}
                onChange={(e) =>
                  setValues({ ...values, [field.name]: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    sendFields()
                  }
                }}
                className="mt-0.5 h-8 text-[13px]"
              />
            </div>
          ))}
          <Button
            size="sm"
            onClick={sendFields}
            disabled={disabled || !!answered}
          >
            Send
          </Button>
        </div>
      )}

      {answered && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          You answered: {answered}
        </p>
      )}
      {ask.options.length === 0 && ask.fields.length === 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Reply below to carry on.
        </p>
      )}
    </div>
  )
}
