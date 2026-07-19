// Small geographic helpers for the site map's vector layers.
//
// Equirectangular approximation — plenty accurate at camera-coverage scale
// (≤ ~1 km): one degree of latitude ≈ 111,320 m everywhere; a degree of
// longitude shrinks with cos(latitude).

const M_PER_DEG_LAT = 111_320

/** The point `meters` away from (lat, lng) at compass bearing `deg`
 *  (0° = north, clockwise). */
export function offsetPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  meters: number
): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180
  const dLat = (meters * Math.cos(rad)) / M_PER_DEG_LAT
  const dLng =
    (meters * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
  return [lat + dLat, lng + dLng]
}

/** Vertices for a field-of-view wedge: apex + arc sampled every ~6°.
 *  Mirrors the floorplan cone (direction 0° = up/north, clockwise;
 *  angle clamped 10–360). */
export function fovWedge(
  lat: number,
  lng: number,
  directionDeg: number,
  angleDeg: number,
  distanceM: number
): [number, number][] {
  const angle = Math.min(360, Math.max(10, angleDeg))
  const start = directionDeg - angle / 2
  const steps = Math.max(4, Math.ceil(angle / 6))
  const pts: [number, number][] = [[lat, lng]]
  for (let i = 0; i <= steps; i++) {
    pts.push(offsetPoint(lat, lng, start + (angle * i) / steps, distanceM))
  }
  return pts
}

/** Project lat/lng points into a local meter plane (equirectangular around
 *  `refLat`). Euclidean math — distances, projections, Dijkstra — is only
 *  correct in this plane, never in raw degrees (1° of longitude shrinks with
 *  latitude, and typical snap tolerances would span tens of km). */
export function projectToMeters(
  pts: [number, number][],
  refLat: number
): [number, number][] {
  const k = Math.cos((refLat * Math.PI) / 180)
  return pts.map(([lat, lng]) => [lat * M_PER_DEG_LAT, lng * M_PER_DEG_LAT * k])
}

export function unprojectFromMeters(
  pts: [number, number][],
  refLat: number
): [number, number][] {
  const k = Math.cos((refLat * Math.PI) / 180)
  return pts.map(([y, x]) => [y / M_PER_DEG_LAT, x / (M_PER_DEG_LAT * k)])
}
