import { createContext, useContext, useEffect, useState } from "react"

/** Whether the chat is docked open, shared between the top-bar button and
 * the layout that has to make room for it. */
const ChatDockContext = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
}>({ open: false, setOpen: () => undefined })

const STORAGE_KEY = "danbyte-chat-open"

export function ChatDockProvider({ children }: { children: React.ReactNode }) {
  // Remembered per browser: someone who works with it open should not have
  // to reopen it on every page load.
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1"
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0")
    } catch {
      /* a private window: the panel just does not persist */
    }
  }, [open])

  return (
    <ChatDockContext.Provider value={{ open, setOpen }}>
      {children}
    </ChatDockContext.Provider>
  )
}

export function useChatDock() {
  return useContext(ChatDockContext)
}
