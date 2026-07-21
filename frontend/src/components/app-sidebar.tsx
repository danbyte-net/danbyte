import * as React from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronsUpDown,
  Network,
  Server,
  Building2,
  ArrowDownUp,
  Cpu,
  Tag,
  Factory,
  LayoutDashboard,
  Tags as TagsIcon,
  ShieldCheck,
  Activity,
  Radio,
  BellRing,
  History,
  SquareStack,
  Workflow,
  ListChecks,
  Cable as CableIcon,
  Boxes,
  Container,
  Rows3,
  Globe,
  Hash,
  Shield,
  Contact,
  UsersRound,
  UserCog,
  MonitorSmartphone,
  Layers,
  FolderTree,
  Share2,
  Clock,
  Cloud,
  UserMinus,
  Fingerprint,
  Waypoints,
  GitBranch,
  GitPullRequestArrow,
  Bookmark,
  Users,
  Settings as SettingsIcon,
  ExternalLink,
  SlidersHorizontal,
  BookOpen,
  LogOut,
  Webhook,
  Upload,
  Rocket,
  GitCompareArrows,
  Zap,
  LayoutTemplate,
  LayoutGrid,
  Map as MapIcon,
  Folder,
  Plus,
  Trash2,
  Puzzle,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  api,
  auth,
  type Bookmark as BookmarkRow,
  type BookmarkFolder,
  type Paginated,
  type TenantPicker,
} from "@/lib/api"
import { docsUrl } from "@/lib/docs"
import { useMe } from "@/lib/use-me"
import { useBookmarks } from "@/lib/use-bookmarks"
import { usePluginUi } from "@/lib/plugins"
import { DynamicIcon } from "@/components/dynamic-icon"
import { apiErrorToast } from "@/lib/api-toast"

// Information architecture mirrors the original Danbyte CLAUDE.md — the
// order is load-bearing (matches the user's mental model). Stub `/foo`
// routes 404 until their .tsx file lands in src/routes/.

// How a nav item earns its place in the sidebar. The visibility gate mirrors
// the API so the nav never advertises a page that would only 403:
//   • `objectType`  — single RBAC object-type slug (Django `model_name`); shown
//                     when the user can `view` it in the active tenant.
//   • `anyOf`       — aggregate pages that read several types (MACs, Topology,
//                     Monitoring, Alerts); shown when ANY is viewable.
//   • `perm`        — a flat permission slug (`useMe().can`), for pages with no
//                     single owning object type (Audit log, External sync).
//   • none of these — genuinely universal (Dashboard landing, own Preferences);
//                     always shown to a signed-in user.
type NavItem = {
  title: string
  url: string
  icon: React.ComponentType<{ className?: string }>
  objectType?: string
  anyOf?: string[]
  perm?: string
}
// A cluster is a labelled run of items inside a section (the NetBox-style
// sub-heading). `label` is optional — a single unlabelled cluster renders as a
// plain list, so short sections stay flat.
type NavCluster = {
  label?: string
  items: NavItem[]
}
type NavSection = {
  label: string
  icon: React.ComponentType<{ className?: string }>
  clusters: NavCluster[]
}

