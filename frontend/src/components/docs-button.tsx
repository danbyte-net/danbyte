import { useRouterState } from "@tanstack/react-router"
import { BookOpen } from "lucide-react"

import { docsUrlFor, hasDocsPage } from "@/lib/docs-links"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The topbar's book: opens the documentation page for the screen the user is
 * on (route → docs mapping in lib/docs-links), falling back to the docs home.
 * A plain anchor in a new tab - the docs are a separate static site, not an
 * SPA route.
 */
export function DocsButton() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const href = docsUrlFor(pathname)
  const specific = hasDocsPage(pathname)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" asChild>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the docs"
          >
            <BookOpen className="h-4 w-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" variant="panel">
        {specific ? "Docs for this page" : "Documentation"}
      </TooltipContent>
    </Tooltip>
  )
}
