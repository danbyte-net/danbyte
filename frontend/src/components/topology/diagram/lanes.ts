import { Grid, inflate, segBox, segHitsRect } from "./spatial"
import type { Dir, End, Pt, Rect } from "./types"

// The elbow planner: every elbow cable gets its own route, clear of the
// cards it does not connect, and its own lane wherever it runs beside
// other cables.
//
// 1. Each cable is routed alone (`elbowBase`): straight out of its port for
//    at least its stub (long enough for its port name), across a corridor,
//    straight into the far port. A corridor blocked by a card is moved, and
//    when no corridor between the two cards is clear the route steps round
//    through a clear street.
// 2. Cables that meet at one point (a Simple side midpoint, a breakout's
//    junction) separate right after it: each turns off at its own depth,
//    `LANE` px apart (`sharedPins`).
// 3. Runs of different cables that share a corridor are spread `LANE` px
//    apart (`assignLanes`), in the order that keeps them from crossing -
//    a cable that turns off inside another's run is put on the side it
//    turns to - and within the room each end's stub leaves.
//
// Pure: ends and boxes in, polylines out. Coordinates are flow px.

/** Spacing between parallel cables. */
export const LANE = 12
/** How far a route keeps from a card it does not connect. */
export const CLEAR = 8
/** The common straight run out of a shared point before the first cable
 * turns off. */
export const SHARED_STUB = 8
/** Ends closer than this across are drawn as one straight run. */
export const SNAP = 2
const STEPS = 20

/** A cable end as the planner sees it. */
export interface PlanEnd extends End {
  /** The node the end sits on (never an obstacle for its own cable). */
  node: string
  /** The straight run the end needs before its first bend. */
  stub: number
  /** Ends meeting at one point share a key. */
  shared?: string
}

export interface ElbowCable {
  key: string
  a: PlanEnd
  b: PlanEnd
}

/** An elbow route: terminals included, every segment axis-aligned. */
export interface ElbowRoute {
  pts: Pt[]
  /** The first / last interior run turns off a shared point at this
   * depth: the lanes may move it further out, never nearer. */
  pinA?: number
  pinB?: number
}

/** The cards routes keep clear of. */
export type Obstacles = Grid<{ id: string; r: Rect }>

export function obstacles(rects: Iterable<[string, Rect]>): Obstacles {
  const g: Obstacles = new Grid(128)
  for (const [id, r] of rects)
    if (r.w > 0 && r.h > 0) g.add(inflate(r, CLEAR), { id, r })
  return g
}

// ── Frames ───────────────────────────────────────────────────────────────
// Each cable is routed in the frame where its A end leaves downwards
// (+y): one case analysis serves all four sides.

interface Frame {
  f: (p: Pt) => Pt
  b: (p: Pt) => Pt
}

const FRAMES: Record<string, Frame> = {
  "0,1": { f: (p) => ({ x: p.x, y: p.y }), b: (p) => ({ x: p.x, y: p.y }) },
  "0,-1": { f: (p) => ({ x: p.x, y: -p.y }), b: (p) => ({ x: p.x, y: -p.y }) },
  "1,0": { f: (p) => ({ x: p.y, y: p.x }), b: (p) => ({ x: p.y, y: p.x }) },
  "-1,0": {
    f: (p) => ({ x: p.y, y: -p.x }),
    b: (p) => ({ x: -p.y, y: p.x }),
  },
}

function frameOf(d: Dir): Frame {
  const sx = Math.abs(d[0]) < 0.5 ? 0 : Math.sign(d[0])
  const sy = Math.abs(d[1]) < 0.5 ? 0 : Math.sign(d[1])
  return FRAMES[`${sx},${sy}`] ?? FRAMES["0,1"]
}

/** The unit vector a side's positions run along, for an end leaving
 * through it: left to right on top and bottom, top to bottom on the
 * sides. */
export function alongOf(d: Dir): Pt {
  return Math.abs(d[1]) > Math.abs(d[0]) ? { x: 1, y: 0 } : { x: 0, y: 1 }
}

const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y

// ── Clearance ────────────────────────────────────────────────────────────

/** Does one run keep clear of every card? A route's own cards may be
 * touched only by its first and last runs (`terminal`: they start on
 * them). */
function segClear(
  o: Obstacles,
  p: Pt,
  q: Pt,
  own: readonly string[],
  terminal: boolean
): boolean {
  for (const { id, r } of o.near(segBox(p, q, 1))) {
    const mine = own.includes(id)
    const box = mine ? inflate(r, terminal ? -0.5 : 1) : inflate(r, CLEAR)
    if (segHitsRect(p, q, box)) return false
  }
  return true
}

/** Does a route keep clear of every card? */
export function pathClear(
  o: Obstacles,
  pts: readonly Pt[],
  own: readonly string[]
): boolean {
  for (let i = 0; i < pts.length - 1; i++)
    if (!segClear(o, pts[i], pts[i + 1], own, i === 0 || i === pts.length - 2))
      return false
  return true
}

