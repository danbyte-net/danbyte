import { createLink } from "@tanstack/react-router"
import { ArrowUpRight } from "lucide-react"

import { BarButton } from "@/components/map-toolbar"

/**
 * "Open device", "Open cable", "Open rack": the one way a Maps panel leaves
 * the map for an object's own page. A router link (so the SPA never reloads)
 * drawn as a bar button with a leading ArrowUpRight, typed like `<Link>`:
 *
 *   <OpenLink to="/devices/$id" params={{ id }}>Open device</OpenLink>
 *
 * Only for leaving the page. An action that stays on the map - drilling into
 * a group, focusing a device - is a plain BarButton with no arrow.
 */
function OpenAnchor({
  children,
  className,
  ...props
}: React.ComponentProps<"a">) {
  return (
    <BarButton asChild className={className}>
      <a {...props}>
        <ArrowUpRight />
        {children}
      </a>
    </BarButton>
  )
}

export const OpenLink = createLink(OpenAnchor)
