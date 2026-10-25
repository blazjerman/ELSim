# ngspice WebAssembly spike

The browser engine uses ngspice as its numerical core. The checked-in source pin is in [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT); this directory contains original ELSim regression decks and the build/test entry points.

## Reproduce the local build

The build script currently targets a Bash environment with GNU build tools; use Linux or WSL2 on Windows. The generated WebAssembly runtime runs in the supported Chromium and Firefox browsers. A native Windows shell and macOS build are not currently verified.

On Debian or Ubuntu (including WSL2), install the build tools once:

```sh
sudo apt-get update
sudo apt-get install build-essential autoconf automake libtool bison flex gettext pkg-config python3 make git gzip tar
```

Install and activate the exact Emscripten SDK version in the official [Emscripten SDK instructions](https://emscripten.org/docs/getting_started/downloads.html). For Linux/WSL, the commands are:

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install 5.0.7
./emsdk activate 5.0.7
source ./emsdk_env.sh
emcc --version
```

Keep that terminal open, or source `emsdk_env.sh` again in any new terminal used to build ELSim. The build requires a clean Git checkout of the exact ngspice commit recorded in [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT). Clone from the official SourceForge repository and check out that pin:

```sh
git clone https://git.code.sf.net/p/ngspice/ngspice ../ngspice
git -C ../ngspice checkout "$(tr -d '[:space:]' < engine/wasm/UPSTREAM_COMMIT)"
```

From the ELSim repository root, build and run the local runtime fixtures:

```sh
NGSPICE_SOURCE=../ngspice JOBS=2 ./tools/build-ngspice-wasm.sh
node tools/test-ngspice-wasm.mjs
```

The build writes the ignored local runtime files to `public/engine/`; restart or reload the local ELSim app after the build. It does not build the app or deploy GitHub Pages. The browser supports transient analysis with plotted real-valued vectors, DC operating point with a one-sample value table, DC source sweeps plotted against the swept source value, and AC sweeps with complex vectors rendered as magnitude in dB or phase in degrees on a logarithmic frequency axis. AC CSV preserves real and imaginary values. The Node test starts one ngspice instance per fixture and checks transient, diode operating-point, AC, `.SUBCKT`, and operating-point, AC, and DC sweep raw vectors. For the four M0.3 native-parity reference circuits, run the dedicated gate; it requires a native executable and cannot silently skip comparison:

```sh
NGSPICE_NATIVE=/path/to/pinned/native/ngspice npm run test:wasm:parity
```

When a clean checkout of the pinned source is available, the optional native build helper creates an isolated build under ignored `build/ngspice-native/` and writes the executable to `build/ngspice-native/bin/ngspice`:

```sh
NGSPICE_SOURCE=/path/to/pinned/ngspice JOBS=2 npm run build:ngspice:native
NGSPICE_NATIVE="$PWD/build/ngspice-native/bin/ngspice" npm run test:wasm:parity
```

This native build is only for the explicit parity check. It does not build or replace the browser WASM runtime. The gate compares numeric analysis rows for RC transient, diode operating point, RLC AC, and a small `.SUBCKT`. `npm run test:wasm` remains the broader WASM-only fixture suite; neither test command compiles the runtime.

The link uses a 2 MiB WASM stack. A checked build showed that ngspice's `inp_fix_inst_calls_for_numparam` routine reserves four 10,000-entry local arrays, which do not fit Emscripten's 64 KiB default stack. XSPICE core integration is enabled, but the static build excludes the entire `icm` directory along with the optional Verilog/VHDL adapters. As a result, no compiled XSPICE code models (including digital or analog ICMs) are available in the browser runtime; XSPICE `A` devices and PS-translated digital `U` devices cannot be simulated there. The `table` ICM is also excluded from the ICM inventory because its upstream license is GPL-2.0-or-later. The browser worker runs one transient analysis per worker; Stop terminates that worker. Firefox passes the 17 ngspice-backed workflows locally. Cancellation is covered by the long-run browser test; broader performance measurements still need verification.

The generated runtime is for local development and remains ignored by Git. Run the build script only when changing the ngspice source pin, Emscripten build configuration, or engine integration and a refreshed local artifact is needed; ordinary UI work uses the existing runtime. GitHub Pages builds the engine-free editor preview and does not compile, upload, or distribute the runtime. The detailed build outputs and upstream materials are described by the build script and stay local.
