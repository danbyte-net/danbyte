import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  VulnAnalysisJustification,
  VulnAnalysisResponse,
  VulnAnalysisState,
  VulnException,
  VulnExceptionScopes,
  VulnExceptionStatus,
  VulnExceptionWrite,
  VulnMatch,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import {
  Field,
  FormCheckbox,
  FormDate,
  FormSection,
  FormSelect,
  FormTextarea,
} from "@/components/forms"
import { Loading } from "@/components/loading"
import { PersonPicker } from "@/components/person-picker"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  JUSTIFICATION_LABELS,
  RESPONSE_LABELS,
  SCOPE_LABELS,
  STATE_LABELS,
  STATUS_LABELS,
  STATUS_STATES,
  analysisFor,
  createBodies,
  defaultAnalysis,
  defaultScope,
  editPatch,
  expiryError,
  maxExpiry,
  scopeOptions,
  subjectName,
} from "@/components/vulnerabilities/exception-rules"
import type {
  Analysis,
  ExceptionDraft,
  ScopeChoice,
} from "@/components/vulnerabilities/exception-rules"

// Add or edit a vulnerability exception (#451). Adding takes one or more
// matches (selected rows, or one row's action) and writes one exception per
// record and subject the chosen scope gives; editing changes the status,
// reason, owner, expiry and analysis - the record and scope stay.

export const EXCEPTIONS_ENDPOINT = "/api/vulnerability-exceptions/"

/** Who may add, change and delete exceptions. */
export function useExceptionPerms() {
  const { canDo } = useMe()
  return {
    canAdd: canDo("vulnerabilityexception", "add"),
    canChange: canDo("vulnerabilityexception", "change"),
    canDelete: canDo("vulnerabilityexception", "delete"),
  }
}

/** Everything that shows an exception or what it covers. */
export function invalidateExceptions(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    "vulnerability-exceptions",
    "vulnerability-exception",
    "vulnerabilities",
    "vulnerability",
    "vulnerability-matches",
  ])
    void qc.invalidateQueries({ queryKey: [key] })
}

const STATUS_ITEMS = (Object.keys(STATUS_LABELS) as VulnExceptionStatus[]).map(
  (v) => ({ value: v, label: STATUS_LABELS[v] })
)

/** The owner sent: the picked one with the people picker; else yourself on
 * an add, and the current owner (unchanged) on an edit. */
export function ownerFor(o: {
  canPickOwner: boolean
  editing: boolean
  picked: number | null
  you: number | null
}): number | null {
  if (o.canPickOwner || o.editing) return o.picked
  return o.you
}

function fieldErrorsOf(err: unknown): Record<string, string> | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null
  if (!err.body || typeof err.body !== "object") return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(err.body as Record<string, unknown>))
    out[k] = Array.isArray(v) ? String(v[0]) : String(v)
  return out
}

/** A second exception for a record and scope already covered. */
const isDuplicate = (e: Record<string, string> | null) =>
  !!e &&
  Object.keys(e).length === 1 &&
  /already has an active/.test(e.vuln_id ?? "")

