# ELSim

An original, browser-based circuit workbench that aims to pair a beginner-friendly schematic editor with ngspice simulation and deeper SPICE model support.

## Current preview

The app includes beginner and advanced circuit examples, a schematic editor, reusable hierarchical sheets, and transient, operating-point, DC sweep, AC, noise, transfer-function, pole-zero, sensitivity, and harmonic/intermodulation distortion analyses. Users can select bounded parameter sweeps, probe only the signals they want, open multiple waveform windows, and export results as CSV. Components animate from solved results, including wire current, capacitor charge, LED/lamp brightness, and magnetic fields. Projects save locally in the browser or as `.elsim` archives; user-provided subcircuit and device-model libraries can be imported into projects. See [ROADMAP.md](ROADMAP.md) for active work and limits. LTspice compatibility development is paused for a separate future goal; its existing experimental implementation is documented in [LTSPICE_COMPATIBILITY.md](LTSPICE_COMPATIBILITY.md).

The repository includes an original [five-pin op-amp import example](examples/user-opamp/) demonstrating a user-supplied `.SUBCKT`, matching `.asy` pin order, and browser ngspice simulation. The teaching macro-model omits real-device dynamics and is not suitable for validating physical op amps.

The application UI runs in a modern browser without an account. The production build includes a web manifest and service worker for offline app-shell navigation and editing; projects remain in browser local storage or can be exported as `.elsim`. ngspice is an optional local WebAssembly runtime in this source preview: editor, project, and export features remain available when that runtime is absent. When built locally, simulation runs in a Web Worker. The default and GitHub Pages builds omit the engine. For a local offline simulation check, `npm run build:offline` packages an already-built, ignored `public/engine` runtime; it does not compile WASM and is not the Pages artifact. Chromium and Firefox checks are available through local Playwright commands; GitHub Actions runs the Pages deployment workflow only. The current v11 structure is described in [the JSON Schema](schemas/project-v11.schema.json); v1–v10 files remain supported through migration. V10 added non-electrical schematic notes; v11 raises the supported ordered pin count for imported ICs and custom symbols to 256.

Production builds emit a `_headers` file with the app's Content Security Policy and baseline security headers for static hosts that support this convention, including Cloudflare Pages and Netlify. The Vite production preview uses the same policy; the local Playwright production test checks its response headers, WebAssembly permission, and browser violations. Other hosting providers must be configured to send the equivalent headers. Inline JavaScript and general `unsafe-eval` are disallowed; `wasm-unsafe-eval` is allowed for the circuit engine, while inline styles remain enabled for React-generated component styling.

The app supports static hosts with a project subpath such as GitHub Pages. Build the engine-free preview with `VITE_BASE_PATH=/ELSim/ npm run build`; use `/` for a root-domain deployment. The base path is applied to the app entry point, service worker, and browser engine URLs. The `Deploy GitHub Pages preview` workflow is manual: run it from the Actions tab when you want to publish the `/ELSim/` preview. It does not deploy on every push. In repository Settings → Pages, select **GitHub Actions** as the publishing source. This preview edits and saves projects; browser simulation requires a local ngspice runtime.

For local simulation, build the engine with Emscripten 5.0.7 and the pinned ngspice source as described in [the WASM build notes](engine/wasm/README.md); the Vite development server serves that ignored local runtime. The WASM binary is not committed, built by Pages, or included in the standard production build; each developer builds it locally when needed. The worker message, diagnostic, run metadata, and netlist source-map contract is documented in [the engine protocol schema](schemas/engine-protocol.schema.json). See [ROADMAP.md](ROADMAP.md) for the staged implementation plan.

## Run the web app

Requires Node.js and npm. From this directory:

```sh
npm install
npm run dev
```

Use Save to download a portable `.elsim` archive, or Open to restore one. Existing `.elsim.json` documents can still be opened. The archive format and safety limits are documented in [PROJECT_FORMAT.md](PROJECT_FORMAT.md). A working copy is also kept in this browser's local storage.

## Tests

Run `npm test` for domain and netlist tests. Run `npm run build` for the standard browser distribution and its check that no ngspice binaries were included. For the routine browser UI check, install Chromium with `npx playwright install chromium` and run `npm run test:e2e:ui`; it runs the short smoke set for startup, examples, shortcuts, selection, and keyboard navigation without building or loading WASM. `npm run test:e2e:ui:smoke` is an alias. Run `npm run test:e2e:ui:full` for the full no-engine UI suite. For offline simulation/PWA coverage, first run `npm run build:offline`, then run `npm run test:e2e:pwa` (Chromium) or `npm run test:e2e:pwa:firefox`; this packages the already-built, ignored local ngspice runtime into `dist` and does not compile WASM. The PWA test expects those engine files to be present and verifies they still work after the browser goes offline. `npm run test:e2e:compat` runs the editor UI tests in Firefox; install it with `npx playwright install --with-deps firefox`. Keep the PWA preview tests separate from the editor suite because they require the production build's base path to match the preview URL. Engine-dependent tests carry the Playwright `@ngspice` tag, which the no-engine suites exclude. LTspice-specific tests also carry `@ltspice` and are excluded from active app test commands while that compatibility work is paused; run `npm run test:e2e:ltspice` when intentionally working on it. Add `@ngspice` to any new browser test that starts or requires the simulator. For quick engine feedback after building the local WASM runtime, use `npm run test:e2e:engine` (Chromium) or `npm run test:e2e:engine:firefox`; these run representative `@engine-smoke` workflows for RC solving, probes, current animation, and waveform controls. Use `npm run test:e2e:engine:full` or `npm run test:e2e:engine:full:firefox` for all active app engine workflows, excluding the paused LTspice set. GitHub Actions runs only the Pages deployment workflow.

Run `npm run benchmark:performance` for connectivity, netlist, plot-reduction, and raw parsing baselines. If a local ngspice WASM runtime is present, the command also measures solver and vector-copy paths. See [PERFORMANCE_BENCHMARKS.md](PERFORMANCE_BENCHMARKS.md) for generated circuit sizes, local reference budgets, measured results, and performance paths that still need browser profiling.

## Engine and licensing

ELSim uses ngspice as its numerical engine. The generated runtime is excluded from source control and hosted builds; developers compile it locally for simulation. This project does not publish or distribute that generated runtime. Existing source and dependency notices remain with the repository, but artifact redistribution review is outside the current app goal. Imported vendor models remain user-provided assets.

ELSim does not include CircuitJS/Falstad implementation code or LTspice binaries/libraries. Its UI, symbols, and examples are original project work.
