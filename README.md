# ELSim

An original, browser-based circuit workbench that aims to pair a beginner-friendly schematic editor with ngspice simulation and deeper SPICE model support.

## Current preview

The first UI foundation is under active development. It includes a starter RC schematic, component placement and selection, editable component values, schematic movement, pin-to-pin wire connections, connectivity derived from geometry, local project persistence, v1-to-v2 JSON project migration, and generated SPICE netlist preview. The current v2 structure is described in [the JSON Schema](schemas/project-v2.schema.json).

The ngspice WebAssembly engine is not integrated yet. The Run button reports this directly; the preview does not invent simulation waveforms or animations. See [ROADMAP.md](ROADMAP.md) for the staged implementation plan and engine gate.

## Run the web app

Requires Node.js and npm. From this directory:

```sh
npm install
npm run dev
```

The current project file is a versioned JSON document. Use Save to download a copy, or Open to restore one. A copy is also kept in this browser's local storage.

## Engine and licensing

ELSim uses ngspice as its intended numerical engine, but the WebAssembly build, its precise source revision, and all component licenses must pass the review gates in the roadmap before a simulation binary is distributed. Imported vendor models remain user-provided assets unless redistribution permission is documented.

ELSim does not include CircuitJS/Falstad implementation code or LTspice binaries/libraries. Its UI, symbols, and examples are original project work.
