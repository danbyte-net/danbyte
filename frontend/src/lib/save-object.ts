import { useNavigate, useSearch } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"

/**
 * The one sanctioned object write.
 *
 * Every form in Danbyte ends the same way — build the complete payload, then
 * `PATCH` it if editing or `POST` it if creating. `useSaveObject()` replaces
 * those two calls with one, and that single seam is what lets **planning reuse
 * the real edit forms**: when the route carries `?plan=<taskId>`, the payload is
 * recorded on that task as a planned change instead of being written.
 *
 * The form learns nothing about planning. It calls `saveObject(...)`, and in
 * plan mode the helper reports the outcome itself and throws `PlanStaged`, which
 * `useFieldErrors().handleApiError` recognises as "not a failure" so no toast
 * fires and `onSaved` never runs.
 */

/** Thrown after a planned change is recorded, to stop the form's success path.
 *  Not an error the user should ever see — see `useFieldErrors`. */
export class PlanStaged extends Error {
  constructor() {
    super("Change planned")
    this.name = "PlanStaged"
  }
}

/** Object types whose forms go through `useSaveObject`, so plan mode can be
 *  offered for them.
 *
 *  This is a **fail-safe**, not a feature flag: a form that still writes
 *  directly must never be reachable in plan mode, or saving it would change the
 *  live object while the banner promised nothing would be written. Add a type
 *  here only once its form is migrated. */
export const PLAN_CAPABLE: ReadonlySet<string> = new Set([
  "api.device",
  "api.interface",
])

export function isPlanCapable(objectType: string): boolean {
  return PLAN_CAPABLE.has(objectType)
}

/** The task a form is currently planning for, or null in normal editing.
 *
 *  Both ids ride in the URL because the entry point always knows them and the
 *  helper needs the board to navigate back to the task afterwards. */
export function usePlanTarget(): { taskId: string; boardId: string } | null {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const taskId = typeof search.plan === "string" ? search.plan : ""
  const boardId = typeof search.planBoard === "string" ? search.planBoard : ""
  return taskId && boardId ? { taskId, boardId } : null
}

/** Search params that put a form into plan mode. Routes that support planning
 *  allow-list these in `validateSearch`. */
export interface PlanSearch {
  plan?: string
  planBoard?: string
}

/** Pull plan params off a route's raw search, for `validateSearch`. */
export function planSearch(s: Record<string, unknown>): PlanSearch {
  return {
    ...(typeof s.plan === "string" ? { plan: s.plan } : {}),
    ...(typeof s.planBoard === "string" ? { planBoard: s.planBoard } : {}),
  }
}

export interface SaveObjectArgs {
  /** RBAC/registry label, e.g. "api.device". */
  objectType: string
  /** List endpoint with a trailing slash, e.g. "/api/devices/". */
  endpoint: string
  /** Present = update, absent = create. */
  id?: string
  payload: unknown
  /** Create-only: forms that expand a name range stage one create per name, so
   *  planning `eth[0-3]` records four new interfaces, not one. */
  names?: string[]
  /** Field the names fan out over. Defaults to "name". */
  nameField?: string
}

export function useSaveObject() {
  const plan = usePlanTarget()
  const nav = useNavigate()
  const qc = useQueryClient()

  return async function saveObject<T>({
    objectType,
    endpoint,
    id,
    payload,
    names,
    nameField = "name",
  }: SaveObjectArgs): Promise<T> {
    if (plan) {
      const body = payload as Record<string, unknown>
      const bodies =
        !id && names && names.length > 1
          ? names.map((n) => ({ ...body, [nameField]: n }))
          : [body]
      for (const one of bodies) {
        await api("/api/planning/planned-changes/", {
          method: "POST",
          body: JSON.stringify({
            task: plan.taskId,
            kind: id ? "update" : "create",
            object_type: objectType,
            ...(id ? { object_id: id } : {}),
            payload: one,
          }),
        })
      }
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      qc.invalidateQueries({ queryKey: ["planned-changes-map"] })
      toast.success(
        bodies.length > 1
          ? `${bodies.length} changes planned`
          : "Change planned — nothing written yet"
      )
      // Back to the task, with its sheet open, so the staged change is right
      // there rather than something the user has to go find.
      nav({
        to: "/planning/$boardId",
        params: { boardId: plan.boardId },
        search: { task: plan.taskId },
      })
      throw new PlanStaged()
    }

    if (id) {
      return api<T>(`${endpoint}${id}/`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      })
    }
    return api<T>(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }
}
