import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import L from "leaflet"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  SiteMapOutline,
  SiteMapOutlineWritePayload,
  SiteMapSite,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"

import {
  centroid,
  dedupe,
  nearestIndex,
  outlineProblem,
} from "./outline-geometry"
import type { Pt } from "./outline-geometry"
import {
  buildOutlineDraftLayer,
  buildOutlineReshapeLayer,
  buildOutlinesLayer,
} from "./outlines-layer"

export const OUTLINES_KEY = ["site-map-outlines"] as const

/** Outlines sit under every line and marker: their own pane below the
 * overlay pane (400), above the tiles (200). */
const PANE = "smOutlines"

function ensurePane(map: L.Map) {
  if (!map.getPane(PANE)) {
    const pane = map.createPane(PANE)
    pane.style.zIndex = "350"
  }
}

/**
 * The Site map's building outlines: the list, the layer, the Outline tool
 * (click points, double-click or Enter to finish, Esc to cancel) and the
 * reshape handles of the selected outline in Layout mode. The page owns the
 * selection; this owns everything else, so the page only wires it in.
 */
export function useOutlineTool({
  map,
  mapReady,
  mode,
  shown,
  showLabels,
  hiddenSiteIds,
  sites,
  selectedId,
  onSelect,
  passive = false,
}: {
  map: L.Map | null
  mapReady: boolean
  mode: "view" | "layout" | "cables"
  /** Display → Layers → Outlines. */
  shown: boolean
  /** Display → Labels → Names. */
  showLabels: boolean
  /** Sites the sidebar's eyes have hidden - their outlines go with them. */
  hiddenSiteIds: Set<string>
  sites: SiteMapSite[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Something else is armed (placing a site, device or marker): outlines
   * let clicks through to the map. */
  passive?: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canView = canDo("sitemapoutline", "view")
  const canAdd = canDo("sitemapoutline", "add")
  const canChange = canDo("sitemapoutline", "change")
  const canDelete = canDo("sitemapoutline", "delete")

  const query = useQuery({
    queryKey: OUTLINES_KEY,
    queryFn: () => apiAll<SiteMapOutline>("/api/site-map-outlines/"),
    enabled: canView,
    staleTime: 30_000,
  })
  const outlines = useMemo(
    () =>
      (query.data?.results ?? []).filter((o) => !hiddenSiteIds.has(o.site_id)),
    [query.data, hiddenSiteIds]
  )
  const selected = outlines.find((o) => o.id === selectedId) ?? null

  const replace = useCallback(
    (o: SiteMapOutline) => {
      qc.setQueryData<{ results: SiteMapOutline[] }>(OUTLINES_KEY, (prev) =>
        prev
          ? {
              ...prev,
              results: prev.results.map((x) => (x.id === o.id ? o : x)),
            }
          : prev
      )
      qc.invalidateQueries({ queryKey: ["site-map-outline-drilldown", o.id] })
    },
    [qc]
  )
  const create = useMutation({
    mutationFn: (payload: SiteMapOutlineWritePayload) =>
      api<SiteMapOutline>("/api/site-map-outlines/", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: OUTLINES_KEY })
      onSelect(o.id)
      toast.success(`Added ${o.display_label || "outline"}`)
    },
    onError: (e) => apiErrorToast(e),
  })
  // A refused reshape rebuilds the handles where the outline really is.
  const [nonce, setNonce] = useState(0)
  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string
      body: SiteMapOutlineWritePayload
    }) =>
      api<SiteMapOutline>(`/api/site-map-outlines/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: replace,
    onError: (e) => {
      setNonce((n) => n + 1)
      apiErrorToast(e)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/site-map-outlines/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OUTLINES_KEY })
      onSelect(null)
    },
    onError: (e) => apiErrorToast(e),
  })

  // ── drawing ─────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<Pt[] | null>(null)
  const [pending, setPending] = useState<Pt[] | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const finish = useCallback(() => {
    const pts = dedupe(draftRef.current ?? [])
    const problem = outlineProblem(pts)
    if (problem) {
      toast.error(problem)
      setDraft(pts)
      return
    }
    setDraft(null)
    setPending(pts)
  }, [])

  useEffect(() => {
    if (!map || draft === null) return
    const onClick = (e: L.LeafletMouseEvent) =>
      setDraft((prev) =>
        prev ? [...prev, [e.latlng.lat, e.latlng.lng]] : prev
      )
    const onDbl = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      finish()
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Escape") setDraft(null)
      if (e.key === "Enter") {
        e.preventDefault()
        finish()
      }
    }
    map.doubleClickZoom.disable()
    map.on("click", onClick)
    map.on("dblclick", onDbl)
    window.addEventListener("keydown", onKey)
    return () => {
      map.off("click", onClick)
      map.off("dblclick", onDbl)
      window.removeEventListener("keydown", onKey)
      map.doubleClickZoom.enable()
    }
    // Bound once per drawing session: the handlers read the draft by ref.
  }, [map, draft === null, finish])

  // Leaving Layout mode drops a half-drawn outline.
  useEffect(() => {
    if (mode !== "layout") setDraft(null)
  }, [mode])

  // The site an outline lands at by default: the nearest placed site the
  // user may edit.
  const defaultSiteId = useMemo(() => {
    if (!pending) return null
    const editable = sites.filter((s) => s.can_edit && s.latitude !== null)
    if (editable.length === 0) return sites.find((s) => s.can_edit)?.id ?? null
    const i = nearestIndex(
      centroid(pending),
      editable.map((s) => [Number(s.latitude), Number(s.longitude)] as Pt)
    )
    return editable[i]?.id ?? null
  }, [pending, sites])

  // ── layers ──────────────────────────────────────────────────────────────
  const layerRef = useRef<L.LayerGroup | null>(null)
  useEffect(() => {
    if (!map) return
    ensurePane(map)
    layerRef.current?.remove()
    layerRef.current = null
    if (!shown || outlines.length === 0) return
    const layer = buildOutlinesLayer(outlines, {
      selectedId,
      showLabels,
      onSelect: (id) => onSelect(id),
      pane: PANE,
      interactive: draft === null && !passive,
    })
    layer.addTo(map)
    layerRef.current = layer
  }, [
    map,
    mapReady,
    outlines,
    shown,
    selectedId,
    showLabels,
    draft === null,
    passive,
  ])

  // Delete removes the selected outline in Layout mode.
  useEffect(() => {
    if (mode !== "layout" || !selected || !canDelete || draft !== null) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        remove.mutate(selected.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mode, selected?.id, canDelete, draft === null])
  useEffect(() => () => void layerRef.current?.remove(), [])

  const draftLayerRef = useRef<L.LayerGroup | null>(null)
  useEffect(() => {
    draftLayerRef.current?.remove()
    draftLayerRef.current = null
    if (!map || !draft || draft.length === 0) return
    const layer = buildOutlineDraftLayer(draft)
    layer.addTo(map)
    draftLayerRef.current = layer
    return () => void layer.remove()
  }, [map, draft])

  const reshapeRef = useRef<L.LayerGroup | null>(null)
  const reshaping =
    mode === "layout" && canChange && !!selected && !selected.locked && !draft
  useEffect(() => {
    reshapeRef.current?.remove()
    reshapeRef.current = null
    if (!map || !reshaping) return
    const layer = buildOutlineReshapeLayer(selected.points, (pts) => {
      const problem = outlineProblem(pts)
      if (problem) {
        toast.error(problem)
        setNonce((n) => n + 1)
        return
      }
      patch.mutate({ id: selected.id, body: { points: pts } })
    })
    layer.addTo(map)
    reshapeRef.current = layer
    return () => void layer.remove()
  }, [map, reshaping, selected, nonce])

  return {
    canView,
    canAdd,
    canChange,
    canDelete,
    outlines,
    selected,
    drawing: draft !== null,
    draftCount: draft?.length ?? 0,
    startDraw: () => {
      onSelect(null)
      setDraft([])
    },
    cancelDraw: () => setDraft(null),
    pending,
    defaultSiteId,
    cancelCreate: () => setPending(null),
    create: (payload: SiteMapOutlineWritePayload) => {
      create.mutate(payload)
      setPending(null)
    },
    patch: (id: string, body: SiteMapOutlineWritePayload) =>
      patch.mutate({ id, body }),
    remove: (id: string) => remove.mutate(id),
  }
}
