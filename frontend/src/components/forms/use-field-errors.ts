import { useCallback, useState } from "react"

import { ApiError } from "@/lib/api"
import { PlanStaged } from "@/lib/save-object"

// Manages the per-field error map that DRF 400 responses populate.
// Pass the result of `catch(handleApiError)` into the mutation's onError.
//
//   const { fieldErrors, handleApiError, reset } = useFieldErrors()
//   const m = useMutation({ ... onError: handleApiError, onSuccess: reset })
//   <FormText label="Name" error={fieldErrors.name} ... />
export function useFieldErrors() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const reset = useCallback(() => setFieldErrors({}), [])

  const handleApiError = useCallback((err: unknown): string | null => {
    // A staged planned change is not an error: useSaveObject already reported
    // it and navigated away. Returning null means the form shows no toast and
    // its onSaved never runs, which is exactly right - nothing was saved.
    if (err instanceof PlanStaged) return null
    if (
      err instanceof ApiError &&
      err.status === 400 &&
      err.body &&
      typeof err.body === "object"
    ) {
      const errs: Record<string, string> = {}
      let general: string | null = null
      for (const [k, v] of Object.entries(
        err.body as Record<string, unknown>
      )) {
        const msg = Array.isArray(v) ? String(v[0]) : String(v)
        // `detail` / `non_field_errors` aren't tied to a form field - surface
        // them as the toast message instead of silently highlighting nothing.
        if (k === "detail" || k === "non_field_errors") general = msg
        else errs[k] = msg
      }
      setFieldErrors(errs)
      // A 400 on a tall two-column form can highlight a field the operator
      // isn't looking at - the save just seems to do nothing. Bring the
      // first errored field into view once it has rendered.
      if (Object.keys(errs).length > 0 && typeof document !== "undefined") {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>("[data-field-error]")
          if (!el) return
          el.scrollIntoView({ behavior: "smooth", block: "center" })
          el.querySelector<HTMLElement>(
            "input, textarea, button, select"
          )?.focus({
            preventScroll: true,
          })
        })
      }
      if (Object.keys(errs).length > 0) {
        return general ?? "Couldn't save - check the highlighted fields."
      }
      return general ?? "Couldn't save."
    }
    return (err as Error)?.message ?? "Unknown error"
  }, [])

  return { fieldErrors, handleApiError, reset }
}
