import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Plug,
  Server,
  Webhook,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AutomationKind,
  type AutomationTarget,
  type AutomationTargetWritePayload,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormText, useFieldErrors } from "@/components/forms"
import { docsUrl } from "@/lib/docs"
import { cn } from "@/lib/utils"
import { apiErrorToast } from "@/lib/api-toast"

// A friendlier path to the same AutomationTarget the manual form creates. Three
// steps — pick the kind, fill the connection, review + create — then a done
// panel that tests the connection and points at the next thing to do. Everything
// here funnels into POST /api/automation-targets/, identical payload shape to
// AutomationTargetForm; this just narrates the choices for a first-timer.

type Step = 0 | 1 | 2

const KINDS: {
  value: AutomationKind
  label: string
  blurb: string
  icon: typeof Server
}[] = [
  {
    value: "awx",
    label: "Ansible AWX / AAP",
    blurb:
      "You run AWX or Ansible Automation Platform. Danbyte launches a job template by ID.",
    icon: Server,
  },
  {
    value: "webhook",
    label: "Generic webhook",
    blurb:
      "Anything that can receive a signed HTTP POST — your own runner, CI, a script. Danbyte posts the deploy event.",
    icon: Webhook,
  },
]

const STEP_LABELS = ["What runs it", "Connect", "Review"]

