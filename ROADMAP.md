# ELSim: agent-ready product and engineering roadmap

Status: active implementation roadmap, 2026-10-09. The application foundation is being built in this repository.

## 1. Product goal

Build an original, open-source circuit simulator that runs in modern browsers and can later be packaged for Windows, macOS, and Linux. The first experience should be as quick to learn as CircuitJS/Falstad: place parts, connect wires, press Run, see current flow, interact with switches, and probe voltages. It should grow toward LTspice-style schematic capture, hierarchical sheets, imported IC macromodels, and serious waveform analysis.

The product must not promise universal LTspice compatibility. ELSim will import supported unencrypted files, preserve unsupported content when practical, and produce explicit diagnostics. It will not bundle LTspice binaries, proprietary symbols, or vendor model libraries without a verified redistribution license.

### Product principles

- One electrical source of truth: ngspice results drive plots and animations. A visual effect must never silently change circuit behavior.
- Beginner path first: useful defaults, examples, direct manipulation, readable explanations, and progressive disclosure of SPICE details.
- Local first: circuit files and simulations work without an account or hosted compute service.
- Portable projects: a documented, versioned format with project-owned dependencies and deterministic import/export.
- Reproducible results: record ngspice version, settings, generated netlist, and model hashes with each run.
- Original UI, symbol art, examples, and documentation. Feature parity is a goal; copying CircuitJS implementation or branded assets is not.

## 2. Proposed architecture and tools

| Area | Initial choice | Why / decision gate |
| --- | --- | --- |
| App | TypeScript, React, Vite | Mature browser tooling and component ecosystem. Pin versions after a dependency license audit. |
| Schematic editor | Custom scene graph rendered with SVG initially | Crisp symbols, accessible hit targets, simpler editing. Benchmark before considering Canvas/WebGL for very large sheets. |
| Workspace panels | React layout with dockable waveform panels | In-app windows are browser UI; C++ rendering is unnecessary. Pop-out browser windows can be later. |
| Waveforms | Canvas or WebGL plotting layer behind an internal trace API | Handle large vectors and zoom/pan; benchmark and choose a maintained permissively licensed library or implement a thin renderer. |
| Simulation | Pinned ngspice source compiled by Emscripten into WebAssembly | Run in a dedicated worker. Use a narrow adapter so the native build can later use libngspice. |
| Native app | Tauri or similar, decision after web MVP | Reuse the UI; compare native engine packaging and platform support before choosing. |
| Project format | Versioned JSON manifest in a ZIP container (`.elsim`) | Holds sheets, symbols, models, settings, and provenance. Specify schemas before widespread use. |
| Quality | Vitest, Playwright, ngspice golden circuits, license/SBOM tooling | Test connectivity, numeric results, import round trips, and releases rather than UI snapshots alone. |

The browser worker is not the same as using Emscripten pthreads. Begin with a single-threaded ngspice build inside one Web Worker. If ngspice requires pthreads for chosen features, test that separately; deployed pthreads require browser cross-origin isolation headers. Do not assume all native ngspice extensions, dynamic model loaders, file access, or callbacks work unchanged in WebAssembly.

### Core boundaries

1. **Document model:** project, sheets, symbol definitions, component instances, wires, junctions, net labels, hierarchical ports, model assets, simulation configurations, plots, and UI state.
2. **Connectivity/netlister:** deterministic graph construction, node naming, hierarchy flattening, model references, and source mapping from generated netlist lines back to schematic objects.
3. **Engine adapter:** `loadProjectNetlist`, `run`, `cancel`, `subscribeVectors`, `getDiagnostics`, `dispose`; browser and native implementations share result types.
4. **Results store:** immutable run metadata, typed vectors with units and axes, sampling/downsampling, and value lookup at an animation time cursor.
5. **Presentation:** editor, library, properties, help, plot panels, diagnostics, and animations consume document/results APIs, never engine internals.

### Component schema requirements

Each definition has a stable ID and version; electrical type (`R`, `C`, `L`, `D`, `Q`, `M`, `X`, etc.); ordered pins with names, directions, and SPICE order; parameter schema with units and defaults; netlist template or model reference; symbol geometry; and optional animation channels. Each instance has its own ID, reference designator, transform, editable values, pin-to-net connections derived from geometry, and provenance. Imported `.asy` pin order must come from `SpiceOrder`, not visual position. Unknown imported attributes should be retained in a namespaced extension field for future export.

Example animation bindings: lamp brightness from dissipated power with configurable nominal power; capacitor fill/color from voltage or stored energy; inductor effect from current; wire particles from current direction and magnitude; switch motion from its actual state. Clamp and explain all mappings. Animation sampling must be decoupled from solver time steps and must not suggest electrical precision it does not have.