const sections: NavSection[] = [
  {
    label: "Organization",
    icon: Users,
    clusters: [
      {
        label: "Tenancy",
        items: [
          {
            title: "Tenants",
            url: "/tenants",
            icon: Users,
            objectType: "tenant",
          },
        ],
      },
      {
        label: "Sites",
        items: [
          {
            title: "Regions",
            url: "/regions",
            icon: Globe,
            objectType: "region",
          },
          {
            title: "Sites",
            url: "/sites",
            icon: Building2,
            objectType: "site",
          },
          {
            title: "Locations",
            url: "/locations",
            icon: FolderTree,
            objectType: "location",
          },
        ],
      },
      {
        label: "Contacts",
        items: [
          {
            title: "Contacts",
            url: "/contacts",
            icon: Contact,
            objectType: "contact",
          },
          {
            title: "Contact groups",
            url: "/contact-groups",
            icon: UsersRound,
            objectType: "contactgroup",
          },
          {
            title: "Contact roles",
            url: "/contact-roles",
            icon: UserCog,
            objectType: "contactrole",
          },
        ],
      },
    ],
  },
  {
    label: "IPAM",
    icon: Network,
    clusters: [
      {
        label: "IP management",
        items: [
          {
            title: "Aggregates",
            url: "/aggregates",
            icon: Layers,
            objectType: "aggregate",
          },
          {
            title: "Prefixes",
            url: "/prefixes",
            icon: Network,
            objectType: "prefix",
          },
          {
            title: "IP ranges",
            url: "/ip-ranges",
            icon: Rows3,
            objectType: "iprange",
          },
          {
            title: "IP roles",
            url: "/ip-roles",
            icon: UserMinus,
            objectType: "iprole",
          },
          {
            title: "MAC addresses",
            url: "/macs",
            icon: Fingerprint,
            anyOf: ["interface", "ipaddress"],
          },
        ],
      },
      {
        label: "Numbering",
        items: [
          { title: "RIRs", url: "/rirs", icon: Globe, objectType: "rir" },
          { title: "ASNs", url: "/asns", icon: Hash, objectType: "asn" },
        ],
      },
      {
        label: "VLANs",
        items: [
          { title: "VLANs", url: "/vlans", icon: Bookmark, objectType: "vlan" },
          {
            title: "VLAN groups",
            url: "/vlan-groups",
            icon: Layers,
            objectType: "vlangroup",
          },
        ],
      },
      {
        label: "VRFs",
        items: [
          { title: "VRFs", url: "/vrfs", icon: GitBranch, objectType: "vrf" },
          {
            title: "Route targets",
            url: "/route-targets",
            icon: GitPullRequestArrow,
            objectType: "routetarget",
          },
        ],
      },
      {
        label: "Zones",
        items: [
          {
            title: "Zones",
            url: "/zones",
            icon: ShieldCheck,
            objectType: "zone",
          },
        ],
      },
      {
        label: "FHRP",
        items: [
          {
            title: "FHRP groups",
            url: "/fhrp-groups",
            icon: Shield,
            objectType: "fhrpgroup",
          },
        ],
      },
      {
        label: "Services",
        items: [
          {
            title: "Services",
            url: "/services",
            icon: Waypoints,
            objectType: "service",
          },
          {
            title: "Service templates",
            url: "/service-templates",
            icon: LayoutTemplate,
            objectType: "servicetemplate",
          },
        ],
      },
    ],
  },
  {
    label: "DCIM",
    icon: Server,
    clusters: [
      {
        label: "Devices",
        items: [
          {
            title: "Devices",
            url: "/devices",
            icon: Server,
            objectType: "device",
          },
          {
            title: "Virtual chassis",
            url: "/virtual-chassis",
            icon: Layers,
            objectType: "virtualchassis",
          },
          {
            title: "Device types",
            url: "/device-types",
            icon: ArrowDownUp,
            objectType: "devicetype",
          },
          {
            title: "Module types",
            url: "/module-types",
            icon: ArrowDownUp,
            objectType: "moduletype",
          },
          {
            title: "Device roles",
            url: "/device-roles",
            icon: Tag,
            objectType: "devicerole",
          },
          {
            title: "Platforms",
            url: "/platforms",
            icon: Cpu,
            objectType: "platform",
          },
          {
            title: "Platform groups",
            url: "/platform-groups",
            icon: Layers,
            objectType: "platformgroup",
          },
          {
            title: "Manufacturers",
            url: "/manufacturers",
            icon: Factory,
            objectType: "manufacturer",
          },
        ],
      },
      {
        label: "Racks",
        items: [
          {
            title: "Racks",
            url: "/racks",
            icon: Container,
            objectType: "rack",
          },
          {
            title: "Rack roles",
            url: "/rack-roles",
            icon: Rows3,
            objectType: "rackrole",
          },
        ],
      },
      {
        label: "Connections",
        items: [
          {
            title: "Interfaces",
            url: "/interfaces",
            icon: Workflow,
            objectType: "interface",
          },
          {
            title: "Cables",
            url: "/cables",
            icon: CableIcon,
            objectType: "cable",
          },
          {
            title: "Topology",
            url: "/topology",
            icon: Share2,
            anyOf: ["device", "cable", "interface"],
          },
        ],
      },
    ],
  },
  {
    label: "Maps",
    icon: MapIcon,
    clusters: [
      {
        items: [
          {
            title: "Site map",
            url: "/site-map",
            icon: MapIcon,
            objectType: "site",
          },
          {
            title: "Floor plans",
            url: "/floorplans",
            icon: LayoutGrid,
            objectType: "floorplan",
          },
        ],
      },
    ],
  },
  {
    label: "Circuits",
    icon: GitPullRequestArrow,
    clusters: [
      {
        items: [
          {
            title: "Circuits",
            url: "/circuits",
            icon: GitPullRequestArrow,
            objectType: "circuit",
          },
          {
            title: "Providers",
            url: "/providers",
            icon: Factory,
            objectType: "provider",
          },
          {
            title: "Provider networks",
            url: "/provider-networks",
            icon: Cloud,
            objectType: "providernetwork",
          },
          {
            title: "Circuit types",
            url: "/circuit-types",
            icon: Tag,
            objectType: "circuittype",
          },
        ],
      },
    ],
  },
  {
    label: "Power",
    icon: Zap,
    clusters: [
      {
        items: [
          {
            title: "Power feeds",
            url: "/power-feeds",
            icon: Activity,
            objectType: "powerfeed",
          },
          {
            title: "Power panels",
            url: "/power-panels",
            icon: SquareStack,
            objectType: "powerpanel",
          },
        ],
      },
    ],
  },
  {
    label: "Wireless",
    icon: Waypoints,
    clusters: [
      {
        items: [
          {
            title: "Wireless LANs",
            url: "/wireless-lans",
            icon: Waypoints,
            objectType: "wirelesslan",
          },
          {
            title: "Wireless LAN groups",
            url: "/wireless-lan-groups",
            icon: FolderTree,
            objectType: "wirelesslangroup",
          },
        ],
      },
    ],
  },
  {
    label: "VPN",
    icon: Shield,
    clusters: [
      {
        items: [
          {
            title: "Tunnels",
            url: "/tunnels",
            icon: Workflow,
            objectType: "tunnel",
          },
          {
            title: "Tunnel groups",
            url: "/tunnel-groups",
            icon: FolderTree,
            objectType: "tunnelgroup",
          },
          {
            title: "IPSec profiles",
            url: "/ipsec-profiles",
            icon: Shield,
            objectType: "ipsecprofile",
          },
          {
            title: "L2VPNs",
            url: "/l2vpns",
            icon: Waypoints,
            objectType: "l2vpn",
          },
        ],
      },
    ],
  },
  {
    label: "Virtualization",
    icon: Boxes,
    clusters: [
      {
        items: [
          {
            title: "Virtual machines",
            url: "/virtual-machines",
            icon: MonitorSmartphone,
            objectType: "virtualmachine",
          },
          {
            title: "Clusters",
            url: "/clusters",
            icon: Boxes,
            objectType: "cluster",
          },
          {
            title: "Cluster types",
            url: "/cluster-types",
            icon: Layers,
            objectType: "clustertype",
          },
          {
            title: "Cluster groups",
            url: "/cluster-groups",
            icon: FolderTree,
            objectType: "clustergroup",
          },
        ],
      },
    ],
  },
  {
    label: "Governance",
    icon: ShieldCheck,
    clusters: [
      {
        items: [
          {
            title: "Monitoring",
            url: "/monitoring",
            icon: Activity,
            anyOf: ["checktemplate", "checkassignment", "silence"],
          },
          {
            title: "Monitoring engines",
            url: "/monitoring-engines",
            icon: Radio,
            perm: "users.manage",
          },
          {
            title: "Alerts",
            url: "/alerts",
            icon: BellRing,
            anyOf: ["alertrule", "notificationchannel", "silence"],
          },
          {
            title: "Compliance",
            url: "/compliance",
            icon: ShieldCheck,
            objectType: "compliancerule",
          },
          {
            title: "Audit log",
            url: "/audit-log",
            icon: History,
            perm: "users.manage",
          },
          {
            title: "Jobs",
            url: "/jobs",
            icon: ListChecks,
            perm: "jobs.manage",
          },
        ],
      },
    ],
  },
  {
    label: "Customize",
    icon: SquareStack,
    clusters: [
      {
        items: [
          { title: "Tags", url: "/tags", icon: TagsIcon, objectType: "tag" },
          {
            title: "Statuses",
            url: "/statuses",
            icon: Clock,
            objectType: "status",
          },
          {
            title: "Custom fields",
            url: "/custom-fields",
            icon: SquareStack,
            objectType: "customfield",
          },
          {
            title: "Custom field groups",
            url: "/custom-field-groups",
            icon: Layers,
            objectType: "customfieldgroup",
          },
          {
            title: "Floor tiles",
            url: "/floor-tile-types",
            icon: LayoutGrid,
            objectType: "floortiletype",
          },
          { title: "Fibre colours", url: "/fiber", icon: CableIcon },
          {
            title: "Config contexts",
            url: "/config-contexts",
            icon: Layers,
            objectType: "configcontext",
          },
          {
            title: "Export templates",
            url: "/export-templates",
            icon: GitPullRequestArrow,
            objectType: "exporttemplate",
          },
        ],
      },
    ],
  },
  {
    label: "Integrations",
    icon: Webhook,
    clusters: [
      {
        items: [
          {
            title: "Webhooks",
            url: "/webhooks",
            icon: Webhook,
            objectType: "webhook",
          },
          {
            title: "Automation targets",
            url: "/automation-targets",
            icon: Workflow,
            objectType: "automationtarget",
          },
          {
            title: "Deploy runs",
            url: "/deploy-runs",
            icon: Rocket,
            objectType: "automationtarget",
          },
          {
            title: "Config drift",
            url: "/config-drift",
            icon: GitCompareArrows,
            objectType: "device",
          },
          {
            title: "Import",
            url: "/import",
            icon: Upload,
            perm: "import.run",
          },
        ],
      },
    ],
  },
]

