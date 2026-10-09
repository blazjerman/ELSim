# ELSim

An original, browser-based circuit workbench that aims to pair a beginner-friendly schematic editor with ngspice simulation and deeper SPICE model support.

## Current preview

The preview includes a starter RC schematic, component placement and selection, editable component values, schematic movement, pin-to-pin wire connections, geometry-derived connectivity, local project persistence, v1-to-v2 JSON project migration, and generated SPICE netlist preview. When the local ngspice bundle is built, Run performs transient, DC operating-point, DC source-sweep, or AC frequency-sweep analysis in a Web Worker. Transient mode plots actual voltage/current vectors; operating-point mode shows solved node values; AC mode shows frequency response magnitude and phase; DC sweep plots node voltages and currents against the selected source value. Plot panels provide horizontal zoom, step pan, reset, and cursor readouts. Use Probe to add available wire-voltage or component-current vectors and export selected results to CSV. Results become visibly stale after circuit edits. The current v2 structure is described in [the JSON Schema](schemas/project-v2.schema.json).

To build the local engine, use Emscripten 5.0.7 and the pinned ngspice source as described in [the WASM build notes](engine/wasm/README.md). AC/DC analysis controls, simulator-driven component animations, and user model import are implemented in slices. LTspice import currently supports a limited `.asc`/`.asy` subset with diagnostics; full schematic/model compatibility, export, and hierarchy remain under development. The worker message, diagnostic, run metadata, and netlist source-map contract is documented in [the engine protocol schema](schemas/engine-protocol.schema.json). See [ROADMAP.md](ROADMAP.md) for the staged implementation plan and remaining release gates.

## Run the web app

Requires Node.js and npm. From this directory:

```sh
npm install
npm run dev
```

Use Save to download a portable `.elsim` archive, or Open to restore one. Existing `.elsim.json` documents can still be opened. The archive format and safety limits are documented in [PROJECT_FORMAT.md](PROJECT_FORMAT.md). A working copy is also kept in this browser's local storage.

## Engine and licensing

ELSim uses ngspice as its numerical engine. The generated bundle is excluded from source control; build it locally with the pinned recipe. Complete the ngspice source and linked-library license audit before publishing a hosted app or distributing generated binaries. Imported vendor models remain user-provided assets unless redistribution permission is documented.

ELSim does not include CircuitJS/Falstad implementation code or LTspice binaries/libraries. Its UI, symbols, and examples are original project work.
