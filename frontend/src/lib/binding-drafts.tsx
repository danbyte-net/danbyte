import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

/** Binding controls (monitoring engine, SNMP profile, discovered-IP VRF) hold
 * their own server state behind a per-object endpoint. On a detail page they
 * save on pick. Inside an edit form they only stage the pick, and the form
 * writes it after its own save - so opening a form never writes, and a pick is
 * kept or dropped with the rest of the form's changes (#324). */

type Write = () => Promise<unknown>

export interface BindingDrafts {
  stage: (key: string, write: Write | null) => void
  /** Write every staged pick, in order. A failure stops here and throws; the
   * picks not yet written stay staged so Save can try again. */
  commit: () => Promise<void>
}

const BindingDraftsContext = createContext<BindingDrafts | null>(null)

export const BindingDraftsProvider = BindingDraftsContext.Provider

/** The drafts a form owns: wrap the form in `<BindingDraftsProvider>` and call
 * `commit()` once the object itself saved. */
export function useBindingDraftsRoot(): BindingDrafts {
  const pending = useRef(new Map<string, Write>())
  return useMemo(
    () => ({
      stage: (key, write) => {
        if (write) pending.current.set(key, write)
        else pending.current.delete(key)
      },
      commit: async () => {
        for (const [key, write] of [...pending.current]) {
          await write()
          pending.current.delete(key)
        }
      },
    }),
    []
  )
}

/** One control's pick: staged inside a form, written at once elsewhere.
 * `value` is what the control shows - the staged pick, else the stored one. */
export function useBindingPick(
  key: string,
  current: string | null,
  write: (next: string | null) => Promise<unknown>,
  immediate: (next: string | null) => void
) {
  const drafts = useContext(BindingDraftsContext)
  // A draft remembers the stored value it was picked against; once that moves
  // (saved, or changed elsewhere) the draft is spent.
  const [draft, setDraft] = useState<{
    value: string | null
    base: string | null
  } | null>(null)
  const live = draft && draft.base === current ? draft : null

  useEffect(() => {
    drafts?.stage(key, null)
  }, [drafts, key, current])
  // An unmounted control has nothing left to save.
  useEffect(() => () => drafts?.stage(key, null), [drafts, key])

  const pick = (next: string | null) => {
    if (!drafts) {
      if (next !== current) immediate(next)
      return
    }
    if (next === current) {
      setDraft(null)
      drafts.stage(key, null)
    } else {
      setDraft({ value: next, base: current })
      drafts.stage(key, () => write(next))
    }
  }

  return {
    value: live ? live.value : current,
    pick,
    staged: drafts !== null,
  }
}
