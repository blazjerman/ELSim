# ngspice WebAssembly spike

The browser engine uses ngspice as its numerical core. The checked-in source pin is in [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT); this directory contains original ELSim regression decks and the build/test entry points.

## Reproduce the local build

Use Emscripten 5.0.7, Python 3, GNU make, and a clean checkout of the pinned ngspice source. Set `NGSPICE_SOURCE` to that checkout and run:

```sh
NGSPICE_SOURCE=/path/to/ngspice JOBS=2 ./tools/build-ngspice-wasm.sh
node tools/test-ngspice-wasm.mjs
```

The build copies the ignored WASM runtime into `public/engine/` for the local browser worker. The browser supports transient analysis with plotted real-valued vectors, DC operating point with a one-sample value table, DC source sweeps plotted against the swept source value, and AC sweeps with complex vectors rendered as magnitude in dB or phase in degrees on a logarithmic frequency axis. AC CSV preserves real and imaginary values. The Node test starts one ngspice instance per fixture and checks transient, diode operating-point, AC, `.SUBCKT`, and operating-point, AC, and DC sweep raw vectors. Pass a native ngspice executable as the third argument to compare printed numeric rows:

```sh
node tools/test-ngspice-wasm.mjs public/engine /path/to/native/ngspice
```

The link uses a 2 MiB WASM stack. A checked build showed that ngspice's `inp_fix_inst_calls_for_numparam` routine reserves four 10,000-entry local arrays, which do not fit Emscripten's 64 KiB default stack. The configure step enables XSPICE, skips its optional Verilog/VHDL adapters, and excludes the `table` ICM because its upstream license is GPL-2.0-or-later. Other XSPICE analog modules are compiled. The browser worker runs one transient analysis per worker; Stop terminates that worker. Firefox passes the 17 ngspice-backed workflows locally. Cancellation is covered by the long-run browser test; broader performance measurements still need verification.

The current outputs are generated locally and are ignored by Git. The build script writes the runtime, pinned source tree's `COPYING`, third-party notices, a source archive from the exact pinned commit, compiled object/archive files for relinking, build-info, an Emscripten link map, a generated linked-object-to-source-path candidate inventory, and SHA-256 checksums into `public/engine/`. Candidate source paths are inferred from build paths and still need manual verification against the pinned source and per-directory license files; every entry is labeled as requiring review, and the inventory is not a legal determination. The object archive is supplied as relinking material, but the exact license obligations and adequacy of those materials still require qualified review. The build fails if Emscripten does not emit a non-empty map or any compiled object/archive files. GitHub Pages now checks out the pinned ngspice source, builds the WASM, and uses `npm run build:release` to package it under `/ELSim/` together with license/source materials; a Pages bundle checker confirms the engine, notices, CSP, worker URLs, and service-worker precache are present. The release review gate still blocks deployment until a qualified reviewer approves the exact generated artifacts and obligations. A passing repository gate is evidence of recorded review, not legal advice or an automated license determination.