## 3. Milestones and issue backlog

Every issue must include owner, dependencies, acceptance criteria, test evidence, documentation changes, and license impact. Agents may work in parallel only across explicit boundaries; avoid concurrent edits to the project schema or engine adapter without an agreed contract.

### M0 — Foundations and legality (release gate)

**M0.1 Product specification.** Write user journeys for first circuit, probing, editing while paused, importing an IC, reopening a project, and hierarchical navigation. Define MVP component/analysis matrix and explicit out-of-scope items. Acceptance: each journey has a working-example circuit and measurable completion criteria.

**M0.2 License decision and provenance.** Choose ELSim's license (MIT is a candidate, subject to exact bundled dependencies), add `LICENSE`, `THIRD_PARTY_NOTICES`, contribution rules, and a dependency inventory. Pin an ngspice release/commit and audit every compiled source file and linked library, including build-generated artifacts. Acceptance: reviewed inventory identifies license, copyright notice, source location, inclusion method, and obligations for every shipped binary/asset; no unresolved redistribution status.

**M0.3 Technical spike.** Compile a minimal, reproducible ngspice WASM build with Emscripten; run RC transient, diode DC, RLC AC, and a small `.SUBCKT` example in a worker; obtain numeric vectors and diagnostics; measure load size, load time, memory, cancellation, and UI responsiveness in Chrome, Firefox, and Safari. Acceptance: results match the same pinned native ngspice within recorded tolerances; failed or stalled runs can be terminated; build recipe works in CI. If this fails, record the failure and revise architecture before building the editor.

**M0.4 Architecture contracts.** Publish JSON schemas, engine protocol, run metadata, error types, and netlist source-map design. Acceptance: two independently implemented sample producers/consumers pass contract fixtures.

### M1 — Browser MVP: learn, build, simulate

**M1.1 Editor primitives.** Grid, zoom/pan, selection, wire routing/junctions, rotate/flip, move, copy/paste, undo/redo, save/open. Acceptance: keyboard and pointer flows; no accidental electrical connection at crossings; connectivity remains stable through edits and reload.

**M1.2 Starter library.** Ground; R, C, L; DC, AC, pulse sources; diode and LED; switch; probe; basic transistor and op-amp models where the model is documented and redistributable. Each part has properties, units, validation, symbol, help, and a netlist test. Acceptance: a beginner can build and run LED, RC, RLC, and transistor switch examples without writing SPICE.

**M1.3 Simulation controls.** Run/pause/reset, transient and DC operating point, simulation settings, error-to-object mapping, and nonconvergence guidance. Define whether pause means pausing display or solver and label it accurately. Acceptance: edits invalidate stale results; diagnostics point to a component or directive when possible.

**M1.4 Results and visualization.** Click-to-probe voltage/current, synchronized time cursor, dockable plot panels, plot axes/units, multiple traces, zoom, cursors, and CSV export. Implement current flow, LED/lamp, capacitor, and inductor visual channels based on results. Acceptance: plots and animations derive from the same run and cursor; high-sample-count traces remain responsive.

**M1.5 Beginner experience.** Onboarding, searchable components, example circuits, hover explanations, sensible simulation presets, and accessible colors/keyboard operations. Acceptance: scripted first-use test reaches a working circuit without knowledge of netlists.

### M2 — Project system and deeper simulation

**M2.1 `.elsim` specification.** Versioned manifest and ZIP layout; schema validation, migration, asset hashes, relative paths, safe extraction limits, and deterministic serialization. Acceptance: round trip preserves connectivity, layout, models, plots, and hierarchy; malformed archives cannot read arbitrary local files.

**M2.2 Analysis expansion.** AC, DC sweep, parameter stepping, measurements, initial conditions, and controlled sources, in that order. Acceptance: numeric comparison against pinned ngspice reference circuits, with documented tolerances and unsupported directives.

**M2.3 Hierarchy.** Sheets, reusable blocks, port mapping, instance parameters, scoped labels, navigation, and cross-probing. Acceptance: a nested two-level circuit simulates equivalently to a flattened reference; repeated block instances remain distinct.

**M2.4 Custom symbols/models.** In-app symbol editor and safe import of unencrypted `.model`, `.subckt`, `.lib`, and `.include` assets. Validate declared pins versus model order; store assets inside the project with provenance and redistribution status. Acceptance: user-supplied op-amp IC model works in a fresh browser session; missing/incompatible models yield actionable diagnostics.

### M3 — LTspice interoperability

**M3.1 Compatibility matrix and fixtures.** Catalog supported `.asc`, `.asy`, directives, primitives, parameters, and model dialect features. Use original hand-written fixtures or files whose redistribution is permitted. Acceptance: every supported syntax item has a fixture; known unsupported items have a diagnostic.