export function AutomationTargetWizard() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [step, setStep] = useState<Step>(0)
  const [kind, setKind] = useState<AutomationKind>("awx")
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [jobTemplateId, setJobTemplateId] = useState("")
  const [token, setToken] = useState("")
  const [created, setCreated] = useState<AutomationTarget | null>(null)

  const create = useMutation({
    mutationFn: () => {
      const payload: AutomationTargetWritePayload = {
        name: name.trim(),
        kind,
        enabled: true,
        base_url: baseUrl.trim(),
        job_template_id: kind === "awx" ? jobTemplateId.trim() : "",
        object_types: ["device"],
      }
      if (token.trim()) payload.token = token
      return api<AutomationTarget>("/api/automation-targets/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["automation-targets"] })
      setCreated(t)
      toast.success(`Created ${t.name}`)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
      // Every editable field lives on the Connect step — jump back so any
      // server-side field error (and its highlight) is actually visible.
      // (Can't read `fieldErrors` here — handleApiError's setState is async,
      // so the closed-over value is still stale this tick.)
      setStep(1)
    },
  })

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; status_code?: number; error?: string }>(
        `/api/automation-targets/${created!.id}/test/`,
        { method: "POST" }
      ),
    onSuccess: (r) =>
      r.ok
        ? toast.success(
            `Reachable${r.status_code ? ` (${r.status_code})` : ""}`
          )
        : toast.error(`Test failed: ${r.error ?? r.status_code}`),
    onError: (err) => apiErrorToast(err),
  })

  if (created) {
    return (
      <div className="max-w-2xl space-y-5">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">
              {created.name} is connected
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Danbyte will hand off deploys to this target. It still never
              touches your devices — your runner does, with its own credentials.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Next
          </div>
          <ol className="space-y-2 text-[13px]">
            <li className="flex items-start gap-2">
              <span className="num mt-0.5 text-muted-foreground">1.</span>
              <span>
                Check it's reachable —{" "}
                <button
                  type="button"
                  onClick={() => test.mutate()}
                  disabled={test.isPending}
                  className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
                >
                  {test.isPending ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Plug className="size-3.5" />
                  )}
                  test connection
                </button>
                .
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="num mt-0.5 text-muted-foreground">2.</span>
              <span>
                Describe the intended config in{" "}
                <Link
                  to="/config-contexts"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Config contexts
                </Link>{" "}
                + an export template.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="num mt-0.5 text-muted-foreground">3.</span>
              <span>
                Open a{" "}
                <Link
                  to="/devices"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  device
                </Link>{" "}
                → <span className="font-medium">Config</span> tab →{" "}
                <span className="font-medium">Deploy</span> and pick this
                target.
              </span>
            </li>
          </ol>
        </div>

        <div className="flex gap-2">
          <Button onClick={() => nav({ to: "/automation-targets" })}>
            Done
          </Button>
          <Button variant="outline" asChild>
            <Link to="/automation-targets/$id/edit" params={{ id: created.id }}>
              Edit advanced settings
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const canNext =
    step === 0
      ? true
      : step === 1
        ? name.trim() &&
          baseUrl.trim() &&
          (kind !== "awx" || jobTemplateId.trim())
        : true

  return (
    <div className="max-w-2xl space-y-6">
      {/* Stepper */}
      <ol className="flex items-center gap-2 text-[13px]">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[11px]",
                i < step && "border-primary bg-primary text-primary-foreground",
                i === step && "border-primary text-foreground",
                i > step && "border-border text-muted-foreground"
              )}
            >
              {i < step ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                i === step
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <span className="mx-1 h-px w-6 bg-border" />
            )}
          </li>
        ))}
      </ol>

      {/* Step 0 — choose kind */}
      {step === 0 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            An <span className="text-foreground">automation target</span> is the
            system Danbyte tells to go run your playbooks. What do you have?
          </p>
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                kind === k.value
                  ? "border-primary bg-muted/50"
                  : "border-border hover:bg-muted/30"
              )}
            >
              <k.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{k.label}</div>
                <div className="text-[12px] text-muted-foreground">
                  {k.blurb}
                </div>
              </div>
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  kind === k.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                )}
              >
                {kind === k.value && <Check className="size-2.5" />}
              </span>
            </button>
          ))}
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
            Just want <span className="text-foreground">drift detection</span>{" "}
            from your own cron? You don't need a target at all — point a runner
            at Danbyte's inventory on a schedule. See{" "}
            <a
              href={docsUrl(
                "features/iac-runner/#how-the-runner-actually-runs"
              )}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              the config-drift guide
            </a>
            .
          </p>
        </div>
      )}

      {/* Step 1 — connection */}
      {step === 1 && (
        <div className="space-y-4">
          <FormText
            label="Name"
            required
            autoFocus
            placeholder={kind === "awx" ? "prod-awx" : "local-runner"}
            hint="How it appears in the deploy picker."
            value={name}
            onChange={setName}
            error={fieldErrors.name}
          />
          <FormText
            label={kind === "awx" ? "AWX controller URL" : "Webhook URL"}
            required
            type="url"
            mono
            placeholder={
              kind === "awx"
                ? "https://awx.example.com"
                : "https://ci.example.com/hook"
            }
            hint={
              kind === "awx"
                ? "The base URL of your AWX/AAP controller."
                : "Where Danbyte POSTs the deploy event."
            }
            value={baseUrl}
            onChange={setBaseUrl}
            error={fieldErrors.base_url}
          />
          {kind === "awx" && (
            <FormText
              label="Job template ID"
              required
              mono
              placeholder="42"
              hint="The numeric ID of the job template to launch."
              value={jobTemplateId}
              onChange={setJobTemplateId}
              error={fieldErrors.job_template_id}
            />
          )}
          <FormText
            label={kind === "awx" ? "Bearer token" : "Signing secret"}
            type="password"
            autoComplete="new-password"
            hint={
              kind === "awx"
                ? "AWX/AAP OAuth token — sent as Authorization: Bearer."
                : "Optional. If set, Danbyte signs the payload (HMAC-SHA512) in X-Danbyte-Signature so your runner can verify it."
            }
            value={token}
            onChange={setToken}
            error={fieldErrors.token}
          />
        </div>
      )}

      {/* Step 2 — review */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Review and create. You can change anything later from the target's
            edit page.
          </p>
          <dl className="divide-y divide-border rounded-lg border border-border text-[13px]">
            {[
              ["Name", name.trim()],
              ["Kind", KINDS.find((k) => k.value === kind)?.label ?? kind],
              [
                kind === "awx" ? "Controller URL" : "Webhook URL",
                baseUrl.trim(),
              ],
              ...(kind === "awx"
                ? [["Job template ID", jobTemplateId.trim()] as const]
                : []),
              [
                kind === "awx" ? "Token" : "Signing secret",
                token.trim() ? "Set" : "Not set",
              ],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-4 px-4 py-2.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="col-span-2 font-mono text-[12px] break-all">
                  {v || "—"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Footer nav */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="ghost"
          onClick={() =>
            step === 0
              ? nav({ to: "/automation-targets" })
              : setStep((s) => (s - 1) as Step)
          }
          disabled={create.isPending}
        >
          {step === 0 ? (
            "Cancel"
          ) : (
            <>
              <ArrowLeft className="size-4" />
              Back
            </>
          )}
        </Button>
        {step < 2 ? (
          <Button
            onClick={() => {
              reset()
              setStep((s) => (s + 1) as Step)
            }}
            disabled={!canNext}
          >
            Next
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending && <Spinner className="size-4" />}
            Create target
          </Button>
        )}
      </div>
    </div>
  )
}