/** `ideal`, then alternately further each way in `LANE` steps, within
 * [lo, hi] (just `ideal` when the range is empty). */
function ladder(ideal: number, lo: number, hi: number): number[] {
  if (!(lo <= hi)) return [ideal]
  const c = Math.min(hi, Math.max(lo, ideal))
  const out = [c]
  for (let k = 1; k <= STEPS; k++) {
    const up = c + k * LANE
    const dn = c - k * LANE
    if (up <= hi) out.push(up)
    if (dn >= lo) out.push(dn)
    if (up > hi && dn < lo) break
  }
  return out
}

/** `start`, then on in `LANE` steps the way `sign` points. */
const onward = (start: number, sign: 1 | -1, n = STEPS) =>
  Array.from({ length: n + 1 }, (_, k) => start + sign * k * LANE)

// ── One cable ────────────────────────────────────────────────────────────

/** The straight run every elbow end gets at least, even when its port
 * name does not fit (the route keeps clear of cards first; a name with no
 * room is left off). */
export const MIN_STUB = 14

/**
 * One elbow cable routed alone. `pinA` / `pinB` hold the first / last
 * corridor at that depth from the end (a shared point's stagger).
 * Clearance comes first: the route keeps each end's full stub and its
 * stagger when a clear route allows it, then gives up the stubs (down to
 * `MIN_STUB`, a port name with no room is left off), then the stagger (the
 * lanes still part the cables). With no clear route at all it keeps the
 * first one it tried.
 */
export function elbowBase(
  c: ElbowCable,
  o: Obstacles,
  pinA?: number,
  pinB?: number
): ElbowRoute {
  const loose = c.a.stub <= MIN_STUB && c.b.stub <= MIN_STUB
  const full = { sa: c.a.stub, sb: c.b.stub }
  const tight = {
    sa: Math.min(c.a.stub, MIN_STUB),
    sb: Math.min(c.b.stub, MIN_STUB),
  }
  const tries = [{ ...full, pins: true }]
  if (!loose) tries.push({ ...tight, pins: true })
  if (pinA !== undefined || pinB !== undefined) {
    tries.push({ ...full, pins: false })
    if (!loose) tries.push({ ...tight, pins: false })
  }
  let first: ElbowRoute | null = null
  for (const t of tries) {
    const r = t.pins
      ? routeWith(c, o, t.sa, t.sb, pinA, pinB)
      : routeWith(c, o, t.sa, t.sb)
    if (r.clear) return r.route
    first ??= r.route
  }
  return first!
}

