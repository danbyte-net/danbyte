import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { HelpCircle } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import type { ChatAsk, ChatAskStep } from "@/lib/use-chat-socket"
import { FormCombobox } from "@/components/forms/combobox"
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"
import { Markdown } from "@/components/chat/markdown"

/** What the assistant asked before doing something it would otherwise be
 * guessing at.
 *
 * Several questions become a step-by-step form with a progress bar, so
 * nobody faces four at once and answers two. Either way the answers travel
 * back as one message and the work carries on where it left off. */
export function ChatAskForm({
  ask,
  onAnswer,
  disabled,
}: {
  ask: ChatAsk
  onAnswer: (answer: string) => void
  disabled: boolean
}) {
  const steps = ask.steps
  const [sent, setSent] = useState("")
  // Steps bound to an object type are pickers, which keep their value here
  // rather than in the questionnaire's own form state.
  const [picked, setPicked] = useState<Record<string, string>>({})
  const locked = disabled || !!sent

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked) return
    const form = new FormData(event.currentTarget)
    const lines = steps
      .map((step) => {
        const value = picked[step.name] || String(form.get(step.name) ?? "")
        return value.trim() ? `${step.title} → ${value.trim()}` : ""
      })
      .filter(Boolean)
    if (!lines.length) return
    setSent(lines.join("\n"))
    onAnswer(lines.join("\n"))
  }

  if (steps.length === 0) {
    return (
      <Shell asked={ask.asked}>
        <p className="text-[11px] text-muted-foreground">
          Reply below to carry on.
        </p>
      </Shell>
    )
  }

  return (
    <Shell asked={steps.length > 1 ? ask.asked : ""}>
      <Questionnaire
        className="gap-4"
        defaultItem={steps[0].name}
        items={steps.map((s) => ({ name: s.name, required: true }))}
        onSubmit={submit}
      >
        {steps.length > 1 && (
          <QuestionnaireProgress
            className="w-full text-[11px] text-muted-foreground"
            render={(props, state) => (
              <div {...props}>
                <div className="mb-1.5 flex gap-1.5" aria-hidden="true">
                  {Array.from({ length: state.total }, (_, i) => (
                    <span
                      key={i}
                      className={
                        i < state.current
                          ? "h-1 flex-1 rounded-full bg-primary"
                          : "h-1 flex-1 rounded-full bg-muted"
                      }
                    />
                  ))}
                </div>
                <span>
                  Step {state.current} of {state.total}
                </span>
              </div>
            )}
          />
        )}

        {steps.map((step) => (
          <QuestionnaireItem key={step.name} name={step.name} required>
            <QuestionnaireTitle className="text-[13px]">
              {step.title}
            </QuestionnaireTitle>
            <StepInput
              step={step}
              disabled={locked}
              picked={picked[step.name] ?? ""}
              onPick={(v) => setPicked({ ...picked, [step.name]: v })}
            />
          </QuestionnaireItem>
        ))}

        <QuestionnaireActions>
          <QuestionnairePrevious />
          <QuestionnaireNext>Next</QuestionnaireNext>
          <QuestionnaireSubmit disabled={locked}>Done</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>

      {sent && (
        <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">
          You answered:{"\n"}
          {sent}
        </p>
      )}
    </Shell>
  )
}

function Shell({
  asked,
  children,
}: {
  asked: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      {asked && (
        <div className="flex items-start gap-2">
          <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Markdown text={asked} />
          </div>
        </div>
      )}
      {children}
    </div>
  )
}

function StepInput({
  step,
  disabled,
  picked,
  onPick,
}: {
  step: ChatAskStep
  disabled: boolean
  picked: string
  onPick: (v: string) => void
}) {
  // A step bound to an object type offers what exists rather than asking
  // someone to spell a model number.
  const options = useQuery({
    queryKey: ["chat-ask-options", step.endpoint],
    queryFn: () =>
      api<
        Paginated<{
          id: string
          name?: string
          model?: string
          display?: string
          color?: string
        }>
      >(`${step.endpoint}?limit=500`),
    enabled: !!step.endpoint,
    staleTime: 5 * 60_000,
    retry: false,
  })

  if (step.choices.length > 0) {
    return (
      <QuestionnaireChoices>
        {step.choices.map((choice) => (
          <QuestionnaireChoice
            key={choice.label}
            value={choice.label}
            disabled={disabled}
          >
            {choice.label}
            {choice.hint && (
              <QuestionnaireChoiceDescription>
                {choice.hint}
              </QuestionnaireChoiceDescription>
            )}
          </QuestionnaireChoice>
        ))}
      </QuestionnaireChoices>
    )
  }

  if (step.endpoint) {
    const rows = options.data?.results ?? []
    return (
      <>
        <FormCombobox
          label=""
          value={picked || null}
          onChange={(v) => onPick(v ?? "")}
          options={rows
            .map((row) => ({
              value: row.name ?? row.model ?? row.display ?? "",
              label: row.name ?? row.model ?? row.display ?? "",
              color: row.color ?? null,
            }))
            .filter((o) => o.value)}
          placeholder={
            options.isLoading
              ? "Loading..."
              : `Pick a ${humanise(step.object_type)}`
          }
          searchPlaceholder="Search..."
          emptyText="Nothing matches."
          disabled={disabled}
        />
        {/* The questionnaire tracks answers through the form, so the picker
            mirrors its value into a field it can see. */}
        <input type="hidden" name={step.name} value={picked} readOnly />
      </>
    )
  }

  return (
    <QuestionnaireInput placeholder={step.placeholder} disabled={disabled} />
  )
}

/** "devicetype" reads as "device type" to a person. */
function humanise(slug: string | undefined): string {
  const known: Record<string, string> = {
    devicetype: "device type",
    devicerole: "device role",
    virtualmachine: "virtual machine",
    ipaddress: "IP address",
    iprange: "IP range",
    circuittermination: "circuit termination",
  }
  if (!slug) return "option"
  return known[slug] ?? slug
}
