import { describe, expect, it } from "vitest"

import type { Tag } from "@/lib/api"
import { mergeTargets } from "./tag-merge-dialog"

function tag(id: number, patch: Partial<Tag> = {}): Tag {
  return {
    id,
    name: `t${id}`,
    slug: `t${id}`,
    color: "",
    text_color: "",
    owning_site: null,
    is_global: false,
    ...patch,
  }
}

const GLOBAL = tag(1, { is_global: true })
const GLOBAL2 = tag(2, { is_global: true })
const TENANT = tag(3)
const SITE_A = tag(4, { owning_site: { id: "a", name: "A" } })
const SITE_A2 = tag(5, { owning_site: { id: "a", name: "A" } })
const SITE_B = tag(6, { owning_site: { id: "b", name: "B" } })
const ALL = [GLOBAL, GLOBAL2, TENANT, SITE_A, SITE_A2, SITE_B]
const ids = (ts: Tag[]) => ts.map((t) => t.id)

describe("mergeTargets", () => {
  it("offers a global tag only other global tags", () => {
    expect(ids(mergeTargets(GLOBAL, ALL))).toEqual([2])
  })
  it("offers a tenant tag every tag but another site's local ones", () => {
    expect(ids(mergeTargets(TENANT, ALL))).toEqual([1, 2])
  })
  it("offers a site tag its own site, tenant-wide and global tags", () => {
    expect(ids(mergeTargets(SITE_A, ALL))).toEqual([1, 2, 3, 5])
  })
})