function routeWith(
  c: ElbowCable,
  o: Obstacles,
  stubA: number,
  stubB: number,
  pinA?: number,
  pinB?: number
): { route: ElbowRoute; clear: boolean } {
  const F = frameOf(c.a.dir)
  const A = F.f(c.a)
  const B = F.f(c.b)
  const bd = F.f({ x: c.b.dir[0], y: c.b.dir[1] })
  const own = [c.a.node, c.b.node]
  const real = (pts: Pt[]) => pts.map(F.b)
  const ok = (pts: Pt[]) => pathClear(o, real(pts), own)
  const done = (
    pts: Pt[],
    clear: boolean,
    pins: { pinA?: boolean; pinB?: boolean } = {}
  ) => ({
    route: {
      pts: real(pts),
      ...(pins.pinA && pinA !== undefined ? { pinA } : {}),
      ...(pins.pinB && pinB !== undefined ? { pinB } : {}),
    },
    clear,
  })
  const sA = pinA ?? stubA
  const sB = pinB ?? stubB

  /** Round a blocked straight run: out to c1, across to a clear street,
   * along it to c2, across and in. */
  const detour = (c1s: number[], c2s: number[]): Pt[] | null => {
    const c1 = c1s.find((y) => ok([A, { x: A.x, y }])) ?? c1s[0]
    const c2 = c2s.find((y) => ok([{ x: B.x, y }, B])) ?? c2s[0]
    const mid = (A.x + B.x) / 2
    const cand = new Set<number>()
    for (let k = 0; k <= 40; k++) {
      cand.add(mid + k * LANE)
      cand.add(mid - k * LANE)
    }
    // The streets beside the cards across the way.
    const lo = Math.min(c1, c2)
    const hi = Math.max(c1, c2)
    const band = segBox(F.b({ x: mid, y: lo }), F.b({ x: mid, y: hi }), 0)
    const reach = Math.abs(A.x - B.x) / 2 + 40 * LANE
    const across = F.b({ x: reach, y: 0 })
    const wide = {
      x: band.x - Math.abs(across.x),
      y: band.y - Math.abs(across.y),
      w: band.w + 2 * Math.abs(across.x),
      h: band.h + 2 * Math.abs(across.y),
    }
    for (const { r } of o.near(wide)) {
      const p = F.f({ x: r.x, y: r.y })
      const q = F.f({ x: r.x + r.w, y: r.y + r.h })
      cand.add(Math.min(p.x, q.x) - CLEAR - LANE / 2)
      cand.add(Math.max(p.x, q.x) + CLEAR + LANE / 2)
    }
    const order = [...cand]
      .sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y)
      .slice(0, 160)
    for (const v of order) {
      // The street itself first: it is what most often fails.
      const s1 = F.b({ x: v, y: c1 })
      const s2 = F.b({ x: v, y: c2 })
      if (!segClear(o, s1, s2, own, false)) continue
      const pts = [
        A,
        { x: A.x, y: c1 },
        { x: v, y: c1 },
        { x: v, y: c2 },
        { x: B.x, y: c2 },
        B,
      ]
      // The end runs were checked with c1 and c2: only the crossings.
      if (
        segClear(o, F.b(pts[1]), s1, own, false) &&
        segClear(o, s2, F.b(pts[4]), own, false) &&
        ok([A, pts[1]]) &&
        ok([pts[4], B])
      )
        return pts
    }
    return null
  }

  // B faces back towards A.
  if (Math.abs(bd.x) < 0.5 && bd.y < 0) {
    if (B.y > A.y) {
      const lo = A.y + sA
      const hi = B.y - sB
      if (
        pinA === undefined &&
        pinB === undefined &&
        Math.abs(A.x - B.x) < SNAP
      ) {
        const s = [A, { x: A.x, y: B.y }]
        if (ok(s)) return done(s, true)
      }
      if (pinA !== undefined && pinB !== undefined) {
        const d = detour([lo], [hi])
        if (d) return done(d, true, { pinA: true, pinB: true })
      }
      // Halfway across the gap, whatever the stubs, so every cable
      // between two cards starts from one corridor.
      const gapMid = (A.y + B.y) / 2
      const ideal =
        pinA !== undefined
          ? lo
          : pinB !== undefined
            ? hi
            : lo <= hi
              ? Math.min(hi, Math.max(lo, gapMid))
              : gapMid
      const pinned = pinA !== undefined || pinB !== undefined
      const z = (y: number) => [A, { x: A.x, y }, { x: B.x, y }, B]
      const cands = pinned ? [ideal] : ladder(ideal, lo, hi)
      const hit = cands.find((y) => ok(z(y)))
      if (hit !== undefined) {
        // Moved off a blocked middle: to the middle of the clear run it
        // found, not hard against the card that blocked it.
        let y = hit
        if (!pinned && hit !== ideal) {
          const step = hit > ideal ? 4 : -4
          let far = hit
          while (
            Math.abs(far + step - hit) <= 20 * LANE &&
            far + step >= lo &&
            far + step <= hi &&
            ok(z(far + step))
          )
            far += step
          y = (hit + far) / 2
        }
        return done(z(y), true, pinFor(pinA, pinB))
      }
      const d = detour(
        pinA !== undefined ? [lo] : ladder(lo, lo, lo + STEPS * LANE),
        pinB !== undefined ? [hi] : onward(hi, -1)
      )
      if (d) return done(d, true, pinFor(pinA, pinB))
      return done(z(ideal), false, pinFor(pinA, pinB))
    }
    // B behind A: out, round, and back in.
    const d = detour(onward(A.y + sA, 1), onward(B.y - sB, -1))
    if (d) return done(d, true)
    const y1 = A.y + sA
    const y2 = B.y - sB
    const v = (A.x + B.x) / 2
    return done(
      [
        A,
        { x: A.x, y: y1 },
        { x: v, y: y1 },
        { x: v, y: y2 },
        { x: B.x, y: y2 },
        B,
      ],
      false
    )
  }

  // Both leave the same way: out past both and across.
  if (Math.abs(bd.x) < 0.5) {
    const start = Math.max(A.y + sA, B.y + sB)
    const u = (y: number) => [A, { x: A.x, y }, { x: B.x, y }, B]
    for (const y of onward(start, 1)) if (ok(u(y))) return done(u(y), true)
    return done(u(start), false)
  }

  // B leaves sideways: one corner when it is ahead of both stubs.
  const bx = bd.x > 0 ? 1 : -1
  if (B.y - A.y >= sA && (A.x - B.x) * bx >= sB) {
    const l = [A, { x: A.x, y: B.y }, B]
    if (ok(l)) return done(l, true)
  }
  const four = (y: number, x: number) => [
    A,
    { x: A.x, y },
    { x, y },
    { x, y: B.y },
    B,
  ]
  const ys = onward(A.y + sA, 1, 6)
  const xs = onward(B.x + bx * sB, bx > 0 ? 1 : -1, 6)
  for (const y of ys)
    for (const x of xs) if (ok(four(y, x))) return done(four(y, x), true)
  return done(four(ys[0], xs[0]), false)
}

const pinFor = (pinA?: number, pinB?: number) => ({
  ...(pinA !== undefined ? { pinA: true } : {}),
  ...(pinB !== undefined ? { pinB: true } : {}),
})

/**
 * Stagger depths for ends that meet at one point: each group's cables turn
 * off `SHARED_STUB + LANE * rank` px out, the one heading furthest round
 * first so the turns nest instead of crossing. Cables running straight on
 * need no pin. Keyed `${cable key}:a|b`.
 */