export function ExceptionDialog({
  open,
  onOpenChange,
  matches,
  exception,
  kind,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Add: the matches to except. */
  matches?: VulnMatch[]
  /** Edit: the exception. */
  exception?: VulnException | null
  /** The page it opens from, for the scope's wording and default. */
  kind?: "device" | "virtual_machine" | "platform" | "application" | "record"
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        {open && (
          <Body
            matches={matches ?? []}
            exception={exception ?? null}
            kind={kind}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Body({
  matches,
  exception,
  kind,
  onDone,
}: {
  matches: VulnMatch[]
  exception: VulnException | null
  kind?: "device" | "virtual_machine" | "platform" | "application" | "record"
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { today } = useDateFormat()
  const editing = !!exception
  const scopesQ = useQuery({
    queryKey: ["vulnerability-exception-scopes"],
    queryFn: () => api<VulnExceptionScopes>(`${EXCEPTIONS_ENDPOINT}scopes/`),
    staleTime: 60_000,
    // An edit needs only `change`; without `add` this answers 403 and the
    // owner simply stays as it is.
    retry: false,
  })
  const canPickOwner = scopesQ.data?.can_pick_owner ?? false
  const you = scopesQ.data?.you ?? null
  const options = useMemo(
    () => scopeOptions(matches, scopesQ.data?.scopes ?? [], kind),
    [matches, scopesQ.data, kind]
  )
  const [picked, setScope] = useState<ScopeChoice | null>(null)
  // The page's own subject, or the host, until one is picked.
  const scope =
    picked && options.some((o) => o.value === picked)
      ? picked
      : defaultScope(options, kind)

  const [draft, setDraft] = useState<ExceptionDraft>(() =>
    exception
      ? {
          status: exception.status,
          reason: exception.reason,
          owner: exception.owner?.id ?? null,
          expires: exception.expires_on ?? "",
          analysis: {
            state: exception.analysis_state,
            justification: exception.analysis_justification,
            response: exception.analysis_response,
          },
        }
      : {
          status: "not_applicable",
          reason: "",
          owner: null,
          expires: "",
          analysis: defaultAnalysis("not_applicable"),
        }
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const set = (patch: Partial<ExceptionDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch))
        delete next[
          k === "owner" ? "owner_id" : k === "expires" ? "expires_on" : k
        ]
      return next
    })
  }
  const setStatus = (status: VulnExceptionStatus) =>
    set({
      status,
      // A fresh add follows the status's defaults; an edit keeps what it
      // can.
      analysis: editing
        ? analysisFor(status, draft.analysis)
        : defaultAnalysis(status),
    })
  const setAnalysis = (patch: Partial<Analysis>) =>
    set({ analysis: { ...draft.analysis, ...patch } })

  // Without the people picker the owner is you (or, on an edit, stays).
  const owner = ownerFor({
    canPickOwner,
    editing,
    picked: draft.owner,
    you: you?.id ?? null,
  })
  const effective = useMemo(() => ({ ...draft, owner }), [draft, owner])
  const expiryMsg = expiryError(draft.status, draft.expires, today)
  const localErrors: Record<string, string> = {
    ...(draft.reason.trim() ? {} : { reason: "Say why." }),
    ...(owner === null ? { owner_id: "Pick an owner." } : {}),
    ...(expiryMsg ? { expires_on: expiryMsg } : {}),
  }
  const shown = { ...(touched ? localErrors : {}), ...errors }
  const bodies = useMemo(
    () => (scope ? createBodies(matches, scope, effective) : []),
    [matches, scope, effective]
  )

  const save = useMutation({
    mutationFn: async () => {
      if (exception) {
        const patch = editPatch(exception, effective)
        if (Object.keys(patch).length)
          await api(`${EXCEPTIONS_ENDPOINT}${exception.id}/`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          })
        return { added: 0, skipped: 0 }
      }
      let added = 0
      let skipped = 0
      for (const body of bodies) {
        try {
          await api<VulnException>(EXCEPTIONS_ENDPOINT, {
            method: "POST",
            body: JSON.stringify(body satisfies VulnExceptionWrite),
          })
          added++
        } catch (err) {
          // Several at once: one already excepted is not a reason to stop.
          if (bodies.length > 1 && isDuplicate(fieldErrorsOf(err))) {
            skipped++
            continue
          }
          throw Object.assign(err as object, { added })
        }
      }
      return { added, skipped }
    },
    onSuccess: ({ added, skipped }) => {
      invalidateExceptions(qc)
      if (exception) toast.success("Exception saved")
      else
        toast.success(
          `${added === 1 ? "Added 1 exception" : `Added ${added} exceptions`}${
            skipped ? ` · ${skipped} already excepted` : ""
          }`
        )
      onDone()
    },
    onError: (err) => {
      const added = (err as { added?: number }).added ?? 0
      if (added) invalidateExceptions(qc)
      const fe = fieldErrorsOf(err)
      if (fe) {
        setErrors(fe)
        toast.error(
          added
            ? `Added ${added} of ${bodies.length}; fix the marked fields.`
            : fe.detail || "Couldn't save - check the highlighted fields."
        )
        return
      }
      apiErrorToast(err)
    },
  })

  const submit = () => {
    setTouched(true)
    if (Object.keys(localErrors).length) return
    if (!editing && !bodies.length) return
    save.mutate()
  }

  if (!editing && scopesQ.isLoading)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add exception</DialogTitle>
        </DialogHeader>
        <Loading />
      </>
    )
  if (!editing && scopesQ.isError)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add exception</DialogTitle>
        </DialogHeader>
        <QueryError error={scopesQ.error} />
      </>
    )

  const records = [...new Set(matches.map((m) => m.cve.vuln_id))]
  const scopeError =
    shown.scope ??
    shown.device_id ??
    shown.virtual_machine_id ??
    shown.platform_id ??
    shown.application_id
  const states = STATUS_STATES[draft.status]

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle>
          {editing ? "Edit exception" : "Add exception"}
        </DialogTitle>
      </DialogHeader>

      <Field label="Record">
        <span className="font-mono text-sm">
          {exception
            ? exception.cve.vuln_id
            : records.length <= 3
              ? records.join(", ")
              : `${records.slice(0, 3).join(", ")} and ${records.length - 3} more`}
        </span>
      </Field>
      {shown.vuln_id && (
        <p className="text-sm text-destructive" data-field-error>
          {shown.vuln_id}
        </p>
      )}

      {exception ? (
        <Field label="Scope">
          <span className="text-sm">
            {SCOPE_LABELS[exception.scope]}
            {exception.scope !== "tenant" && (
              <span className="text-muted-foreground">
                {" "}
                · {subjectName(exception)}
              </span>
            )}
          </span>
        </Field>
      ) : (
        <FormSelect
          label="Scope"
          required
          value={scope}
          onChange={(v) => {
            if (!v) return
            setScope(v as ScopeChoice)
            setErrors({})
          }}
          options={options.map((o) => ({
            value: o.value,
            label:
              matches.length > 1 && o.covers < matches.length
                ? `${o.label} · ${o.covers} of ${matches.length}`
                : o.label,
          }))}
          info={
            scopesQ.data?.site_limited
              ? "Your role is limited to sites, so an exception covers one device or VM."
              : undefined
          }
          error={scopeError}
        />
      )}

      <Field label="Status" required error={shown.status} group>
        <SegmentedTabs<VulnExceptionStatus>
          items={STATUS_ITEMS}
          value={draft.status}
          onValueChange={setStatus}
        />
      </Field>

      <FormTextarea
        label="Reason"
        required
        value={draft.reason}
        onChange={(v) => set({ reason: v })}
        rows={3}
        error={shown.reason}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {canPickOwner ? (
          <PersonPicker
            label="Owner"
            required
            value={draft.owner as unknown as string | null}
            onChange={(v) =>
              set({ owner: v === null || v === "" ? null : Number(v) })
            }
            error={shown.owner_id}
          />
        ) : (
          <Field label="Owner" error={shown.owner_id}>
            <span className="flex h-9 items-center text-sm">
              {editing
                ? exception?.owner_name || "-"
                : you
                  ? `You · ${you.display_name}`
                  : "You"}
            </span>
          </Field>
        )}
        <FormDate
          label="Expires"
          required={draft.status === "risk_accepted"}
          value={draft.expires}
          onChange={(v) => set({ expires: v })}
          min={today}
          max={maxExpiry(draft.status, today)}
          error={shown.expires_on}
        />
      </div>

      <FormSection
        title="Advanced"
        collapsible
        hasValues={
          !!shown.analysis_state ||
          !!shown.analysis_justification ||
          !!shown.analysis_response
        }
        summary={`${STATE_LABELS[draft.analysis.state]}${
          draft.analysis.justification
            ? ` · ${JUSTIFICATION_LABELS[draft.analysis.justification]}`
            : ""
        }`}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormSelect
            label="Analysis state"
            value={draft.analysis.state}
            onChange={(v) =>
              v &&
              setAnalysis({
                state: v as VulnAnalysisState,
                justification:
                  v === "not_affected" ? draft.analysis.justification : "",
              })
            }
            options={states.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
            error={shown.analysis_state}
          />
          {draft.analysis.state === "not_affected" && (
            <FormSelect
              label="Justification"
              value={draft.analysis.justification || null}
              onChange={(v) =>
                setAnalysis({
                  justification: (v ?? "") as VulnAnalysisJustification,
                })
              }
              noneLabel="None"
              placeholder="None"
              options={Object.entries(JUSTIFICATION_LABELS).map(
                ([value, label]) => ({ value, label })
              )}
              error={shown.analysis_justification}
            />
          )}
        </div>
        <Field label="Response" group error={shown.analysis_response}>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(Object.keys(RESPONSE_LABELS) as VulnAnalysisResponse[]).map(
              (r) => (
                <FormCheckbox
                  key={r}
                  label={RESPONSE_LABELS[r]}
                  checked={draft.analysis.response.includes(r)}
                  onChange={(on) =>
                    setAnalysis({
                      response: on
                        ? [...draft.analysis.response, r]
                        : draft.analysis.response.filter((x) => x !== r),
                    })
                  }
                />
              )
            )}
          </div>
        </Field>
      </FormSection>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={save.isPending || (!editing && !bodies.length)}
        >
          {save.isPending
            ? "Saving…"
            : editing
              ? "Save exception"
              : bodies.length > 1
                ? `Add ${bodies.length} exceptions`
                : "Add exception"}
        </Button>
      </DialogFooter>
    </form>
  )
}
