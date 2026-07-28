import { Component } from "react"
import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  /** When this value changes, the boundary clears its error and re-renders the
   * children. Pass the current pathname so navigating anywhere recovers a
   * crashed view automatically — no full-page refresh. */
  resetKey?: unknown
}

interface State {
  error: Error | null
}

// A crash in React's render OR commit phase (including unmounting a subtree)
// otherwise takes down the whole SPA until a manual refresh. The most common
// cause in practice isn't our code: browser extensions — password managers
// (1Password, LastPass), Grammarly, Google Translate — inject nodes INTO
// React-owned DOM, so when React later removes that DOM it hits a node whose
// parent the extension already moved and throws `removeChild`/`insertBefore` on
// null during commit. That corrupts React's tree and freezes the page.
//
// This boundary degrades any such crash to a recoverable panel instead of a
// dead page, and auto-clears when `resetKey` (the pathname) changes, so the user
// can just click another nav item to recover.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <TriangleAlert className="mx-auto size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">
            This view hit a rendering error
          </h2>
          <p className="text-sm text-muted-foreground">
            Often a browser extension (a password manager, Grammarly, or a page
            translator) editing the page is the cause. Navigating away and back
            usually recovers it; disabling the extension for this site prevents
            it.
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <Button onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
