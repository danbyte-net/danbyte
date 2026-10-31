declare module "occt-import-js" {
  interface OcctMesh {
    name: string
    color?: [number, number, number]
    brep_faces?: {
      first: number
      last: number
      color: [number, number, number] | null
    }[]
    attributes: {
      position: { array: number[] }
      normal?: { array: number[] }
    }
    index: { array: number[] }
  }
  interface OcctReadResult {
    success: boolean
    meshes: OcctMesh[]
  }
  interface Occt {
    ReadStepFile: (content: Uint8Array, params: object | null) => OcctReadResult
    ReadIgesFile: (content: Uint8Array, params: object | null) => OcctReadResult
    ReadBrepFile: (content: Uint8Array, params: object | null) => OcctReadResult
  }
  export default function occtimportjs(overrides?: {
    wasmBinary?: ArrayBuffer
    locateFile?: (path: string) => string
  }): Promise<Occt>
}

declare module "three/examples/jsm/libs/meshopt_simplifier.module.js" {
  export const MeshoptSimplifier: {
    ready: Promise<void>
    simplify: (
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      targetIndexCount: number,
      targetError: number,
      flags?: string[]
    ) => [Uint32Array, number]
    simplifySloppy: (
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      lock: Uint8Array | null,
      targetIndexCount: number,
      targetError: number
    ) => [Uint32Array, number]
  }
}
