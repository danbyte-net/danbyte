import type { TopologyGraph } from "@/lib/api"

// The "Århus DC wiring" map from the dev site, cut down to what the
// Diagram draws: eight cards, eleven cables - among them the breakout
// cable TEST (aarhus-fw1:ethernet1/4 to two ports on aarhus-asw1) and the
// three firewall cables whose elbows used to share one corridor - and the
// saved view's card centres and Levels order.

export const aarhusGraph: TopologyGraph = {
  nodes: [
    {
      id: "dev:2692af31-41ae-49b6-a828-15feb1d11376",
      type: "device",
      data: {
        device_id: "2692af31-41ae-49b6-a828-15feb1d11376",
        name: "aarhus-srv2",
        role: {
          name: "Server",
          color: "#10b981",
        },
        primary_ip: "10.10.0.20",
      },
    },
    {
      id: "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
      type: "device",
      data: {
        device_id: "50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
        name: "aarhus-fw1",
        role: {
          name: "Firewall",
          color: "#f59e0b",
        },
        primary_ip: "10.0.0.1",
      },
    },
    {
      id: "dev:523bfe74-7529-4623-988e-c3599dc40e41",
      type: "device",
      data: {
        device_id: "523bfe74-7529-4623-988e-c3599dc40e41",
        name: "aarhus-sw1",
        role: {
          name: "Access",
          color: "#2563eb",
        },
      },
    },
    {
      id: "dev:6d8ad2b4-4c3e-4240-b184-dcc9eab69e5a",
      type: "device",
      data: {
        device_id: "6d8ad2b4-4c3e-4240-b184-dcc9eab69e5a",
        name: "aarhus-sw2",
        role: {
          name: "Access",
          color: "#2563eb",
        },
      },
    },
    {
      id: "dev:8d63e2cb-7feb-4370-a504-37a38d428570",
      type: "device",
      data: {
        device_id: "8d63e2cb-7feb-4370-a504-37a38d428570",
        name: "aarhus-asw1",
        role: {
          name: "Access",
          color: "#2563eb",
        },
        primary_ip: "10.0.0.203",
      },
    },
    {
      id: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      type: "device",
      data: {
        device_id: "a2841404-9095-402e-a91f-87b151de77bc",
        name: "aarhus-core1",
        role: {
          name: "Core",
          color: "#e11d48",
        },
        primary_ip: "10.0.0.13",
      },
    },
    {
      id: "dev:f3529670-f4a2-4c0a-a7b8-0ee4dd4e30c4",
      type: "device",
      data: {
        device_id: "f3529670-f4a2-4c0a-a7b8-0ee4dd4e30c4",
        name: "aarhus-srv1",
        role: {
          name: "Server",
          color: "#10b981",
        },
        primary_ip: "10.0.0.42",
      },
    },
    {
      id: "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      type: "device",
      data: {
        device_id: "fb90d590-1fd5-4212-975f-42ca600f7b1a",
        name: "aarhus-core2",
        role: {
          name: "Core",
          color: "#e11d48",
        },
        primary_ip: "10.0.0.201",
      },
    },
  ],
  edges: [
    {
      id: "e:c584f188-cf80-4b13-aa8f-e04c4ae26589:6d8ad2b4-4c3e-4240-b184-dcc9eab69e5a:a2841404-9095-402e-a91f-87b151de77bc",
      source: "dev:6d8ad2b4-4c3e-4240-b184-dcc9eab69e5a",
      target: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      type: "cable",
      data: {
        cable_id: "c584f188-cf80-4b13-aa8f-e04c4ae26589",
        cable_type: "",
        cable_label: "",
        color: "",
        status: "connected",
        pairs: [
          {
            a: "aarhus-sw2:Te2/1/1",
            b: "aarhus-core1:Ethernet1/11",
            a_port: "Te2/1/1",
            b_port: "Ethernet1/11",
            a_id: "eecbb671-b035-41bb-b374-5c8dfdb408f1",
            a_kind: "interface",
            b_id: "2984c62c-6909-447d-81ca-d8c43cba30ec",
            b_kind: "interface",
          },
        ],
        lag: {
          a: {
            id: "025de7d1-c417-424d-bfb0-392451661bdb",
            name: "Po1",
          },
          b: {
            id: "46a42382-835f-410b-a99e-bb0959d913e0",
            name: "port-channel10",
          },
        },
      },
    },
    {
      id: "e:1ee30b27-b201-4832-8589-71e58b8feb8e:523bfe74-7529-4623-988e-c3599dc40e41:a2841404-9095-402e-a91f-87b151de77bc",
      source: "dev:523bfe74-7529-4623-988e-c3599dc40e41",
      target: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      type: "cable",
      data: {
        cable_id: "1ee30b27-b201-4832-8589-71e58b8feb8e",
        cable_type: "mmf-om4",
        cable_label: "AARHUS-STK-UP1",
        color: "",
        status: "connected",
        pairs: [
          {
            a: "aarhus-sw1:Te1/1/1",
            b: "aarhus-core1:Ethernet1/10",
            a_port: "Te1/1/1",
            b_port: "Ethernet1/10",
            a_id: "f68b05e5-46d8-4434-b5f7-f9d71341d8f5",
            a_kind: "interface",
            b_id: "92ec9837-2a25-4a79-a19b-16064a277bec",
            b_kind: "interface",
          },
        ],
        lag: {
          a: {
            id: "025de7d1-c417-424d-bfb0-392451661bdb",
            name: "Po1",
          },
          b: {
            id: "46a42382-835f-410b-a99e-bb0959d913e0",
            name: "port-channel10",
          },
        },
      },
    },
    {
      id: "e:2da1b108-1aab-4c85-a812-e2b5e5b9fbc2:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76:8d63e2cb-7feb-4370-a504-37a38d428570",
      source: "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
      target: "dev:8d63e2cb-7feb-4370-a504-37a38d428570",
      type: "cable",
      data: {
        cable_id: "2da1b108-1aab-4c85-a812-e2b5e5b9fbc2",
        cable_type: "cat5e",
        cable_label: "TEST",
        color: "#f43f5e",
        status: "connected",
        pairs: [
          {
            a: "aarhus-fw1:ethernet1/4",
            b: "aarhus-asw1:Gi1/0/3",
            a_port: "ethernet1/4",
            b_port: "Gi1/0/3",
            a_id: "c0e2a407-e3d3-453d-9d2a-ce06bbeb0bab",
            a_kind: "interface",
            b_id: "0ecf552b-8bfd-4ddb-bc1c-381eb4d8a7b0",
            b_kind: "interface",
          },
          {
            a: "aarhus-fw1:ethernet1/4",
            b: "aarhus-asw1:Gi1/0/4",
            a_port: "ethernet1/4",
            b_port: "Gi1/0/4",
            a_id: "c0e2a407-e3d3-453d-9d2a-ce06bbeb0bab",
            a_kind: "interface",
            b_id: "62ac34f3-015e-485f-a4b3-5d20340e7470",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:b35b10a2-ddbc-49d7-b9f4-2a43194626ba:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      source: "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
      target: "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      type: "cable",
      data: {
        cable_id: "b35b10a2-ddbc-49d7-b9f4-2a43194626ba",
        cable_type: "",
        cable_label: "",
        color: "",
        status: "connected",
        pairs: [
          {
            a: "aarhus-fw1:ethernet1/7",
            b: "aarhus-core2:Ethernet1/11",
            a_port: "ethernet1/7",
            b_port: "Ethernet1/11",
            a_id: "af70e982-6ecc-4817-9455-059edcde7390",
            a_kind: "interface",
            b_id: "409c4f6c-49f9-431b-8ffd-e0423ba94d7d",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:9b822d97-8f23-43fd-9c42-6a2b5d938ebf:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      source: "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
      target: "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      type: "cable",
      data: {
        cable_id: "9b822d97-8f23-43fd-9c42-6a2b5d938ebf",
        cable_type: "",
        cable_label: "",
        color: "",
        status: "connected",
        pairs: [
          {
            a: "aarhus-fw1:ethernet1/6",
            b: "aarhus-core2:Ethernet1/13",
            a_port: "ethernet1/6",
            b_port: "Ethernet1/13",
            a_id: "27e0cff1-223b-4b9b-8129-b533eab23853",
            a_kind: "interface",
            b_id: "4213fa55-38f8-45d7-b931-9aa0935ffbb7",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:334d32eb-72b0-42fb-9ded-6d4530f8fb3a:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76:a2841404-9095-402e-a91f-87b151de77bc",
      source: "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76",
      target: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      type: "cable",
      data: {
        cable_id: "334d32eb-72b0-42fb-9ded-6d4530f8fb3a",
        cable_type: "mmf-om4",
        cable_label: "AARHUS-FW",
        color: "",
        status: "active",
        pairs: [
          {
            a: "aarhus-fw1:ethernet1/1",
            b: "aarhus-core1:Ethernet1/2",
            a_port: "ethernet1/1",
            b_port: "Ethernet1/2",
            a_id: "58a60f44-615c-4598-8345-1db2d0d70376",
            a_kind: "interface",
            b_id: "be350e9b-be48-4512-876a-c215500d5a8c",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:82428cc8-e4af-4624-a90c-8b75b4ef85c3:2692af31-41ae-49b6-a828-15feb1d11376:8d63e2cb-7feb-4370-a504-37a38d428570",
      source: "dev:2692af31-41ae-49b6-a828-15feb1d11376",
      target: "dev:8d63e2cb-7feb-4370-a504-37a38d428570",
      type: "cable",
      data: {
        cable_id: "82428cc8-e4af-4624-a90c-8b75b4ef85c3",
        cable_type: "cat6",
        cable_label: "AARHUS-SRV2",
        color: "",
        status: "active",
        pairs: [
          {
            a: "aarhus-srv2:eno1",
            b: "aarhus-asw1:Gi1/0/2",
            a_port: "eno1",
            b_port: "Gi1/0/2",
            a_id: "bbd7143d-f0cc-44dd-a867-074dc32f52c1",
            a_kind: "interface",
            b_id: "a3fb3750-60de-4c68-8ac0-b3c129ffd426",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:a5565d31-8df0-4310-b58d-875e1b193115:8d63e2cb-7feb-4370-a504-37a38d428570:f3529670-f4a2-4c0a-a7b8-0ee4dd4e30c4",
      source: "dev:8d63e2cb-7feb-4370-a504-37a38d428570",
      target: "dev:f3529670-f4a2-4c0a-a7b8-0ee4dd4e30c4",
      type: "cable",
      data: {
        cable_id: "a5565d31-8df0-4310-b58d-875e1b193115",
        cable_type: "cat6",
        cable_label: "AARHUS-SRV1",
        color: "",
        status: "active",
        pairs: [
          {
            a: "aarhus-asw1:Gi1/0/1",
            b: "aarhus-srv1:eno1",
            a_port: "Gi1/0/1",
            b_port: "eno1",
            a_id: "1443bcdd-48dd-4283-b912-647fa42faeda",
            a_kind: "interface",
            b_id: "ff865996-901a-40aa-b2c1-634c11e137b0",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:a45b56bd-0d38-4637-8a6b-5e1673c142e3:8d63e2cb-7feb-4370-a504-37a38d428570:a2841404-9095-402e-a91f-87b151de77bc",
      source: "dev:8d63e2cb-7feb-4370-a504-37a38d428570",
      target: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      type: "cable",
      data: {
        cable_id: "a45b56bd-0d38-4637-8a6b-5e1673c142e3",
        cable_type: "mmf-om4",
        cable_label: "AARHUS-UP1",
        color: "#f59e0b",
        status: "active",
        pairs: [
          {
            a: "aarhus-asw1:Te1/1/1",
            b: "aarhus-core1:Ethernet1/1",
            a_port: "Te1/1/1",
            b_port: "Ethernet1/1",
            a_id: "d2a8cb45-3cdc-46d6-84de-ea11ab80da58",
            a_kind: "interface",
            b_id: "3b9c9bea-b1b3-4515-99e3-1432e7fc2f10",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:08a38087-73a7-467a-a0f0-c9d2f7edbcd2:a2841404-9095-402e-a91f-87b151de77bc:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      source: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      target: "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      type: "cable",
      data: {
        cable_id: "08a38087-73a7-467a-a0f0-c9d2f7edbcd2",
        cable_type: "dac-passive",
        cable_label: "AARHUS-HA2",
        color: "",
        status: "active",
        pairs: [
          {
            a: "aarhus-core1:Ethernet1/50",
            b: "aarhus-core2:Ethernet1/50",
            a_port: "Ethernet1/50",
            b_port: "Ethernet1/50",
            a_id: "19ea99af-4823-4a49-bf57-a14f26432fe5",
            a_kind: "interface",
            b_id: "cf41d9f4-979d-422f-ba18-afc681d09280",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
    {
      id: "e:6d863348-7c3a-4008-9e8b-06bebac99d81:a2841404-9095-402e-a91f-87b151de77bc:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      source: "dev:a2841404-9095-402e-a91f-87b151de77bc",
      target: "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a",
      type: "cable",
      data: {
        cable_id: "6d863348-7c3a-4008-9e8b-06bebac99d81",
        cable_type: "dac-passive",
        cable_label: "AARHUS-HA1",
        color: "",
        status: "active",
        pairs: [
          {
            a: "aarhus-core1:Ethernet1/49",
            b: "aarhus-core2:Ethernet1/49",
            a_port: "Ethernet1/49",
            b_port: "Ethernet1/49",
            a_id: "671c7082-ecd4-4495-b81d-16530c9f051f",
            a_kind: "interface",
            b_id: "6e76ea0d-a319-4281-b3a6-ccc4e458887c",
            b_kind: "interface",
          },
        ],
        lag: {
          a: null,
          b: null,
        },
      },
    },
  ],
}

/** The saved view's card centres (`positions_by_style.diagram`). */
export const aarhusPositions: Record<string, [number, number]> = {
  "dev:2692af31-41ae-49b6-a828-15feb1d11376": [1578.3, -183.7],
  "dev:50ca7bd9-5677-4dc9-bcf0-5ea08b9e9e76": [54.3, -274.8],
  "dev:523bfe74-7529-4623-988e-c3599dc40e41": [1576.0, -83.2],
  "dev:6d8ad2b4-4c3e-4240-b184-dcc9eab69e5a": [1585.7, 15.5],
  "dev:8d63e2cb-7feb-4370-a504-37a38d428570": [810.9, -275.2],
  "dev:a2841404-9095-402e-a91f-87b151de77bc": [804.9, -37.1],
  "dev:f3529670-f4a2-4c0a-a7b8-0ee4dd4e30c4": [1577.3, -367.9],
  "dev:fb90d590-1fd5-4212-975f-42ca600f7b1a": [789.0, 243.5],
}

/** The saved view's Levels. */
export const aarhusLevels = {
  roleOrder: ["Firewall", "Core", "Access", "Server"],
  roleDistance: { Core: 4 },
}

/** A card's node id by its device name. */
export const aarhusId = (name: string): string =>
  aarhusGraph.nodes.find((n) => n.data.name === name)!.id
