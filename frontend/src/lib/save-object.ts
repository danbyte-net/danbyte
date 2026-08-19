import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"

/**
 * The one sanctioned object write.
 *
 * Every form in Danbyte ends the same way - build the complete payload, then
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
 *  Not an error the user should ever see - see `useFieldErrors`. */
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
 *  here only once its form is migrated - `save-object.test.ts` checks that every
 *  entry has one.
 *
 *  Deliberate absences: `api.cable`, whose payload carries `a`/`b` termination
 *  arrays rather than plain writable fields; anything whose "form" is a
 *  multi-step wizard; and users, groups and tags, whose integer primary keys a
 *  planned change cannot reference (`object_id` is a UUID column). */
export const PLAN_CAPABLE: ReadonlySet<string> = new Set([
  "api.aggregate",
  "api.asn",
  "api.circuit",
  "api.circuittermination",
  "api.circuittype",
  "api.cluster",
  "api.clustergroup",
  "api.clustertype",
  "api.configcontext",
  "api.consoleport",
  "api.consoleserverport",
  "api.contact",
  "api.contactgroup",
  "api.contactrole",
  "api.device",
  "api.devicerole",
  "api.devicetype",
  "api.devicetypeservice",
  "api.exporttemplate",
  "api.fhrpgroup",
  "api.floorplan",
  "api.floortiletype",
  "api.frontport",
  "api.interface",
  "api.inventoryitem",
  "api.ipaddress",
  "api.iprange",
  "api.iprole",
  "api.ipsecprofile",
  "api.location",
  "api.macaddress",
  "api.manufacturer",
  "api.module",
  "api.moduleinterfacetemplate",
  "api.moduletype",
  "api.platform",
  "api.platformgroup",
  "api.powerfeed",
  "api.poweroutlet",
  "api.powerpanel",
  "api.powerport",
  "api.prefix",
  "api.provider",
  "api.providernetwork",
  "api.rack",
  "api.rackrole",
  "api.racktype",
  "api.racktypeaccessory",
  "api.rearport",
  "api.region",
  "api.rir",
  "api.routetarget",
  "api.service",
  "api.servicetemplate",
  "api.site",
  "api.status",
  "api.tunnel",
  "api.tunnelgroup",
  "api.tunneltermination",
  "api.virtualchassis",
  "api.virtualmachine",
  "api.vlan",
  "api.vlangroup",
  "api.vminterface",
  "api.vrf",
  "api.wirelesslan",
  "api.wirelesslangroup",
  "api.zone",
  "auth_api.objectpermission",
  "core.tenant",
  "core.tenantgroup",
  "customization.customfield",
  "customization.customfieldgroup",
  "integrations.automationtarget",
  "integrations.webhook",
])

export function isPlanCapable(objectType: string): boolean {
  return PLAN_CAPABLE.has(objectType)
}

/** The task a form is currently planning for, or null in normal editing.
 *
 *  Both ids ride in the URL because the entry point always knows them and the
 *  helper needs the board to navigate back to the task afterwards. */
export function usePlanTarget(): { taskId: string; boardId: string } | null {
  // Read the LOCATION's search, not the route's validated search. A route that
  // validates its own params returns only those, which would silently drop
  // `plan` - and a form that thinks it isn't planning writes to the live object
  // while the banner promises it won't. The location is unfiltered.
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  })
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
  /** Create-only, and takes precedence over `names`: the complete bodies a range
   *  would have created, for forms whose range advances more than the name -
   *  front ports step the rear strand too. Ignored outside plan mode, where the
   *  form still posts them one at a time so a clash names the offender. */
  bodies?: unknown[]
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
    bodies,
  }: SaveObjectArgs): Promise<T> {
    if (plan) {
      const body = payload as Record<string, unknown>
      const staged =
        !id && bodies && bodies.length
          ? bodies
          : !id && names && names.length > 1
            ? names.map((n) => ({ ...body, [nameField]: n }))
            : [body]
      for (const one of staged) {
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
      // The per-object query behind the field marks (PendingFieldsProvider) -
      // without this, a detail page kept showing its pre-plan marks until the
      // cache aged out.
      qc.invalidateQueries({ queryKey: ["planned-changes-for"] })
      toast.success(
        staged.length > 1
          ? `${staged.length} changes planned`
          : "Change planned - nothing written yet"
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
