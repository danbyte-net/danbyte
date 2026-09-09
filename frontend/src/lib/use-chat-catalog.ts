import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"

interface Coloured {
  id: string
  name: string
  color?: string
  text_color?: string
}

export interface CatalogEntry {
  color: string
  textColor: string
}

/** Colours for the catalog objects an answer is likely to name.
 *
 * A status or a role in a table should read as the same pill it is on every
 * other page, and the house rule is that the colour comes from the object,
 * never from its name - so it is looked up here rather than guessed. Three
 * small lists, cached for the session. */
export function useChatCatalog(): Map<string, CatalogEntry> {
  const statuses = useQuery({
    queryKey: ["chat-catalog", "statuses"],
    queryFn: () => api<Paginated<Coloured>>("/api/statuses/"),
    staleTime: 30 * 60_000,
    retry: false,
  })
  const roles = useQuery({
    queryKey: ["chat-catalog", "device-roles"],
    queryFn: () => api<Paginated<Coloured>>("/api/device-roles/"),
    staleTime: 30 * 60_000,
    retry: false,
  })
  const tags = useQuery({
    queryKey: ["chat-catalog", "tags"],
    queryFn: () => api<Paginated<Coloured>>("/api/tags/"),
    staleTime: 30 * 60_000,
    retry: false,
  })

  const map = new Map<string, CatalogEntry>()
  for (const list of [statuses.data, roles.data, tags.data]) {
    for (const row of list?.results ?? []) {
      if (!row.color) continue
      const key = row.name.trim().toLowerCase()
      if (!map.has(key)) {
        map.set(key, { color: row.color, textColor: row.text_color ?? "" })
      }
    }
  }
  return map
}
