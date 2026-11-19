import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Package } from "lucide-react"

import { api } from "@/lib/api"
import type { ModelPack, ModelPackLimits, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { buildModelPackColumns } from "@/components/columns/model-pack-columns"
import { ModelPackInstallDialog } from "@/components/model-pack-install-dialog"

export const Route = createFileRoute("/settings/device-library")({
  component: DeviceLibrarySettingsPage,
})

/** Settings → Device library: the 3D model packs installed in this tenant,
 * and the installer (docs/dcim/model-packs.md). */
function DeviceLibrarySettingsPage() {
  const { canDo, isLoading: meLoading } = useMe()
  const canView = canDo("devicetype", "view")
  const [installing, setInstalling] = useState(false)

  const list = useQuery({
    queryKey: ["model-packs", "installed"],
    queryFn: () =>
      api<Paginated<ModelPack>>(
        "/api/model-packs/?status=installed&kind=pack&page_size=200"
      ),
    enabled: canView,
  })
  const limits = useQuery({
    queryKey: ["model-packs", "limits"],
    queryFn: () => api<ModelPackLimits>("/api/model-packs/limits/"),
    enabled: canView,
  })
  const columns = useMemo(() => buildModelPackColumns(), [])
  const rows = list.data?.results ?? []
  // Packs installed from a bundle sit under it; the others under "Packs".
  const grouped = rows.some((r) => r.bundle)

  if (meLoading) return null
  if (!canView)
    return (
      <p className="text-sm text-muted-foreground">
        You don't have permission to view device types.
      </p>
    )
  return (
    <div className="max-w-5xl space-y-4">
      <SettingsHeader title="Device library">
        Models, photos, ports and LEDs for device and module types, shipped as
        packs.
      </SettingsHeader>
      <SettingsCard
        title="3D model packs"
        layout="plain"
        footer={
          limits.data?.can_install ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setInstalling(true)}
            >
              <Package className="h-3.5 w-3.5" /> Install pack…
            </Button>
          ) : undefined
        }
      >
        {list.isError ? (
          <QueryError error={list.error} />
        ) : list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None installed.</p>
        ) : (
          <DataTable
            data={rows}
            columns={columns}
            tableId="model-packs"
            flexColumn="name"
            autoColumns={false}
            groupBy={grouped ? "bundle" : undefined}
            initialColumnVisibility={grouped ? { bundle: false } : undefined}
            pagedWhenGrouped={false}
            renderGroupHeader={({ count, sampleRow }) => {
              const b = sampleRow.bundle
              return (
                <span className="inline-flex items-center gap-2 tracking-normal normal-case">
                  {b?.id ? (
                    <Link
                      to="/settings/device-library/packs/$id"
                      params={{ id: b.id }}
                      className="link text-[13px] font-medium"
                    >
                      {`${b.name || b.slug} ${b.version}`.trim()}
                    </Link>
                  ) : (
                    <span className="text-[13px] font-medium text-foreground">
                      {b ? `${b.name || b.slug} ${b.version}`.trim() : "Packs"}
                    </span>
                  )}
                  <Badge variant="secondary">
                    {count} pack{count === 1 ? "" : "s"}
                  </Badge>
                </span>
              )
            }}
          />
        )}
      </SettingsCard>
      <ModelPackInstallDialog open={installing} onOpenChange={setInstalling} />
    </div>
  )
}
