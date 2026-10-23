# ngspice WebAssembly spike

The browser engine uses ngspice as its numerical core. The checked-in source pin is in [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT); this directory contains original ELSim regression decks and the build/test entry points.

## Reproduce the local build

Use Emscripten 5.0.7, Python 3, GNU make, and a clean checkout of the pinned ngspice source. Set `NGSPICE_SOURCE` to that checkout and run:

```sh
NGSPICE_SOURCE=/path/to/ngspice JOBS=2 ./tools/build-ngspice-wasm.sh
node tools/test-ngspice-wasm.mjs
```

The build copies the ignored WASM runtime into `public/engine/` for the local browser worker. The browser supports transient analysis with plotted real-valued vectors, DC operating point with a one-sample value table, DC source sweeps plotted against the swept source value, and AC sweeps with complex vectors rendered as magnitude in dB or phase in degrees on a logarithmic frequency axis. AC CSV preserves real and imaginary values. The Node test starts one ngspice instance per fixture and checks transient, diode operating-point, AC, `.SUBCKT`, and operating-point, AC, and DC sweep raw vectors. For the four M0.3 native-parity reference circuits, run the dedicated gate; it requires a native executable and cannot silently skip comparison:

```sh
NGSPICE_NATIVE=/path/to/pinned/native/ngspice npm run test:wasm:parity
```

Build the native executable from the exact commit in `UPSTREAM_COMMIT` before comparing. The gate checks the executable and compares numeric analysis rows for RC transient, diode operating point, RLC AC, and a small `.SUBCKT`. `npm run test:wasm` remains the broader WASM-only fixture suite; neither command compiles the runtime.

The link uses a 2 MiB WASM stack. A checked build showed that ngspice's `inp_fix_inst_calls_for_numparam` routine reserves four 10,000-entry local arrays, which do not fit Emscripten's 64 KiB default stack. The configure step enables XSPICE, skips its optional Verilog/VHDL adapters, and excludes the `table` ICM because its upstream license is GPL-2.0-or-later. Other XSPICE analog modules are compiled. The browser worker runs one transient analysis per worker; Stop terminates that worker. Firefox passes the 17 ngspice-backed workflows locally. Cancellation is covered by the long-run browser test; broader performance measurements still need verification.

The generated runtime is for local development and remains ignored by Git. Run the build script only when changing the ngspice source pin, Emscripten build configuration, or engine integration and a refreshed local artifact is needed; ordinary UI work uses the existing runtime. GitHub Pages builds the engine-free editor preview and does not compile, upload, or distribute the runtime. The detailed build outputs and upstream materials are described by the build script and stay local.