export function sharedPins(cables: readonly ElbowCable[]): Map<string, number> {
  const groups = new Map<
    string,
    { key: string; turn: number; extent: number }[]
  >()
  for (const c of cables)
    for (const end of ["a", "b"] as const) {
      const e = c[end]
      const other = end === "a" ? c.b : c.a
      if (!e.shared) continue
      const along = alongOf(e.dir)
      const d = dot(other, along) - dot(e, along)
      const list = groups.get(e.shared) ?? []
      list.push({
        key: `${c.key}:${end}`,
        turn: Math.abs(d) < SNAP ? 0 : Math.sign(d),
        extent: dot(other, along),
      })
      groups.set(e.shared, list)
    }
  const pins = new Map<string, number>()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    for (const turn of [1, -1]) {
      const side = list
        .filter((m) => m.turn === turn)
        .sort(
          (x, y) =>
            (turn > 0 ? y.extent - x.extent : x.extent - y.extent) ||
            (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
        )
      side.forEach((m, rank) => pins.set(m.key, SHARED_STUB + LANE * rank))
    }
  }
  return pins
}

/** How a route leaves one of its ends: which way along the side it turns
 * first (-1, 0 or +1), how far out that turn is, and where along the side
 * its first cross run ends. What orders a side's nubs so routes nest. */
export function endTurn(
  pts: readonly Pt[],
  e: End
): { turn: -1 | 0 | 1; depth: number; extent: number } {
  const along = alongOf(e.dir)
  const dir = { x: e.dir[0], y: e.dir[1] }
  if (pts.length < 3)
    return { turn: 0, depth: Infinity, extent: dot(pts[pts.length - 1], along) }
  const v = { x: pts[2].x - pts[1].x, y: pts[2].y - pts[1].y }
  const t = dot(v, along)
  return {
    turn: Math.abs(t) < 1e-6 ? 0 : t > 0 ? 1 : -1,
    depth: dot({ x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }, dir),
    extent: dot(pts[2], along),
  }
}

// ── Lanes ────────────────────────────────────────────────────────────────

interface Run {
  route: number
  k: number
  /** Horizontal run (its coordinate is a y). */
  h: boolean
  c: number
  /** The range that keeps each end's full stub (room for its port
   * name)… */
  lo: number
  hi: number
  /** …and the range that keeps only the least one. */
  lo2: number
  hi2: number
  /** An end run: it starts on a port and cannot move. */
  pinned: boolean
  /** Its extent along its own axis. */
  s0: number
  s1: number
  /** Which way the route goes on from each end, across the run's axis:
   * -1, 0 or +1. */
  d0: number
  d1: number
}

/** The coordinate range a stub leaves the run next to it. */
function bound(e: PlanEnd, stub = e.stub): [number, number] {
  const [dx, dy] = e.dir
  if (dy > 0.5) return [e.y + stub, Infinity]
  if (dy < -0.5) return [-Infinity, e.y - stub]
  if (dx > 0.5) return [e.x + stub, Infinity]
  return [-Infinity, e.x - stub]
}

/** A run's range beside an end: the full stub, or - on a route that had
 * to give its stubs up - the least one. */
function boundAt(e: PlanEnd, c: number): [number, number] {
  const [lo, hi] = bound(e)
  if (c >= lo && c <= hi) return [lo, hi]
  return bound(e, Math.min(e.stub, MIN_STUB))
}

function runsOf(
  routes: readonly ElbowRoute[],
  cables: readonly ElbowCable[],
  h: boolean
): Run[] {
  const out: Run[] = []
  routes.forEach((r, i) => {
    const p = r.pts
    const n = p.length
    for (let k = 0; k < n - 1; k++) {
      const a = p[k]
      const b = p[k + 1]
      const horiz = Math.abs(a.y - b.y) < 1e-6
      const vert = Math.abs(a.x - b.x) < 1e-6
      if (horiz === vert || horiz !== h) continue
      const c = h ? a.y : a.x
      const sa = h ? a.x : a.y
      const sb = h ? b.x : b.y
      const cross = (q: Pt | undefined, from: Pt) => {
        if (!q) return 0
        const d = h ? q.y - from.y : q.x - from.x
        return Math.abs(d) < 1e-6 ? 0 : Math.sign(d)
      }
      const da = cross(p[k - 1], a)
      const db = cross(p[k + 2], b)
      const terminal = k === 0 || k === n - 2
      // A run beside an end keeps that end's stub - or, turning off a
      // shared point, its stagger depth.
      const ends: [PlanEnd, number | undefined][] = []
      if (k === 1) ends.push([cables[i].a, r.pinA])
      if (k === n - 3) ends.push([cables[i].b, r.pinB])
      let [lo, hi, lo2, hi2] = [-Infinity, Infinity, -Infinity, Infinity]
      for (const [e, pin] of ends) {
        const [l1, h1] = pin !== undefined ? bound(e, pin) : boundAt(e, c)
        const [l2, h2] =
          pin !== undefined
            ? bound(e, pin)
            : bound(e, Math.min(e.stub, MIN_STUB))
        lo = Math.max(lo, l1)
        hi = Math.min(hi, h1)
        lo2 = Math.max(lo2, l2)
        hi2 = Math.min(hi2, h2)
      }
      // A route's parallel corridors keep their order: they may meet (the
      // step between them goes), never cross into an S.
      for (const j of [k - 2, k + 2]) {
        if (j < 1 || j > n - 3) continue
        const other = h ? p[j].y : p[j].x
        if (other > c) {
          hi = Math.min(hi, other)
          hi2 = Math.min(hi2, other)
        } else if (other < c) {
          lo = Math.max(lo, other)
          lo2 = Math.max(lo2, other)
        }
      }
      // A cramped route already breaks its bounds: it may stay put.
      lo = Math.min(lo, c)
      hi = Math.max(hi, c)
      lo2 = Math.min(lo2, c)
      hi2 = Math.max(hi2, c)
      out.push({
        route: i,
        k,
        h,
        c,
        lo,
        hi,
        lo2,
        hi2,
        pinned: terminal,
        s0: Math.min(sa, sb),
        s1: Math.max(sa, sb),
        d0: sa <= sb ? da : db,
        d1: sa <= sb ? db : da,
      })
    }
  })
  return out
}