**M3.2 `.asy` and `.asc` importer.** Parse symbols, pin order, placements, wires, labels, directives, hierarchy references, and model paths. Keep unknown data for possible round-trip export. Acceptance: imported ordinary schematics preserve topology and visible placement; report missing symbols/models and dialect mismatches.

**M3.3 Model compatibility assistant.** Identify unsupported proprietary/encrypted models, LTspice-specific constructs, and ngspice dialect differences. Offer only transformations backed by tests; never silently rewrite a model. Acceptance: user sees exactly which model or directive prevents simulation and can supply a compatible replacement.

**M3.4 Export design (later milestone).** Specify `.asc`/`.asy`/model output from the internal model, with loss reports. Implement after import and internal hierarchy stabilize. Acceptance: exported supported projects open in LTspice and preserve circuit topology; unsupported ELSim animation/UI data is clearly omitted.

### M4 — Distribution and performance

**M4.1 Browser release.** CI build, CSP review, offline/PWA behavior, browser support matrix, accessibility pass, reproducible WASM bundle, source/notice delivery, and download size budget. Acceptance: clean install and offline example run on supported browsers.

**M4.2 Desktop evaluation.** Compare Tauri/native ngspice versus packaging the browser WASM build for Windows, macOS, Linux. Include code signing, native library license notices, auto-update policy, and performance. Acceptance: written choice backed by prototype and repeatable builds on all three systems.

**M4.3 Large-circuit performance.** Profile editor, netlister, simulation, vector transport, plot memory, and animations. Acceptance: publish representative benchmark circuits and budgets before optimizing; no false numeric simplifications.

## 4. Legal and open-source release policy

This is an engineering risk assessment, not a legal opinion. The project can be open source under this approach, provided the exact distributed code and assets are audited.

| Material | Current finding | Required action |
| --- | --- | --- |
| ngspice | Project states most code is modified BSD, with exceptions. Its manual identifies LGPL-covered portions and other provenance. | Pin source and build flags; audit compiled files and transitive code; preserve notices and satisfy any LGPL/source obligations for the actual bundle. Do not label the entire binary simply “BSD”. |
| CircuitJS/Falstad | CircuitJS1 states GPL-2.0-or-later. Ideas, workflows, and independently implemented behavior can guide ELSim; copied code/art/assets trigger its license conditions. | Build original code, symbols, examples, and wording. If incorporating CircuitJS code, revisit whole-app licensing first. |
| LTspice application/library | LTspice is free software to use but is not presented as open-source software; its EULA is installed with the product. Model and symbol rights vary by supplier. | Support user-provided files. Do not commit or package LTspice binaries, built-in libraries, demo circuits, fonts, icons, or third-party models until the specific rights are verified. Record provenance and license per bundled model. |
| User imports | A user may possess a file without redistribution rights. Browser-local import is different from publishing that file in this repository or on a server. | Keep imports local by default; show sharing/export warning if project contains restricted or unknown-license assets; require explicit user action for sharing. |
| Dependencies | Web UI, plot library, icon set, fonts, and desktop shell each have licenses. | Maintain lockfiles, SBOM, notices, and automated license checks, followed by human review of exceptions. |
| Marks | Falstad, CircuitJS, LTspice, and vendor product names identify other projects. | Describe compatibility factually; use original ELSim branding; avoid names/logos that imply endorsement. |

Do not claim “legal to use” for arbitrary manufacturer models or encrypted files. A compatibility parser is a separate deliverable from permission to redistribute source files or models. Before the first public binary, have a qualified open-source/IP reviewer inspect the chosen ELSim license, exact ngspice source set, bundled dependencies, model assets, and distribution notices.

## 5. Agent operating instructions

Use this section as the goal prompt for AI agents:

> Build ELSim according to `ROADMAP.md`. Start with M0 and do not implement broad UI features until the ngspice WebAssembly feasibility and license inventory gates have evidence. Work in small, reviewable changes. Preserve architecture boundaries and the versioned project schema. Every new component must include electrical pin order, netlist generation, properties/units, original symbol rendering, optional animation mapping, and a numeric reference circuit. Every import path must produce a loss/diagnostic report. Never bundle third-party models or assets without recorded redistribution rights. Update the roadmap's decision log and compatibility matrix when evidence changes. Report completed acceptance criteria, test commands/results, and remaining risks in each PR.

Suggested agent ownership once M0 contracts are agreed: engine/WASM; document/netlister; editor/design system; waveforms/animation; interoperability; release/legal inventory. Agents may prototype independently, but a maintainer resolves schema/adapter changes before merging.

### Definition of done for any issue

