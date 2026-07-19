import { toast } from "sonner"

import { apiErrorMessage } from "@/lib/api"

// The one error toast for failed api() calls. Lives beside api.ts (not in
// it) because api.ts stays runtime-import-free and sonner is a runtime dep.
export function apiErrorToast(err: unknown, fallback?: string): string {
  const msg = apiErrorMessage(err, fallback)
  toast.error(msg)
  return msg
}
