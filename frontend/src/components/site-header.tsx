import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ModeToggle } from "@/components/mode-toggle"
import { GlobalSearch } from "@/components/global-search"
import { BookmarkButton } from "@/components/bookmark-button"
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
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
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
                        <BreadcrumbLink href={c.href}>{c.label}</BreadcrumbLink>
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
          <h1 className="text-base font-medium">{brandName}</h1>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PresenceBar present={present} />
          {present.length > 0 && (
            <Separator
              orientation="vertical"
              className="data-[orientation=vertical]:h-4"
            />
          )}
          <GlobalSearch />
          <BookmarkButton />
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
