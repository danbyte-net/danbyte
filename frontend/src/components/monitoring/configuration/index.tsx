import { useState } from "react"

import { SegmentedTabs } from "@/components/segmented-tabs"
import { MonitoringConfigProvider } from "./config-context"
import { DenySubnetsPanel } from "./deny-panel"
import {
  buildDevicePolicyColumns,
  buildDeviceRolePolicyColumns,
  buildDeviceTypePolicyColumns,
} from "./device-columns"
import { PolicyTable } from "./policy-table"
import { PrefixPolicyTable } from "./prefix-panel"
import { ProfilesPanel } from "./profiles-panel"

type ConfigTab = "global" | "devices" | "types" | "roles" | "prefixes" | "deny"

// Monitoring configuration: scope-based policy (what checks apply to what)
// across the inheritance hierarchy. One module per panel — see the sibling
// files in this directory.
export function MonitoringConfiguration() {
  const [tab, setTab] = useState<ConfigTab>("prefixes")

  return (
    <MonitoringConfigProvider>
      {/* Same shell as /prefixes: bordered tab strip, then the rail + table
          row runs edge-to-edge and scrolls inside its own columns. */}
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => setTab(v as ConfigTab)}
          items={[
            { value: "prefixes", label: "Prefixes" },
            { value: "devices", label: "Devices" },
            { value: "types", label: "Device types" },
            { value: "roles", label: "Device roles" },
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
