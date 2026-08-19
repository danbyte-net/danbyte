import { Component } from "react"
import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  /** When this value changes, the boundary clears its error and re-renders the
   * children. Pass the current pathname so navigating anywhere recovers a
   * crashed view automatically - no full-page refresh. */
  resetKey?: unknown
}

interface State {
  error: Error | null
  info: string | null
}

// A crash in React's render OR commit phase (including unmounting a subtree)
// otherwise takes down the whole SPA until a manual refresh. The most common
// cause in practice isn't our code: browser extensions - password managers
// (1Password, LastPass), Grammarly, Google Translate - inject nodes INTO
// React-owned DOM, so when React later removes that DOM it hits a node whose
// parent the extension already moved and throws `removeChild`/`insertBefore` on
// null during commit. That corrupts React's tree and freezes the page.
//
// This boundary degrades any such crash to a recoverable panel instead of a
// dead page, and auto-clears when `resetKey` (the pathname) changes, so the user
// can just click another nav item to recover.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  // React swallows the stack into the boundary, so a crash used to leave the
  // user (and a bug report) with nothing but "a rendering error". Log it and
  // keep the component stack for the details panel below.
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("View crashed:", error, info?.componentStack)
    this.setState({ info: info?.componentStack ?? null })
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null })
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
            <Button onClick={() => this.setState({ error: null, info: null })}>
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
          {/* The actual cause - without it a bug report can only say "it
              crashed", which is what happened with the tenants page. */}
          <details className="pt-2 text-left">
            <summary className="cursor-pointer text-center text-xs text-muted-foreground">
              Error details
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] whitespace-pre-wrap">
              {this.state.error.message || String(this.state.error)}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
              {this.state.info ? `\n\nComponent stack:${this.state.info}` : ""}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
