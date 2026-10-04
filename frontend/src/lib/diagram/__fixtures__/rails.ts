import type { Measure } from "../measure"
import type { RailModel } from "../rails"

// A small L2 domain as the Logical tab and the Virtual topology hand it to
// the rail layout: two sections, rails with and without a color of their
// own, a status on one, a switch's host NICs; a colored device on two rails
// (one of them twice), a tagged trunk, a VM, and a name too long for its
// card.

/** A fixed text measure, so goldens don't depend on fonts. */
export const railMeasure: Measure = (s, size) => s.length * size * 0.6

const active = {
  id: "st-active",
  name: "Active",
  slug: "active",
  color: "#22c55e",
  text_color: "#ffffff",
}
const planned = {
  id: "st-planned",
  name: "Planned",
  slug: "planned",
  color: "#f59e0b",
  text_color: "#000000",
}

export const railModel: RailModel = {
  external: "External network",
  sections: [
    {
      id: "g-campus",
      title: "Campus",
      subtitle: "VLAN group",
      target: { kind: "vswitch", id: "sw-1" },
      adapters: [
        {
          key: "a1",
          nic: "eno1",
          host: "hv-01",
          target: { kind: "interface", id: "if-a1" },
        },
      ],
      rails: [
        {
          id: "v10",
          label: "MGMT · VLAN 10",
          color: "#2563eb",
          status: planned,
          target: { kind: "vlan", id: "v10" },
        },
        {
          id: "v20",
          label: "SERVERS · VLAN 20",
          color: "#fde68a",
          target: { kind: "vlan", id: "v20" },
        },
      ],
    },
    {
      id: "ungrouped",
      title: "VLANs",
      rails: [
        {
          id: "v99",
          label: "LEGACY · VLAN 99",
          target: { kind: "vlan", id: "v99" },
        },
      ],
    },
  ],
  boxes: [
    {
      id: "device:d1",
      name: "core-01",
      role: { name: "Core", color: "#7c3aed" },
      status: active,
      target: { kind: "device", id: "d1" },
      legs: [
        {
          rail: "v10",
          label: "mgmt0",
          target: { kind: "interface", id: "i1" },
        },
        {
          rail: "v10",
          label: "Eth1/1",
          dashed: true,
          target: { kind: "interface", id: "i2" },
        },
        {
          rail: "v20",
          label: "Eth1/1",
          dashed: true,
          target: { kind: "interface", id: "i2" },
        },
        { rail: "v99", label: "Eth1/2", dashed: true },
      ],
    },
    {
      id: "vm:v1",
      name: "web-01",
      vm: true,
      target: { kind: "vm", id: "v1" },
      legs: [{ rail: "v20", label: "net0" }],
    },
    {
      id: "device:d2",
      name: "a-very-long-access-switch-name",
      role: { name: "Access" },
      target: { kind: "device", id: "d2" },
      legs: [
        { rail: "v20", label: "GigabitEthernet1/0/1" },
        // A rail not on the diagram: dropped.
        { rail: "gone", label: "Gi1/0/9" },
      ],
    },
    // Nothing on the diagram: not drawn.
    { id: "device:d3", name: "orphan", legs: [{ rail: "gone" }] },
  ],
}