const overlap = (a: Run, b: Run) =>
  Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > 1

/** Must `s` lie beyond `t` (+1), before it (-1), or either (0)? A run
 * whose route turns off inside the other's span goes on the side it turns
 * to, or the turn would cross the other. */
function vote(s: Run, t: Run): number {
  let v = 0
  const inside = (x: number, r: Run) => x > r.s0 + 1 && x < r.s1 - 1
  if (inside(s.s0, t)) v += s.d0
  if (inside(s.s1, t)) v += s.d1
  if (inside(t.s0, s)) v -= t.d0
  if (inside(t.s1, s)) v -= t.d1
  return v
}

/** Would moving a run to `c` keep its route clear of the cards? The run
 * and the runs either side of it (they stretch to meet it). */
type Fits = (r: Run, c: number) => boolean

function fitter(
  routes: readonly ElbowRoute[],
  cables: readonly ElbowCable[],
  o?: Obstacles
): Fits {
  if (!o) return () => true
  return (r, c) => {
    const p = routes[r.route].pts
    const n = p.length
    const at = (j: number): Pt =>
      j === r.k || j === r.k + 1
        ? r.h
          ? { x: p[j].x, y: c }
          : { x: c, y: p[j].y }
        : p[j]
    const own = [cables[r.route].a.node, cables[r.route].b.node]
    for (let i = Math.max(0, r.k - 1); i <= Math.min(n - 2, r.k + 1); i++)
      if (!segClear(o, at(i), at(i + 1), own, i === 0 || i === n - 2))
        return false
    return true
  }
}

function setRun(routes: ElbowRoute[], r: Run, c: number) {
  const p = routes[r.route].pts
  if (r.h) {
    p[r.k].y = c
    p[r.k + 1].y = c
  } else {
    p[r.k].x = c
    p[r.k + 1].x = c
  }
}

