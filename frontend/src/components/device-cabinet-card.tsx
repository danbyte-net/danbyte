import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { Cabinet, Device } from "@/lib/api"
import {
  CabinetDeviceBodies,
  useCabinetDevices,
} from "@/components/cabinet-devices"
import { CabinetElevation } from "@/components/cabinet-elevation"
import { Section } from "@/components/ui/section"

/** Where the device sits in its cabinet - the plate drawn with its rails and
 * the devices on them, this one in the selection colour, linking to the
 * cabinet page. The rack card's twin; nothing for a device off the rails. */
export function DeviceCabinetCard({ device }: { device: Device }) {
  const cabinetId = device.cabinet?.id
  const cabinet = useQuery({
    queryKey: ["cabinet", cabinetId],
    queryFn: () => api<Cabinet>(`/api/cabinets/${cabinetId}/`),
    enabled: !!cabinetId,
    staleTime: 60_000,
  })
  const devices = useCabinetDevices(cabinetId)
  if (!device.cabinet || !device.din_rail || !cabinet.data) return null
  const c = cabinet.data
  return (
    <Section
      title={
        <span>
          Cabinet ·{" "}
          <Link to="/cabinets/$id" params={{ id: c.id }} className="link">
            {device.cabinet.name}
          </Link>
        </span>
      }
    >
      <div className="rounded-lg border border-border bg-card p-4">
        <CabinetElevation
          width={c.inner_width_mm}
          height={c.inner_height_mm}
          outerWidth={c.outer_width_mm}
          outerHeight={c.outer_height_mm}
          rails={c.rails.map((r) => ({ key: r.id, ...r }))}
          railLabels={false}
          className="max-h-80"
        >
          <CabinetDeviceBodies
            rails={c.rails}
            devices={devices.data?.results ?? [device]}
            highlight={device.id}
          />
        </CabinetElevation>
      </div>
    </Section>
  )
}