// A sidebar category group whose label toggles its items open/closed. Collapse
// state is session-local; reloads start collapsed except for the active route.
function NavGroup({
  label,
  icon: Icon,
  hasActive,
  children,
}: {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  hasActive: boolean
  children: React.ReactNode
}) {
  const { state } = useSidebar()
  const iconMode = state === "collapsed"
  const [open, setOpen] = React.useState(() => hasActive)
  // Reveal on the false→true transition only, so collapsing the group you're
  // currently in sticks until you navigate away and back into it.
  const prevActive = React.useRef(hasActive)
  React.useEffect(() => {
    if (hasActive && !prevActive.current) setOpen(true)
    prevActive.current = hasActive
  }, [hasActive])
  const shown = iconMode || open

  return (
    <SidebarGroup className="py-0.5">
      <SidebarGroupLabel asChild>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 hover:text-foreground"
        >
          {Icon && <Icon className="size-4 shrink-0 opacity-60" />}
          <span>{label}</span>
          <ChevronDown
            className={
              "ml-auto size-3.5 shrink-0 opacity-60 transition-transform " +
              (shown ? "" : "-rotate-90")
            }
          />
        </button>
      </SidebarGroupLabel>
      {shown && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { canManage, canDo, can } = useMe()
  const pluginUi = usePluginUi()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // The group that owns the current page stays open even if the user collapsed
  // it. An item matches if its URL is the path or a parent of it.
  const inGroup = (urls: string[]) =>
    urls.some((u) => pathname === u || pathname.startsWith(u + "/"))
  // Hide any link the user can't reach — mirrors the API so the nav never
  // advertises a page that would only 403 (see NavItem for the gate kinds).
  // An item with no gate is universal and always shows.
  const itemVisible = (item: NavItem): boolean => {
    if (item.objectType) return canDo(item.objectType, "view")
    if (item.anyOf) return item.anyOf.some((t) => canDo(t, "view"))
    if (item.perm) return can(item.perm)
    return true
  }
  // Drop RBAC-hidden items, then any cluster (and section) left empty so a
  // sub-heading never dangles over zero links.
  const visibleSections = sections
    .map((section) => ({
      ...section,
      clusters: section.clusters
        .map((cluster) => ({
          ...cluster,
          items: cluster.items.filter(itemVisible),
        }))
        .filter((cluster) => cluster.items.length > 0),
    }))
    .filter((section) => section.clusters.length > 0)
  const sectionUrls = (section: (typeof visibleSections)[number]) =>
    section.clusters.flatMap((c) => c.items).map((i) => i.url)

  // Server-driven plugin nav: group enabled plugins' items by their `section`,
  // gated by the SAME RBAC rule as core nav (object_type/perm).
  const pluginNav = (pluginUi.data?.nav ?? []).filter((n) =>
    n.object_type ? canDo(n.object_type, "view") : n.perm ? can(n.perm) : true
  )
  const pluginGroups = new Map<string, typeof pluginNav>()
  for (const item of pluginNav) {
    const key = item.section || "Plugins"
    if (!pluginGroups.has(key)) pluginGroups.set(key, [])
    pluginGroups.get(key)!.push(item)
  }
  return (
    <Sidebar collapsible="icon" {...props}>
      {/* Header: tenant switcher.
          Currently a static "Danbyte / Acme Networks" item — when we wire
          /api/tenants/, swap the body of TenantSwitcher to fetch + map. */}
      <SidebarHeader>
        <TenantSwitcher />
      </SidebarHeader>

      <SidebarContent className="gap-0">
        {/* Dashboard sits above the grouped sections — single top-level item. */}
        <FavoritesSection />

        <SidebarGroup className="py-0.5">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="h-6"
                  tooltip="Dashboard"
                >
                  <Link to="/" activeOptions={{ exact: true }}>
                    <LayoutDashboard />
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {visibleSections.map((section) => (
          <NavGroup
            key={section.label}
            label={section.label}
            icon={section.icon}
            hasActive={inGroup(sectionUrls(section))}
          >
            {section.clusters.map((cluster, i) => (
              <React.Fragment key={cluster.label ?? i}>
                {/* NetBox-style sub-heading. Hidden in the icon-rail (where
                    there's no room for text) and omitted for unlabelled
                    clusters so short sections stay flat. */}
                {cluster.label && (
                  <div className="px-2 pt-1.5 pb-0 text-[10px] font-semibold tracking-[0.08em] text-primary uppercase group-data-[collapsible=icon]:hidden">
                    {cluster.label}
                  </div>
                )}
                <SidebarMenu>
                  {cluster.items.map((item) => (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton
                        asChild
                        size="sm"
                        className="h-6"
                        tooltip={item.title}
                      >
                        <Link to={item.url}>
                          {/* Icon only in the collapsed icon-rail; the expanded
                              list is plain text (category labels carry the icons). */}
                          <item.icon className="hidden group-data-[collapsible=icon]:block" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </React.Fragment>
            ))}
          </NavGroup>
        ))}

        {/* Plugin-contributed nav (server-driven, RBAC-gated above). */}
        {Array.from(pluginGroups.entries()).map(([label, items]) => (
          <NavGroup
            key={`plugin:${label}`}
            label={label}
            icon={Puzzle}
            hasActive={inGroup(items.map((i) => i.url))}
          >
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    className="h-6"
                    tooltip={item.title}
                  >
                    <Link to={item.url as never}>
                      <DynamicIcon
                        name={item.icon}
                        className="hidden group-data-[collapsible=icon]:block"
                      />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </NavGroup>
        ))}

        {/* Admin RBAC management stays pinned (for users.manage). Settings +
            Docs live in the user popover, not here. */}
        {canManage && (
          <NavGroup
            label="Admin"
            icon={UserCog}
            hasActive={inGroup(["/users", "/groups", "/permissions"])}
          >
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="h-6"
                  tooltip="Users"
                >
                  <Link to="/users">
                    <UsersRound className="hidden group-data-[collapsible=icon]:block" />
                    <span>Users</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="h-6"
                  tooltip="Groups"
                >
                  <Link to="/groups">
                    <UserCog className="hidden group-data-[collapsible=icon]:block" />
                    <span>Groups</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="h-6"
                  tooltip="Permissions"
                >
                  <Link to="/permissions">
                    <ShieldCheck className="hidden group-data-[collapsible=icon]:block" />
                    <span>Permissions</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </NavGroup>
        )}
      </SidebarContent>

      {/* Footer: just the signed-in user — Preferences / Settings / Docs all
          live in its popover now, so the nav stays focused on data pages. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

function FavoritesSection() {
  const {
    bookmarks,
    folders,
    add,
    update,
    remove,
    addFolder,
    updateFolder,
    removeFolder,
  } = useBookmarks()
  const [open, setOpen] = React.useState(false)
  const [folderName, setFolderName] = React.useState("")
  const [label, setLabel] = React.useState("")
  const [url, setUrl] = React.useState("")

  const rootFolders = folders.filter((f) => !f.parent)
  const rootBookmarks = bookmarks.filter((b) => !b.folder)
  const byParent = React.useMemo(() => {
    const map = new Map<string | null, BookmarkFolder[]>()
    for (const folder of folders) {
      const key = folder.parent ?? null
      map.set(key, [...(map.get(key) ?? []), folder])
    }
    return map
  }, [folders])
  const byFolder = React.useMemo(() => {
    const map = new Map<string | null, BookmarkRow[]>()
    for (const bookmark of bookmarks) {
      const key = bookmark.folder ?? null
      map.set(key, [...(map.get(key) ?? []), bookmark])
    }
    return map
  }, [bookmarks])

  const createFolder = () => {
    const name = folderName.trim()
    if (!name) return
    addFolder.mutate({ name }, { onSuccess: () => setFolderName("") })
  }
  const createBookmark = () => {
    const cleanUrl = url.trim()
    const cleanLabel = label.trim() || cleanUrl
    if (!cleanUrl || !cleanLabel) return
    add.mutate(
      { label: cleanLabel, url: cleanUrl },
      {
        onSuccess: () => {
          setLabel("")
          setUrl("")
        },
      }
    )
  }

  const hasFavorites = rootFolders.length > 0 || rootBookmarks.length > 0
  return (
    <SidebarGroup className="py-0.5">
      <SidebarGroupLabel className="flex items-center gap-2">
        <Bookmark className="size-4 shrink-0 opacity-60" />
        <span>Favorites</span>
        <button
          type="button"
          className="ml-auto rounded-sm opacity-60 hover:opacity-100"
          title="Manage favorites"
          onClick={() => setOpen(true)}
        >
          <Plus className="size-3.5" />
        </button>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {hasFavorites ? (
            <>
              {rootBookmarks.map((b) => (
                <FavoriteBookmark key={b.id} bookmark={b} />
              ))}
              {rootFolders.map((f) => (
                <FavoriteFolder
                  key={f.id}
                  folder={f}
                  byParent={byParent}
                  byFolder={byFolder}
                />
              ))}
            </>
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" className="h-6 opacity-70">
                <span>No favorites</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage favorites</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                New folder
              </h3>
              <div className="flex items-center gap-2">
                <Input
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createFolder()}
                  placeholder="Folder name"
                  className="h-8"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!folderName.trim()}
                  onClick={createFolder}
                >
                  Add folder
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                New bookmark
              </h3>
              <div className="space-y-2">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label (e.g. Active prefixes)"
                  className="h-8"
                />
                <div className="flex items-center gap-2">
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createBookmark()}
                    placeholder="/prefixes?status=active"
                    className="h-8 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!url.trim()}
                    onClick={createBookmark}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </section>

            {(folders.length > 0 || bookmarks.length > 0) && (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Organise
                </h3>
                <div className="max-h-72 overflow-auto rounded-lg border border-border">
                  {[...folders]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((folder) => (
                      <div
                        key={folder.id}
                        className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                      >
                        <Folder className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {folder.name}
                        </span>
                        <select
                          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          value={folder.parent ?? ""}
                          onChange={(e) =>
                            updateFolder.mutate({
                              id: folder.id,
                              parent: e.target.value || null,
                            })
                          }
                        >
                          <option value="">Root</option>
                          {folders
                            .filter((f) => f.id !== folder.id)
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.name}
                              </option>
                            ))}
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Delete folder"
                          onClick={() => removeFolder.mutate(folder.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  {[...bookmarks]
                    .sort((a, b) => a.label.localeCompare(b.label))
                    .map((bookmark) => (
                      <div
                        key={bookmark.id}
                        className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                      >
                        <Bookmark className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {bookmark.label}
                        </span>
                        <select
                          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          value={bookmark.folder ?? ""}
                          onChange={(e) =>
                            update.mutate({
                              id: bookmark.id,
                              folder: e.target.value || null,
                            })
                          }
                        >
                          <option value="">Root</option>
                          {folders.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Delete bookmark"
                          onClick={() => remove.mutate(bookmark.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                </div>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </SidebarGroup>
  )
}

function FavoriteBookmark({ bookmark }: { bookmark: BookmarkRow }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        size="sm"
        className="h-6"
        tooltip={bookmark.label}
      >
        <FavoriteLink bookmark={bookmark} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function FavoriteLink({ bookmark }: { bookmark: BookmarkRow }) {
  if (/^https?:\/\//.test(bookmark.url)) {
    return (
      <a href={bookmark.url} target="_blank" rel="noreferrer">
        <span>{bookmark.label}</span>
      </a>
    )
  }
  return (
    <Link to={bookmark.url as never}>
      <span>{bookmark.label}</span>
    </Link>
  )
}

function FavoriteFolder({
  folder,
  byParent,
  byFolder,
}: {
  folder: BookmarkFolder
  byParent: Map<string | null, BookmarkFolder[]>
  byFolder: Map<string | null, BookmarkRow[]>
}) {
  const [open, setOpen] = React.useState(false)
  const children = byParent.get(folder.id) ?? []
  const bookmarks = byFolder.get(folder.id) ?? []
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        size="sm"
        className="h-6"
        tooltip={folder.name}
        onClick={() => setOpen((v) => !v)}
      >
        <Folder className="hidden group-data-[collapsible=icon]:block" />
        <span>{folder.name}</span>
        <ChevronDown
          className={
            "ml-auto size-3 shrink-0 opacity-60 transition-transform " +
            (open ? "" : "-rotate-90")
          }
        />
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub>
          {bookmarks.map((bookmark) => (
            <SidebarMenuSubItem key={bookmark.id}>
              <SidebarMenuSubButton asChild>
                <FavoriteLink bookmark={bookmark} />
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
          {children.map((child) => (
            <FavoriteFolder
              key={child.id}
              folder={child}
              byParent={byParent}
              byFolder={byFolder}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

// ─── Tenant switcher ──────────────────────────────────────────────────────

function TenantSwitcher() {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["tenants-picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const active = useQuery({
    queryKey: ["tenant-active"],
    queryFn: () => api<TenantPicker | { id: null }>("/api/tenants/active/"),
    staleTime: 60_000,
  })
  const switchMutation = useMutation({
    mutationFn: (id: string) =>
      api<TenantPicker>(`/api/tenants/${id}/switch/`, { method: "POST" }),
    onSuccess: (t) => {
      // Hard boundary: a full navigation to "/" is the only way to guarantee
      // NO previous-tenant data survives the switch. qc.clear() empties the
      // cache but does NOT refetch already-mounted observers — they keep
      // rendering their stale (other-tenant) result until something re-triggers
      // them, a cross-tenant leak. A document load rebuilds every query against
      // the new active tenant from scratch.
      toast.success(`Switched to ${t.name}`)
      qc.clear()
      window.location.assign("/")
    },
    onError: (err) => apiErrorToast(err),
  })

  const tenants = list.data?.results ?? []
  const activeTenant: TenantPicker | null =
    active.data && "id" in active.data && active.data.id
      ? (active.data as TenantPicker)
      : (tenants[0] ?? null)
  const initial = activeTenant?.name.slice(0, 1).toUpperCase() ?? "·"

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div
                className="flex aspect-square size-8 items-center justify-center rounded-lg text-sidebar-primary-foreground"
                style={{
                  backgroundColor:
                    activeTenant?.color || "var(--sidebar-primary)",
                }}
              >
                {initial}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {activeTenant?.name ?? "No tenant"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {activeTenant?.slug ?? "select one to begin"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Switch tenant
            </DropdownMenuLabel>
            {tenants.length === 0 && (
              <DropdownMenuItem
                disabled
                className="gap-2 p-2 text-xs text-muted-foreground"
              >
                No tenants — create one in Tenants
              </DropdownMenuItem>
            )}
            {tenants.map((t) => {
              const isActive = activeTenant?.id === t.id
              return (
                <DropdownMenuItem
                  key={t.id}
                  disabled={!t.is_active || switchMutation.isPending}
                  onClick={() => switchMutation.mutate(t.id)}
                  className="gap-2 p-2"
                >
                  <div
                    className="flex size-6 items-center justify-center rounded-md text-[10px] text-white"
                    style={{ backgroundColor: t.color || "var(--muted)" }}
                  >
                    {t.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex flex-1 flex-col leading-tight">
                    <span className="text-sm">{t.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {t.slug}
                    </span>
                  </div>
                  {isActive && (
                    <span className="text-[10px] text-muted-foreground">
                      active
                    </span>
                  )}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 p-2">
              <Link to="/tenants">Manage tenants</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

// ─── Signed-in user (bottom) ─────────────────────────────────────────────

function UserMenu() {
  const { me, canManage } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const name = me.username || "Account"
  const email = me.email || ""
  const initials = name.slice(0, 2).toUpperCase()

  const logout = useMutation({
    mutationFn: () => auth.logout(),
    onSuccess: async () => {
      // Drop every cached query so the next account in this browser can't be
      // served the previous user's data (cross-account cache leak).
      qc.clear()
      await qc.invalidateQueries({ queryKey: ["me"] })
      navigate({ to: "/login", search: { redirect: undefined }, replace: true })
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{name}</span>
            {email && <span className="truncate text-xs">{email}</span>}
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col">
            <span className="text-sm font-medium">{name}</span>
            {email && (
              <span className="text-xs text-muted-foreground">{email}</span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/preferences">
            <SlidersHorizontal className="size-4" />
            Preferences
          </Link>
        </DropdownMenuItem>
        {canManage && (
          <DropdownMenuItem asChild>
            <Link to="/settings/admin">
              <SettingsIcon className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={docsUrl()} target="_blank" rel="noreferrer">
            <BookOpen className="size-4" />
            Docs
            <ExternalLink className="ml-auto size-3.5 opacity-50" />
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