function spread(
  routes: ElbowRoute[],
  free: Run[],
  fits: Fits,
  before: (a: Run, b: Run) => boolean = () => false
) {
  // Along the corridor: head-on corners in their order first, then runs
  // that would cross, then where each lies now. Kahn's order, counting
  // what each run still waits on.
  const n0 = free.length
  const idx = new Map(free.map((r, i) => [r, i]))
  const hardOut: number[][] = free.map(() => [])
  const softOut: number[][] = free.map(() => [])
  const hardIn = new Array<number>(n0).fill(0)
  const softIn = new Array<number>(n0).fill(0)
  // One route's own parallel runs keep their order too.
  const first = (x: Run, y: Run) =>
    before(x, y) ||
    (x.route === y.route && (x.c < y.c || (x.c === y.c && x.k < y.k)))
  for (const x of free)
    for (const y of free) {
      if (x === y) continue
      const [i, j] = [idx.get(x)!, idx.get(y)!]
      if (first(x, y)) {
        hardOut[i].push(j)
        hardIn[j]++
      } else if (vote(x, y) < 0 && !first(y, x)) {
        softOut[i].push(j)
        softIn[j]++
      }
    }
  const order: Run[] = []
  const done = new Array<boolean>(n0).fill(false)
  const byPlace = (a: number, b: number) =>
    free[a].c - free[b].c ||
    free[a].route - free[b].route ||
    free[a].k - free[b].k
  for (let step = 0; step < n0; step++) {
    // Free of both, else of the head-on order at least, else anything
    // (a cycle): the one that lies first.
    let pick = -1
    for (const pass of [0, 1, 2]) {
      for (let i = 0; i < n0; i++) {
        if (done[i]) continue
        if (pass < 2 && hardIn[i] > 0) continue
        if (pass < 1 && softIn[i] > 0) continue
        if (pick < 0 || byPlace(i, pick) < 0) pick = i
      }
      if (pick >= 0) break
    }
    order.push(free[pick])
    done[pick] = true
    for (const j of hardOut[pick]) hardIn[j]--
    for (const j of softOut[pick]) softIn[j]--
  }
  const n = order.length
  const centre = order.reduce((s, r) => s + r.c, 0) / n
  // A full lane each and the port names' room; a full lane each before
  // that room (a name with none is left off - cables close together are
  // misread); only then closer lanes.
  const tries: [boolean, number][] = [
    [false, LANE],
    [true, LANE],
  ]
  for (let pitch = LANE - 2; pitch >= 4; pitch -= 2)
    tries.push([false, pitch], [true, pitch])
  for (const [least, pitch] of tries) {
    let lo = -Infinity
    let hi = Infinity
    order.forEach((r, i) => {
      lo = Math.max(lo, (least ? r.lo2 : r.lo) - i * pitch)
      hi = Math.min(hi, (least ? r.hi2 : r.hi) - i * pitch)
    })
    if (lo > hi) continue
    // The spread nearest centred that keeps every run clear of cards.
    const want = Math.min(hi, Math.max(lo, centre - ((n - 1) / 2) * pitch))
    const clear = (base: number) =>
      order.every((r, i) => fits(r, base + i * pitch))
    for (let k = 0; k <= 2 * STEPS; k++) {
      const base = want + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * (LANE / 3)
      if (base < lo || base > hi || !clear(base)) continue
      order.forEach((r, i) => setRun(routes, r, base + i * pitch))
      return
    }
  }
  // No clear spread: each run where it best fits - its own lane when clear
  // of the cards, else where it was.
  const base = centre - ((n - 1) / 2) * LANE
  order.forEach((r, i) => {
    const c = Math.min(r.hi2, Math.max(r.lo2, base + i * LANE))
    if (fits(r, c)) setRun(routes, r, c)
  })
}

/** Free runs round the pinned ones: each takes the nearest coordinate a
 * lane clear of every run it overlaps. */
function around(routes: ElbowRoute[], free: Run[], fixed: Run[], fits: Fits) {
  // What is placed, filed by lane-wide bands of its coordinate.
  const placed = new Map<number, { r: Run; c: number }[]>()
  const place = (r: Run, c: number) => {
    const b = Math.floor(c / LANE)
    const list = placed.get(b)
    if (list) list.push({ r, c })
    else placed.set(b, [{ r, c }])
  }
  for (const r of fixed) place(r, r.c)
  for (const r of [...free].sort((x, y) => x.c - y.c || x.route - y.route)) {
    const taken = (c: number) => {
      const b = Math.floor(c / LANE)
      for (const k of [b - 1, b, b + 1])
        for (const p of placed.get(k) ?? [])
          if (Math.abs(p.c - c) < LANE - 0.5 && overlap(p.r, r)) return true
      return false
    }
    let best = r.c
    search: for (const [lo, hi] of [
      [r.lo, r.hi],
      [r.lo2, r.hi2],
    ])
      for (let k = 0; k <= STEPS; k++) {
        const cs = k ? [r.c + k * LANE, r.c - k * LANE] : [r.c]
        const hit = cs.find(
          (c) => c >= lo && c <= hi && !taken(c) && fits(r, c)
        )
        if (hit !== undefined) {
          best = hit
          break search
        }
      }
    setRun(routes, r, best)
    place(r, best)
  }
}

/** Does any run of route `i` lie within a lane of another route's
 * overlapping run? */
function crowds(
  routes: readonly ElbowRoute[],
  cables: readonly ElbowCable[],
  i: number
): boolean {
  // End runs into one shared point run together there by design.
  const sharedAt = (r: Run) =>
    r.k === 0
      ? cables[r.route].a.shared
      : r.k === routes[r.route].pts.length - 2
        ? cables[r.route].b.shared
        : undefined
  for (const h of [true, false]) {
    const runs = runsOf(routes, cables, h)
    for (const r of runs) {
      if (r.route !== i) continue
      const at = sharedAt(r)
      for (const q of runs)
        if (
          q.route !== i &&
          Math.abs(q.c - r.c) < LANE - 0.5 &&
          overlap(q, r) &&
          !(at && sharedAt(q) === at)
        )
          return true
    }
  }
  return false
}

/**
 * End runs of different cables on one line (closer than a lane) whose
 * ports face each other: the route out of the port that comes first along
 * the line must turn before the other turns, or the two run over each
 * other. The corners (the runs after those end runs, `${route}:${k}`) in
 * the order they must lie along the end runs' axis.
 */
