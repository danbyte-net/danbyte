import { createContext, useContext } from "react"

/**
 * The list toolbar row (#507): `ListPageShell` draws one row above its table
 * holding the filter button, saved views and search, and the page's main
 * `DataTable` moves its own controls - selection count, Download, Columns -
 * into that row instead of drawing a second one. The first table inside the
 * shell's body to `claim` the row gets it; any other draws its own bar.
 */
export interface ListToolbar {
  /** Where the claiming table portals its controls. */
  slot: HTMLElement | null
  /** The table holding the row, or null. */
  owner: string | null
  /** Ask for the row. Returns a release for unmount. */
  claim: (id: string, el: HTMLElement) => () => void
}

export const ListToolbarContext = createContext<ListToolbar | null>(null)

export function useListToolbar(): ListToolbar | null {
  return useContext(ListToolbarContext)
}
