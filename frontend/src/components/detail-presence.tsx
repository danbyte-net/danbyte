import { useParams } from "@tanstack/react-router"

import { useRegisterPresence } from "@/lib/presence-context"

// Drop-in viewing-presence marker for detail pages. Reads the object id from the
// route ($id) and announces it; the actual "who's here" bar renders in the
// global SiteHeader, so this component renders nothing locally. A page only
// needs `<DetailPresence type="manufacturer" />` anywhere in its body.
export function DetailPresence({ type }: { type: string }) {
  const { id } = useParams({ strict: false }) as { id?: string }
  useRegisterPresence(type, id, "viewing")
  return null
}