function facingCorners(
  routes: readonly ElbowRoute[],
  cables: readonly ElbowCable[],
  h: boolean
): [string, string][] {
  interface HeadEnd {
    r: Run
    at: number
    turn: number
    key: string
    shared: string[]
  }
  // End runs by the way they head from their port: up the line or down.
  const up: HeadEnd[] = []
  const down: HeadEnd[] = []
  for (const r of runsOf(routes, cables, h)) {
    const p = routes[r.route].pts
    const n = p.length
    if (n < 4 || (r.k !== 0 && r.k !== n - 2)) continue
    const nub = r.k === 0 ? p[0] : p[n - 1]
    const corner = r.k === 0 ? p[1] : p[n - 2]
    const at = h ? nub.x : nub.y
    const turn = h ? corner.x : corner.y
    if (turn === at) continue
    const c = cables[r.route]
    const e = {
      r,
      at,
      turn,
      key: `${r.route}:${r.k === 0 ? 1 : n - 3}`,
      shared: [c.a.shared, c.b.shared].filter((k): k is string => !!k),
    }
    ;(turn > at ? up : down).push(e)
  }
  down.sort((x, y) => x.r.c - y.r.c)
  const out: [string, string][] = []
  for (const lo of up) {
    // The runs heading back down the same line, within a lane of it.
    let a = 0
    let b = down.length
    while (a < b) {
      const m = (a + b) >> 1
      if (down[m].r.c <= lo.r.c - (LANE - 0.5)) a = m + 1
      else b = m
    }
    for (let j = a; j < down.length; j++) {
      const hi = down[j]
      if (hi.r.c >= lo.r.c + LANE - 0.5) break
      if (hi.r.route === lo.r.route || hi.at <= lo.at) continue
      // Cables out of one shared point part there by their stagger.
      if (lo.shared.some((k) => hi.shared.includes(k))) continue
      // Head on - the lower port's run goes up the line, the higher
      // one's comes down it - and they meet (or all but).
      if (lo.turn > hi.turn - LANE) out.push([lo.key, hi.key])
    }
  }
  return out
}

/** The corner run next to an end run, when it can move. */
function cornerOf(
  routes: readonly ElbowRoute[],
  cables: readonly ElbowCable[],
  end: Run
): Run | undefined {
  const n = routes[end.route].pts.length
  if (n < 4) return undefined
  const k = end.k === 0 ? 1 : n - 3
  const r = runsOf(routes, cables, !end.h).find(
    (q) => q.route === end.route && q.k === k
  )
  return r && r.k !== 0 && r.k !== n - 2 ? r : undefined
}

/**
 * Two end runs on one line from ports facing each other (level cards,
 * ports at the same place along them): the two routes turn in each
 * other's way. Trading their corridors - each takes the other's lane -
 * puts the turn nearer each port first. True when that parted them.
 */
function swapCorners(
  routes: ElbowRoute[],
  cables: readonly ElbowCable[],
  fits: Fits,
  x: Run,
  y: Run
): boolean {
  const cx = cornerOf(routes, cables, x)
  const cy = cornerOf(routes, cables, y)
  if (!cx || !cy || Math.abs(cx.c - cy.c) < 1e-6) return false
  const [a, b] = [cx.c, cy.c]
  if (b < cx.lo2 || b > cx.hi2 || a < cy.lo2 || a > cy.hi2) return false
  if (!fits(cx, b) || !fits(cy, a)) return false
  setRun(routes, cx, b)
  setRun(routes, cy, a)
  const ends = runsOf(routes, cables, x.h)
  const ex = ends.find((r) => r.route === x.route && r.k === x.k)
  const ey = ends.find((r) => r.route === y.route && r.k === y.k)
  if (
    ex &&
    ey &&
    !overlap(ex, ey) &&
    !crowds(routes, cables, x.route) &&
    !crowds(routes, cables, y.route)
  )
    return true
  setRun(routes, cx, a)
  setRun(routes, cy, b)
  return false
}

/**
 * Two cables' end runs on one line, overlapping - two cards level with
 * each other, their ports at the same height. Neither end run can move
 * (they start on their ports), so the corner where one of them starts is
 * moved past the other's end instead, a lane clear.
 */
function untangleEnds(
  routes: ElbowRoute[],
  cables: readonly ElbowCable[],
  fits: Fits
): void {
  // End runs on ports only: those out of a shared point part by their
  // stagger.
  for (const h of [true, false]) {
    const runs = runsOf(routes, cables, h)
      .filter((r) =>
        r.k === 0
          ? !cables[r.route].a.shared
          : r.k === routes[r.route].pts.length - 2 && !cables[r.route].b.shared
      )
      .sort((x, y) => x.c - y.c)
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[j].c - runs[i].c >= 1) break
        if (runs[i].route === runs[j].route || !overlap(runs[i], runs[j]))
          continue
        if (swapCorners(routes, cables, fits, runs[i], runs[j])) continue
        for (const [t, other] of [
          [runs[i], runs[j]],
          [runs[j], runs[i]],
        ]) {
          const p = routes[t.route].pts
          const n = p.length
          if (n < 4) continue
          const outer = t.k === 0 ? p[0] : p[n - 1]
          const at = h ? outer.x : outer.y
          const target =
            at > other.s1
              ? other.s1 + LANE
              : at < other.s0
                ? other.s0 - LANE
                : NaN
          if (Number.isNaN(target)) continue
          const adjK = t.k === 0 ? 1 : n - 3
          const adj = runsOf(routes, cables, !h).find(
            (r) => r.route === t.route && r.k === adjK
          )
          if (!adj || adj.k === 0 || adj.k === n - 2) continue
          if ((target - at) * (adj.c - at) <= 0) continue
          if (target < adj.lo2 || target > adj.hi2 || !fits(adj, target))
            continue
          // Only a move that does not put the route on another's run.
          const was = adj.c
          setRun(routes, adj, target)
          if (!crowds(routes, cables, t.route)) break
          setRun(routes, adj, was)
        }
      }
  }
}

