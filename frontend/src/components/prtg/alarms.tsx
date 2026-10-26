import type { PrtgConnection } from "@/lib/api"
import { NoSensors, PrtgSensorTable } from "./sensor-table"

/** PRTG's alarms: every sensor that is down or degraded, worst and newest
 * first, with PRTG's message and whether it is acknowledged there. */
export function PrtgAlarms({ connection }: { connection: PrtgConnection }) {
  return (
    <PrtgSensorTable
      connection={connection}
      variant="alarms"
      empty={<NoSensors alarms />}
    />
  )
}
