# ELSim

An original, browser-based circuit workbench that aims to pair a beginner-friendly schematic editor with ngspice simulation and deeper SPICE model support.

## Current preview

The preview includes RC, LED, and nested-divider examples; a schematic editor; reusable hierarchical sheets; transient, DC operating-point, DC sweep, and AC analyses; waveform and result-derived component animations; voltage/current probes; and CSV export. Projects save locally in the browser or as `.elsim` archives. A bounded LTspice `.asc`/`.asy` importer reports unsupported syntax, and the loss-aware LTspice exporter previews transformations and can download supported projects as ZIP files. See [ROADMAP.md](ROADMAP.md) and [LTSPICE_COMPATIBILITY.md](LTSPICE_COMPATIBILITY.md) for current limits and unfinished release gates.

The application UI runs in a modern browser without an account. ngspice is an optional local WebAssembly runtime in this source preview: editor, project, and export features remain available when that runtime is absent. When built locally, simulation runs in a Web Worker. Chromium is exercised by CI; Firefox and Safari/WebKit verification and native desktop packaging are still open. The current v7 structure is described in [the JSON Schema](schemas/project-v7.schema.json); older files remain supported through migration.

For local simulation, build the engine with Emscripten 5.0.7 and the pinned ngspice source as described in [the WASM build notes](engine/wasm/README.md); the Vite development server serves that ignored local runtime. Standard `npm run build` deliberately omits ngspice artifacts. `npm run build:release` includes them only after the qualified review record approves the exact engine, notices, linker map, build information, and checksums. The worker message, diagnostic, run metadata, and netlist source-map contract is documented in [the engine protocol schema](schemas/engine-protocol.schema.json). See [ROADMAP.md](ROADMAP.md) for the staged implementation plan and remaining release gates.

## Run the web app

Requires Node.js and npm. From this directory:

```sh
npm install
npm run dev
```

Use Save to download a portable `.elsim` archive, or Open to restore one. Existing `.elsim.json` documents can still be opened. The archive format and safety limits are documented in [PROJECT_FORMAT.md](PROJECT_FORMAT.md). A working copy is also kept in this browser's local storage.

## Tests

Run `npm test` for domain and netlist tests. Run `npm run build` for the standard browser distribution and its check that no ngspice binaries were included. For browser UI regressions without an engine build, install Chromium with `npx playwright install chromium` and run `npm run test:e2e:ui`. The RC and imported-IC simulation smoke tests require the local WASM runtime; build it as described above, then run `npm run test:e2e` to include those two tests as well. GitHub Actions runs unit tests, the standard build, and the engine-independent Chromium UI tests on pushes and pull requests.

## Engine and licensing

ELSim uses ngspice as its numerical engine. The generated bundle is excluded from source control and omitted from standard production builds; local development can still use it. Complete the ngspice source and linked-library license audit before approving `build:release`, publishing a hosted app, or distributing generated binaries. Imported vendor models remain user-provided assets unless redistribution permission is documented.

ELSim does not include CircuitJS/Falstad implementation code or LTspice binaries/libraries. Its UI, symbols, and examples are original project work.
