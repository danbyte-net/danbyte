import { useCallback, useState } from "react"

import { ApiError } from "@/lib/api"

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
        // `detail` / `non_field_errors` aren't tied to a form field — surface
        // them as the toast message instead of silently highlighting nothing.
        if (k === "detail" || k === "non_field_errors") general = msg
        else errs[k] = msg
      }
      setFieldErrors(errs)
      if (Object.keys(errs).length > 0) {
        return general ?? "Couldn't save — check the highlighted fields."
      }
      return general ?? "Couldn't save."
    }
    return (err as Error)?.message ?? "Unknown error"
  }, [])

  return { fieldErrors, handleApiError, reset }
}