1. Acceptance criteria demonstrated with a reproducible example.
2. Relevant unit/integration tests and, for electrical behavior, comparison to pinned native ngspice.
3. Failure paths and user-facing diagnostics covered.
4. Documentation, compatibility matrix, and project migration updated if applicable.
5. Dependency and asset provenance recorded; no unknown-license material added.
6. Browser performance and accessibility checked for user-visible changes.

## 6. Decision log and open questions

| Decision | Current position | Evidence needed to finalize |
| --- | --- | --- |
| ELSim license | MIT candidate; do not add license file until owner selects it | Owner preference; exact dependency compatibility review |
| Browser engine | Single-thread ngspice WASM in Web Worker | M0.3 benchmarks and API viability |
| Server backend | No required server for MVP | Revisit only if measured workloads require it |
| Desktop wrapper | Defer choice | M4.2 platform prototype |
| Plot renderer | Canvas first, internal trace API | Performance/accessibility benchmark |
| LTspice export | Later than import | Stable internal schema and loss mapping |

### Implementation evidence update (2026-10-09)

The local environment does not have Emscripten or ngspice, and its package index is not reachable from the shell, so the complete M0.3 build and numeric parity checks cannot run here. A public ngspice-WASM build project documents an ngspice 46 build with an ES module interface and no dynamic library loading; its public docs have described `web,node` execution, so it remains unverified for the dedicated-worker runtime. A newer EasyEDA build note reports ngspice 46, Emscripten 5.0.7, XSPICE enabled, and `web,worker,node`; that is a promising spike candidate, not independently reproduced evidence or a vetted dependency. Wokwi also publishes an ngspice-WASM build, but its exact worker interface, feature configuration, and license inventory still need review. Emscripten documents a separate-worker API that does not require SharedArrayBuffer or COOP/COEP, which is the first candidate architecture for a single-threaded engine. These are leads, not passed gates. Keep actual Run/simulation results unavailable until a pinned build is integrated in a dedicated worker and M0.3 native parity checks pass. Re-evaluate support for XSPICE and user `.SUBCKT` models against the selected configuration.

### Current implementation status (2026-10-09)

| Area | Status | Evidence / next step |
| --- | --- | --- |
| App shell | In progress | React/Vite workspace with component tray, canvas, inspector, analysis panel, and status area. |
| Document model | Initial v2 | Geometry-first versioned JSON project model, v1 migration, localStorage/download-open flow, and JSON Schema; `.elsim` ZIP container and versioned migration pipeline remain. |
| Editor | Early implementation | Select/move, rotate, add/delete/duplicate parts, geometry-based pin/wire connectivity, labels, zoom, properties. Undo/redo, wire deletion, label editing, robust routing/junction UI, ERC, and exhaustive connectivity verification remain. |
| Netlister | Early implementation | Generated netlist reads derived connectivity, sanitizes values/references, emits starter R/C/L/source/diode devices, and now returns line-to-schematic source mappings plus diagnostics. Switch control and broad model/hierarchy semantics remain. |
| Engine contracts | In progress | TypeScript contract and JSON schema now define worker requests/responses, diagnostics, source mapping, run metadata, and traces. Contract fixtures and independent producer/consumer checks remain. |
| Simulation engine | Not integrated | Run is explicitly unavailable; no generated waveform data is fabricated. M0.3 must pass before this changes. |
| Analysis / animations | Not implemented | Empty-state explains engine gate; plot panels, animations, and electrical result bindings remain. |
| Interoperability | Not implemented | No LTspice parser or model bundle is present. |
| Legal release review | Not complete | ELSim license is undecided; no engine binary or vendor assets bundled. |

## 7. Primary references checked

- ngspice source: https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/
- ngspice licensing overview: https://ngspice.sourceforge.io/devel.html
- ngspice manual, license and shared-library API: https://ngspice.sourceforge.io/docs/ngspice-manual.pdf
- ngspice shared-library overview: https://ngspice.sourceforge.io/shared.html
- CircuitJS1 repository and GPL notice: https://github.com/sharpie7/circuitjs1
- LTspice product and library information: https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html
- Analog Devices on third-party models: https://www.analog.com/en/resources/technical-articles/ltspice-how-to-import-third-party-models.html
- Analog Devices LTspice EULA location: https://support.analog.com/en-US/knowledgebase/article/ka-16982
- KiCad LTspice format import documentation: https://dev-docs.kicad.org/en/import-formats/ltspice/
- Emscripten pthread deployment requirements: https://emscripten.org/docs/porting/pthreads.html
- Emscripten worker APIs and deployment tradeoffs: https://emscripten.org/docs/api_reference/emscripten.h.html#worker-api
- Current EasyEDA ngspice-WASM build notes (candidate evidence only): https://github.com/easyeda/eext-simulation-with-ngspice/blob/main/NGSPICE_WASM_BUILD.md
