# ELSim

An original, browser-based circuit workbench that aims to pair a beginner-friendly schematic editor with ngspice simulation and deeper SPICE model support.

## Current preview

The preview includes a starter RC schematic, component placement and selection, editable component values, schematic movement, pin-to-pin wire connections, geometry-derived connectivity, local project persistence, v1-to-v2 JSON project migration, and generated SPICE netlist preview. When the local ngspice bundle is built, Run performs transient or DC operating-point analysis in a Web Worker. Transient mode plots actual voltage/current vectors; operating-point mode shows solved node voltages and component currents. Use Probe to add a wire voltage or component current, click transient plots for synchronized values, and export selected results to CSV. Results become visibly stale after circuit edits. The current v2 structure is described in [the JSON Schema](schemas/project-v2.schema.json).

To build the local engine, use Emscripten 5.0.7 and the pinned ngspice source as described in [the WASM build notes](engine/wasm/README.md). AC/DC analysis controls, simulator-driven component animations, LTspice import/export, hierarchy, and model import remain under development. The worker message, diagnostic, run metadata, and netlist source-map contract is documented in [the engine protocol schema](schemas/engine-protocol.schema.json). See [ROADMAP.md](ROADMAP.md) for the staged implementation plan and remaining release gates.

## Run the web app

Requires Node.js and npm. From this directory:

```sh
npm install
npm run dev
```

The current project file is a versioned JSON document. Use Save to download a copy, or Open to restore one. A copy is also kept in this browser's local storage.

## Engine and licensing

ELSim uses ngspice as its numerical engine. The generated bundle is excluded from source control; build it locally with the pinned recipe. Complete the ngspice source and linked-library license audit before publishing a hosted app or distributing generated binaries. Imported vendor models remain user-provided assets unless redistribution permission is documented.

ELSim does not include CircuitJS/Falstad implementation code or LTspice binaries/libraries. Its UI, symbols, and examples are original project work.
