import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ModeToggle } from "@/components/mode-toggle"
import { SearchPalette } from "@/components/search-palette"
import { BookmarkButton } from "@/components/bookmark-button"
import { NotificationBell } from "@/components/notification-bell"
import { DocsButton } from "@/components/docs-button"
import { ChatButton } from "@/components/chat/chat-button"
import { UpdateBadge } from "@/components/update-badge"
import { UpgradeNotesBadge } from "@/components/upgrade-notes-badge"
import { PresenceBar } from "@/components/presence-bar"
import { usePresentUsers } from "@/lib/presence-context"
import { useMe } from "@/lib/use-me"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

interface Crumb {
  label: string
  href?: string
}

export function SiteHeader({ crumbs }: { crumbs?: Crumb[] }) {
  const present = usePresentUsers()
  const { brandName } = useMe()
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      {/* On a narrow window the search box gives up its width first (it only
          grows into spare room, from its icon up to 14rem), then the badges
          drop out, then the name truncates. The icon buttons never shrink, so
          none of them is pushed past the edge - that clipped them, and
          focusing one scrolled the whole page sideways. */}
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 shrink-0 data-[orientation=vertical]:h-4"
        />
        <div className="mr-auto flex min-w-0 items-center gap-1 overflow-clip lg:gap-2">
          {crumbs && crumbs.length > 0 ? (
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1
                  return (
                    <span key={i} className="contents">
                      <BreadcrumbItem
                        className={i === 0 ? "hidden md:block" : undefined}
                      >
                        {last || !c.href ? (
                          <BreadcrumbPage>{c.label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink href={c.href}>
                            {c.label}
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {!last && (
                        <BreadcrumbSeparator className="hidden md:block" />
                      )}
                    </span>
                  )
                })}
              </BreadcrumbList>
            </Breadcrumb>
          ) : (
            <h1 className="max-w-full shrink-0 truncate text-base font-medium">
              {brandName}
            </h1>
          )}
          {/* A badge that doesn't fit wraps onto a second line, which this
              one-line box clips: it shows whole or not at all, never cut off
              mid-word. The empty first item lets even the first badge wrap. */}
          <div className="flex h-6 min-w-0 flex-wrap items-center gap-x-1 overflow-clip lg:gap-x-2">
            <span aria-hidden className="-mr-1 h-6 lg:-mr-2" />
            <UpdateBadge />
            <UpgradeNotesBadge />
          </div>
        </div>
        {present.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            <PresenceBar present={present} />
            <Separator
              orientation="vertical"
              className="data-[orientation=vertical]:h-4"
            />
          </div>
        )}
        <SearchPalette />
        <DocsButton />
        <ChatButton />
        <NotificationBell />
        <BookmarkButton />
        <ModeToggle />
      </div>
    </header>
  )
}