/** Spread every corridor's runs into lanes, in place, keeping each route
 * clear of the cards (`o`) where it was.
 *
 * A corridor is the runs of different cables closer than a lane that
 * overlap, and those it reaches that way. Its membership only grows: a
 * spread that closed a corridor up to fit it in must not break it into
 * pieces that then spread into each other. */
export function assignLanes(
  routes: ElbowRoute[],
  cables: readonly ElbowCable[],
  o?: Obstacles
): void {
  const fits = fitter(routes, cables, o)
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k) ?? k
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const keyOf = (r: Run) => `${r.h ? "h" : "v"}${r.route}:${r.k}`
  const heads = new Map<boolean, Set<string>>([
    [true, new Set()],
    [false, new Set()],
  ])
  for (let round = 0; round < 3; round++)
    for (const h of [true, false]) {
      const runs = runsOf(routes, cables, h).sort((x, y) => x.c - y.c)
      for (let i = 0; i < runs.length; i++)
        for (let j = i + 1; j < runs.length; j++) {
          if (runs[j].c - runs[i].c >= LANE - 0.5) break
          if (runs[i].route === runs[j].route) continue
          // End runs never move: two of them need no corridor together.
          if (runs[i].pinned && runs[j].pinned) continue
          if (!overlap(runs[i], runs[j])) continue
          union(keyOf(runs[i]), keyOf(runs[j]))
        }
      // Corners whose end runs meet head on keep their order: the one
      // whose port lies first turns first. Once found, an order stays.
      const first = heads.get(h)!
      for (const [a, b] of facingCorners(routes, cables, !h))
        if (!first.has(`${b}|${a}`)) first.add(`${a}|${b}`)
      for (const ab of first) {
        const [a, b] = ab.split("|")
        union(`${h ? "h" : "v"}${a}`, `${h ? "h" : "v"}${b}`)
      }
      const before = (x: Run, y: Run) =>
        first.size > 0 && first.has(`${x.route}:${x.k}|${y.route}:${y.k}`)
      const clusters = new Map<string, Run[]>()
      for (const r of runs) {
        const k = find(keyOf(r))
        const list = clusters.get(k)
        if (list) list.push(r)
        else clusters.set(k, [r])
      }
      for (const list of clusters.values()) {
        if (list.length < 2) continue
        const free = list.filter((r) => !r.pinned)
        if (!free.length) continue
        const fixed = list.filter((r) => r.pinned)
        if (fixed.length) around(routes, free, fixed, fits)
        else if (free.length > 1) spread(routes, free, fits, before)
      }
    }
  untangleEnds(routes, cables, fits)
  straighten(routes, cables, fits)
  for (const r of routes) r.pts = simplify(r.pts)
}

/** A step of less than `SNAP` px between two runs of a route (two lanes
 * that happened to land almost level) drawn as one straight run. */
function straighten(
  routes: ElbowRoute[],
  cables: readonly ElbowCable[],
  fits: Fits
): void {
  routes.forEach((route, i) => {
    const p = route.pts
    for (let k = 1; k < p.length - 2; k++) {
      const a = p[k]
      const b = p[k + 1]
      const step = Math.hypot(b.x - a.x, b.y - a.y)
      if (step === 0 || step >= SNAP) continue
      const h = Math.abs(p[k - 1].y - a.y) < 1e-6
      // The run after the step moves onto the run before it - unless it
      // is the end run (it starts on its port); then the one before moves.
      const later = k + 1 < p.length - 2
      const move = runsOf(routes, cables, h).find(
        (r) => r.route === i && r.k === (later ? k + 1 : k - 1)
      )
      const to = later ? (h ? a.y : a.x) : h ? b.y : b.x
      if (!move || move.pinned || to < move.lo2 || to > move.hi2) continue
      if (!fits(move, to)) continue
      const was = move.c
      setRun(routes, move, to)
      if (crowds(routes, cables, i)) setRun(routes, move, was)
    }
  })
}

/** Repeated points and straight-through corners dropped. */
export function simplify(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out.at(-1)
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6)
      continue
    const prev = out.at(-2)
    if (last && prev) {
      const ax = last.x - prev.x
      const ay = last.y - prev.y
      const bx = p.x - last.x
      const by = p.y - last.y
      if (Math.abs(ax * by - ay * bx) < 1e-6 && ax * bx + ay * by > 0) out.pop()
    }
    out.push({ x: p.x, y: p.y })
  }
  return out
}
