import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"

/** Tenant members, for pickers outside user administration (notification
 *  subscriptions, script sharing, a site editor's viewer invite).
 *  `/api/users/` is user administration and needs a grant on users; this
 *  lists the active members of the active tenant for anyone who works with
 *  one of those features. `email` is null unless the caller may read users. */
export interface Person {
  id: number
  username: string
  display_name: string
  email: string | null
  has_email: boolean
}

/** A group with members in the active tenant. */
export interface PersonGroup {
  id: number
  name: string
}

export const PEOPLE_ENDPOINT = "/api/people/"
export const PEOPLE_GROUPS_ENDPOINT = "/api/people/groups/"

export function usePeople(enabled = true) {
  return useQuery({
    queryKey: ["people"],
    queryFn: () => api<Paginated<Person>>(PEOPLE_ENDPOINT),
    enabled,
  })
}

export function usePeopleGroups(enabled = true) {
  return useQuery({
    queryKey: ["people-groups"],
    queryFn: () => api<Paginated<PersonGroup>>(PEOPLE_GROUPS_ENDPOINT),
    enabled,
  })
}
