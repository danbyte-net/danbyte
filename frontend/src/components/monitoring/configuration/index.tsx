import { useNavigate, useSearch } from "@tanstack/react-router"

import { SegmentedTabs } from "@/components/segmented-tabs"
import { MonitoringConfigProvider } from "./config-context"
import { DenySubnetsPanel } from "./deny-panel"
import {
  buildDevicePolicyColumns,
  buildDeviceRolePolicyColumns,
  buildDeviceTypePolicyColumns,
  buildPlatformPolicyColumns,
  buildRegionPolicyColumns,
  buildSitePolicyColumns,
} from "./device-columns"
import { PolicyTable } from "./policy-table"
import { PrefixPolicyTable } from "./prefix-panel"
import { ProfilesPanel } from "./profiles-panel"

export const CONFIG_TABS = [
  "global",
  "regions",
  "sites",
  "prefixes",
  "platforms",
  "types",
  "roles",
  "devices",
  "deny",
] as const
export type ConfigTab = (typeof CONFIG_TABS)[number]

// Monitoring configuration: scope-based policy (what checks apply to what)
// across the inheritance hierarchy. One module per panel - see the sibling
// files in this directory.
export function MonitoringConfiguration() {
  // The tab is a URL parameter so a link to "the platforms policies" exists
  // and a reload lands where it was.
  const { scope } = useSearch({ from: "/monitoring" })
  const navigate = useNavigate({ from: "/monitoring" })
  const tab: ConfigTab = scope ?? "prefixes"
  const setTab = (next: ConfigTab) =>
    void navigate({
      search: (prev) => ({ ...prev, scope: next }),
      replace: true,
    })

  return (
    <MonitoringConfigProvider>
      {/* Same shell as /prefixes: bordered tab strip, then the rail + table
          row runs edge-to-edge and scrolls inside its own columns. */}
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => setTab(v as ConfigTab)}
          items={[
            // Loosest scope first, the order the resolver ranks them in, so
            // the strip reads as the inheritance chain it is.
            { value: "regions", label: "Regions" },
            { value: "sites", label: "Sites" },
            { value: "prefixes", label: "Prefixes" },
            { value: "platforms", label: "Platforms" },
            { value: "types", label: "Device types" },
            { value: "roles", label: "Device roles" },
            { value: "devices", label: "Devices" },
            { value: "global", label: "Global templates" },
            { value: "deny", label: "Prefix deny" },
          ]}
        />
      </div>
      {tab === "global" && (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <ProfilesPanel />
        </div>
      )}
      {tab === "regions" && (
        <PolicyTable
          scope="region"
          endpoint="/api/regions/?page_size=500"
          tableId="monitoring-config-regions"
          exportName="monitoring-region-policies"
          buildColumns={buildRegionPolicyColumns}
        />
      )}
      {tab === "sites" && (
        <PolicyTable
          scope="site"
          endpoint="/api/sites/?page_size=500"
          tableId="monitoring-config-sites"
          exportName="monitoring-site-policies"
          buildColumns={buildSitePolicyColumns}
        />
      )}
      {tab === "platforms" && (
        <PolicyTable
          scope="platform"
          endpoint="/api/platforms/?page_size=500"
          tableId="monitoring-config-platforms"
          exportName="monitoring-platform-policies"
          buildColumns={buildPlatformPolicyColumns}
        />
      )}
      {tab === "devices" && (
        <PolicyTable
          scope="device"
          endpoint="/api/devices/?page_size=500"
          tableId="monitoring-config-devices"
          exportName="monitoring-device-policies"
          buildColumns={buildDevicePolicyColumns}
        />
      )}
      {tab === "types" && (
        <PolicyTable
          scope="device_type"
          endpoint="/api/device-types/?page_size=500"
          tableId="monitoring-config-device-types"
          exportName="monitoring-device-type-policies"
          buildColumns={buildDeviceTypePolicyColumns}
        />
      )}
      {tab === "roles" && (
        <PolicyTable
          scope="device_role"
          endpoint="/api/device-roles/?page_size=500"
          tableId="monitoring-config-device-roles"
          exportName="monitoring-device-role-policies"
          buildColumns={buildDeviceRolePolicyColumns}
        />
      )}
      {tab === "prefixes" && <PrefixPolicyTable />}
      {tab === "deny" && (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <DenySubnetsPanel />
        </div>
      )}
    </MonitoringConfigProvider>
  )
}
