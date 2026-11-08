import { useState } from "react"

import type { PrtgConnection, PrtgSensor } from "@/lib/api"
import { Switch } from "@/components/ui/switch"
import { NoSensors, PrtgSensorTable } from "./sensor-table"

const notPaused = (r: PrtgSensor) => !r.paused

/** Every imported sensor of the connection, with its last value and
 * uptime. "Hide paused" drops paused sensors before the facets count. */
export function PrtgSensors({ connection }: { connection: PrtgConnection }) {
  const [hidePaused, setHidePaused] = useState(false)
  return (
    <PrtgSensorTable
      connection={connection}
      variant="sensors"
      rowFilter={hidePaused ? notPaused : undefined}
      empty={<NoSensors />}
      toolbar={
        <label className="inline-flex items-center gap-2 self-end text-xs whitespace-nowrap">
          <Switch
            checked={hidePaused}
            onCheckedChange={setHidePaused}
            aria-label="Hide paused"
          />
          Hide paused
        </label>
      }
    />
  )
}
