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
      for (const [k, v] of Object.entries(
        err.body as Record<string, unknown>
      )) {
        errs[k] = Array.isArray(v) ? String(v[0]) : String(v)
      }
      setFieldErrors(errs)
      return "Couldn't save — check the highlighted fields."
    }
    return (err as Error)?.message ?? "Unknown error"
  }, [])

  return { fieldErrors, handleApiError, reset }
}
