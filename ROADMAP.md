# ELSim: agent-ready product and engineering roadmap

Status: active implementation roadmap, 2026-10-10. The application foundation is being built in this repository.

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
| Quality | Node built-in test runner initially, Playwright, ngspice golden circuits, license/SBOM tooling | Test connectivity, numeric results, import round trips, and releases rather than UI snapshots alone. |

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

**M0.1 Product specification.** Specify the first-release journeys and support matrix below before declaring the browser MVP complete.

#### User journeys and acceptance targets

| Journey | Example circuit / action | Completion criteria |
| --- | --- | --- |
| Build and run a first circuit | Open the RC step-response starter, change R or C, run transient analysis, and inspect `V(vout)`. | A first-time user can reach a non-empty result in under 5 minutes with no netlist editing; invalid settings point to the relevant field; the plot reports units and time range. |
| Probe and inspect | Click a wire for node voltage and a two-terminal component for branch current; add both traces to a plot. | Probe names and sign convention are explicit; two traces can be shown together; cursor readout reports value and time; CSV export preserves units/header. |
| Edit and rerun | During or after a run, move/rotate a part or change its value, then rerun. | Edits update connectivity; old results are visibly marked stale and never shown as current; cancel/stop leaves the UI responsive; rerun corresponds to the edited project revision. |
| Import an IC model | Import a user-owned, unencrypted `.SUBCKT` plus a compatible symbol or map its ordered pins in the import dialog. | Pin order follows declared SPICE order; source/provenance and license status are stored; a runnable example reports actionable errors for missing models or unsupported syntax; no vendor model is silently bundled. |
| Save and reopen | Save the example with a custom model and two plot traces, close/reload, then open on a fresh browser profile. | Project, assets, plot setup, and connectivity survive a round trip; the project opens without account/network access; missing external resources are identified by name and hash. |
| Navigate hierarchy | Create a reusable two-level block with named ports, instantiate it twice, and cross-probe into one instance. | Instance parameters and scoped nets remain distinct; the hierarchical circuit simulates equivalently to its flattened reference; navigation returns to the parent without losing selection or view. |

The first browser MVP supports transient analysis for DC sources, resistors, capacitors, inductors, ground, pulse sources, diodes/LEDs, and ideal switches; wire and node-voltage probes; generated netlist preview; local project save/open; and CSV waveform export. AC and DC operating point, parameter sweeps, arbitrary behavioral sources, transistor/op-amp libraries, full model-library management, import/export, hierarchy, cloud collaboration, and native desktop packaging are explicitly outside the first MVP, but remain planned milestones. A component only counts as supported when its ordered electrical pins, editable properties/units, netlist behavior, original symbol, and numeric reference circuit are present.

Acceptance: all six journeys have runnable example projects and automated measurable completion criteria; each MVP matrix item has an owner and is represented in the compatibility matrix.

**M0.2 License decision and provenance.** Choose ELSim's license (MIT is a candidate, subject to exact bundled dependencies), add `LICENSE`, `THIRD_PARTY_NOTICES`, contribution rules, and a dependency inventory. Pin an ngspice release/commit and audit every compiled source file and linked library, including build-generated artifacts. Acceptance: reviewed inventory identifies license, copyright notice, source location, inclusion method, and obligations for every shipped binary/asset; no unresolved redistribution status.

**M0.3 Technical spike.** Compile a minimal, reproducible ngspice WASM build with Emscripten; run RC transient, diode DC, RLC AC, and a small `.SUBCKT` example in a worker; obtain numeric vectors and diagnostics; measure load size, load time, memory, cancellation, and UI responsiveness in Chrome, Firefox, and Safari. Acceptance: results match the same pinned native ngspice within recorded tolerances; failed or stalled runs can be terminated; build recipe works in CI. If this fails, record the failure and revise architecture before building the editor.

**M0.4 Architecture contracts.** Publish JSON schemas, engine protocol, run metadata, error types, and netlist source-map design. Acceptance: two independently implemented sample producers/consumers pass contract fixtures.

### M1 — Browser MVP: learn, build, simulate

**M1.1 Editor primitives.** Grid, zoom/pan, selection, wire routing/junctions, rotate/flip, move, copy/paste, undo/redo, save/open. Acceptance: keyboard and pointer flows; no accidental electrical connection at crossings; connectivity remains stable through edits and reload.

**M1.2 Starter library.** Ground; R, C, L; DC, AC, pulse sources; diode and LED; switch; VCVS and VCCS; educational NPN and PNP transistors; probe; op-amp models where the model is documented and redistributable. Each part has properties, units, validation, symbol, help, and a netlist test. The built-in BJT cards use an original approximate parameter set with an editable forward beta, not vendor model files. Acceptance: a beginner can build and run LED, RC, RLC, controlled-source, and transistor switch examples without writing SPICE.

**M1.3 Simulation controls.** Run/pause/reset, transient and DC operating point, simulation settings, error-to-object mapping, and nonconvergence guidance. Define whether pause means pausing display or solver and label it accurately. Acceptance: edits invalidate stale results; diagnostics point to a component or directive when possible.

**M1.4 Results and visualization.** Click-to-probe voltage/current, synchronized time cursor, dockable plot panels, plot axes/units, multiple traces, zoom, cursors, and CSV export. Implement current flow, LED/lamp, capacitor, and inductor visual channels based on results. Acceptance: plots and animations derive from the same run and cursor; high-sample-count traces remain responsive.

**M1.5 Beginner experience.** Onboarding, searchable components, example circuits, hover explanations, sensible simulation presets, and accessible colors/keyboard operations. Acceptance: scripted first-use test reaches a working circuit without knowledge of netlists.

### M2 — Project system and deeper simulation

**M2.1 `.elsim` specification.** Versioned manifest and ZIP layout; schema validation, migration, asset hashes, relative paths, safe extraction limits, and deterministic serialization. Archive v1 stores project JSON only; user model source is held in optional project-v2 `modelAssets` with SHA-256 and unknown redistribution status. Project v2 also persists selected trace IDs and normalized horizontal ranges for transient, AC, and DC sweep plots. Hierarchy data remains future document-model work. Acceptance: round trip preserves connectivity, layout, models, plots, and hierarchy; malformed archives cannot read arbitrary local files. See `PROJECT_FORMAT.md` for current format and limits.

**M2.2 Analysis expansion.** AC and DC source sweep are implemented. Parameter stepping supports one or two resistors, capacitors, or inductors with up to ten combinations and separate result series. Transient `MAX`, `MIN`, `AVG`, and `RMS` measurements can be configured for voltage or component-current vectors and are returned per sweep case. Labeled-node voltage initial conditions and an explicit UIC option are supported for transient runs. Linear VCVS (`E`) and VCCS (`G`) devices use native ngspice primitives, four ordered pins, editable gain/transconductance, and branch-current probes. ngspice has no native `.step` directive; the worker uses explicit `alter`/`run`/`write` control commands, following the [ngspice user manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf). Delay/trigger measurements, element-current initial conditions, behavioral-source syntax, and CCCS/CCVS remain. Acceptance: numeric comparison against pinned ngspice reference circuits, with documented tolerances and unsupported directives.

**M2.3 Hierarchy.** Sheets, reusable blocks, port mapping, instance parameters, scoped labels, navigation, and cross-probing. Acceptance: a nested two-level circuit simulates equivalently to a flattened reference; repeated block instances remain distinct.

**M2.4 Custom symbols/models.** Partial: user-selected text libraries containing complete `.SUBCKT` blocks and shared `.MODEL`, `.PARAM`, `.FUNC`, or `.GLOBAL` records can be parsed and stored locally in project data. Parser rejects external includes, control/execution directives, top-level circuit elements, malformed pin declarations, and unmatched blocks. The UI displays ordered pins, file name, and unknown redistribution status; SHA-256 is verified on project open and required before simulation. Imported models can be added as schematic `X` instances; instance pin geometry and inspector rows follow the declared SPICE order, and the netlister emits `X...` rows plus project-owned model definitions. A bundled hand-authored four-pin fixture exercises ngspice WASM parsing and confirms a 10 V operating-point result, but no vendor model is bundled. Remaining: model-to-symbol mapping/editor, `.model`-only import, dependency graph resolution, compatibility reporting, stronger license/provenance controls, and a browser end-to-end user-supplied IC import/place/simulate test. Acceptance: user-supplied op-amp IC model works in a fresh browser session; missing/incompatible models yield actionable diagnostics.

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
| ELSim license | MIT selected by project owner on 2026-10-09 and applied to original source | Before release: review contribution policy and verify bundled licenses/notices; this does not relicense ngspice or imported assets |
| Browser engine | Single-thread ngspice WASM in Web Worker | M0.3 benchmarks and API viability |
| Parameter stepping | Generate bounded `alter`/`run` sequences and preserve one result dataset per value combination | Verify output parity and memory use for larger transient cases; ngspice does not offer a native `.step` command |
| Transient measurements | Generate named `.meas` directives and parse their scalar output, adding sweep-case labels | Expand supported operations/measurement windows only with native/WASM numeric fixtures |
| Initial conditions | Generate `.ic v(node)=...`; optionally add `uic` to `.tran` | Verify voltage initialization and transient startup behavior against native ngspice; add element current ICs later |
| Server backend | No required server for MVP | Revisit only if measured workloads require it |
| Desktop wrapper | Defer choice | M4.2 platform prototype |
| Plot renderer | Canvas first, internal trace API | Performance/accessibility benchmark |
| LTspice export | Later than import | Stable internal schema and loss mapping |

### Implementation evidence update (2026-10-09)

M0.3 has a reproducible **partial pass**. The original optimized build used Emscripten's 64 KiB default stack; checked execution showed `inp_fix_inst_calls_for_numparam` exhausting it while reserving four 10,000-entry local arrays. A clean optimized build from pinned ngspice 47 with a 2 MiB stack runs RC transient, diode operating point, RLC AC, and `.SUBCKT` fixtures in a Node worker. A fresh native build from the same commit matches every printed numeric row within `1e-7`. The build script and fixtures live under `tools/` and `engine/wasm/`; the generated wasm was 4.5 MiB and its Emscripten JS glue 76 KiB. The build enables XSPICE but skips Verilog/VHDL adapters and does not package or validate XSPICE `.cm` model modules, which remain unsupported.

The browser now runs the local ngspice WASM in a Web Worker for transient, DC operating-point, DC voltage-source sweep, and AC frequency-sweep analyses. Chromium verified the starter RC transient run, 1,037 time points, voltage/current vectors, wire voltage probing (`V(vin)`), component current probing (`I(R1)`), shared mixed-unit cursor readout, CSV export, stale-result indication, and rerun after edits. It also verified the DC operating point table against the browser worker (`V(vin) = 5 V`, `V(vout) = 5 V`, and probed `I(R1) = 0 A` for the open-at-DC capacitor circuit). AC run returned 101 complex frequency samples, displayed magnitude/phase, and exported selected vectors. DC sweep returned 51 points from 0 to 5 V, plotting the divider output against `V1`. Chromium exercised plot zoom, fixed-step pan, reset, and cursor readouts on transient, AC, and DC sweep plots. The new `.elsim` archive was downloaded in Chromium, reopened in the app with DC sweep settings preserved, and independently passed `unzip -t`; archive tests cover deterministic output, CRC failures, path traversal, compression rejection, and size limits. Automated probe hit-test coverage checks labeled wires, component bodies, rotation, pins, and rejects ground/background points. A Stop action terminates the worker, but cancellation has not yet been verified with a run long enough to interrupt. Still needed: engine memory/performance benchmarks and browser profiling of large real ngspice traces, graceful cancellation verification, Firefox/Safari, broader upstream regressions, robust diagnostics coverage, sweeps beyond two R/C/L parameters, stepping of sources or device-model parameters, draggable plot pan, vertical-axis zoom, automatic animation playback, wire current-flow animation, dockable waveform windows, and final source/license audit. Do not claim Verilog/VHDL or full XSPICE external-module support.

### Current implementation status (2026-10-10)

| Area | Status | Evidence / next step |
| --- | --- | --- |
| App shell | In progress | React/Vite workspace with component tray, canvas, inspector, analysis panel, and status area. The component search now filters the implemented starter library, reports empty results, and supports `/` focus; a four-step keyboard-dismissable quick tour walks through the starter, resistor editing, netlist inspection, and the current engine limitation. Browser verified search results/empty state and all tour steps. `npm test` (12 test files) and `npm run build` pass. Preview was inspected at a 949 px viewport; all three workspace panels fit after reducing the desktop minimum width. Narrower layouts still need review. |
| Document model | v2 plus `.elsim` archive foundation | Geometry-first versioned JSON project model, v1 migration, localStorage, `.elsim` ZIP save/open, deterministic stored entries, manifest/CRC checks, path and size limits, archive schema, standalone JSON import, backward-compatible plot preferences, and user-owned model source text with SHA-256 and unknown-license status stored inside `project.json`. Imported subcircuit instances persist model identity and ordered pin names. Archive ZIP asset entries and future hierarchy data remain. Browser download/open round-trip and independent ZIP integrity checks pass. |
| Editor | Early implementation | Select/move parts, wires, and labels; rotate and horizontally flip parts; add/delete/duplicate parts; delete selected wires/labels; create/edit net labels with a beginner-facing form; bounded undo/redo; keyboard shortcuts; geometry-based pin/wire connectivity; zoom and properties. Orthogonal wire segments can be dragged to reroute while preserving terminal pins; segments with interior branches, labels, or junctions are blocked. The Junction tool (J) toggles a saved connection at an interior crossing; crossings stay separate without the marker, and endpoint/T connections still join automatically. Geometry tests cover reroutes, terminal connectivity, blocked branch movement, crossing merge/separation, saved junction validation, and flip topology checks. Horizontal flip (F) is persisted as optional v2 presentation state; if moving wire anchors for a rotation or flip would change net membership, the editor rejects the change with a rerouting hint. Archive round-trip preserves flipped state. Browser verification of segment-drag and junction-toggle gestures remains; junction editing is no longer an unimplemented model capability. Viewport zoom controls, Ctrl/⌘+wheel zoom anchored at the pointer, and Space/middle-drag panning now use the persisted project view without adding electrical undo history or staling simulation results. Reset-to-center is available from the zoom percentage; live browser gesture verification remains. A non-blocking Check circuit report identifies floating component terminals (including terminals with dangling leads), shorted two-terminal parts, missing ground references, and conflicting connected-net labels; findings can select the affected part. Domain tests cover the starter, disconnected components, dangling leads, shorted parts, missing ground, conflicts, and empty projects. Full ERC rule coverage and browser interaction checks remain. |
| Netlister | Early implementation | Generated netlist reads derived connectivity, sanitizes values/references, handles SI units (including uppercase `M` as mega and scientific notation), emits R/C/L/source/diode/LED, ideal voltage-controlled switch, native E/G controlled sources, and NPN/PNP BJT devices with separate approximate models. Node tests cover RC, switches, LED, controlled-source pin order, transistor collector/base/emitter order, and beta validation. WASM fixtures verify controlled-source output vectors and NPN low-side switching with collector-current output. |
| Engine contracts | In progress | TypeScript contract and JSON schema now define worker requests/responses, diagnostics, source mapping, run metadata, and traces. Contract fixtures and independent producer/consumer checks remain. |
| Simulation controls | Partial | Run/stop and transient, operating-point, AC, and DC-sweep selection are present. Transient results now have play/pause and rewind controls; these animate the existing solved result and do not pause or rerun ngspice. Solver pause, browser interaction verification, and exact ngspice diagnostic variants remain. Engine failures retain netlist line/source mapping, select a mapped component when possible, and add advisory recovery hints for common floating-node, convergence, missing-model, and missing-vector failures. `npm test` covers source mapping and guidance; browser verification remains needed. |
| Simulation engine | Browser transient, DC operating-point, AC sweep, DC source-sweep, and parameter-stepping slices implemented | `tools/build-ngspice-wasm.sh` reproducibly builds pinned ngspice 47 with a 2 MiB WASM stack; `npm run test:wasm` exercises RC transient, diode operating point, RLC AC, `.SUBCKT`, browser-adapter DC/AC/DC-sweep raw vectors, LED transient current, parameter stepping, measurements, initial conditions, controlled-source output/current, and an NPN switch transient in Node workers. The original four printed numeric output sets match native ngspice from the same commit within `1e-7`. Chromium verified browser-worker transient, DC operating-point values, a 101-point AC run, and a 51-point voltage-source sweep; cancellation and Firefox/Safari remain unverified. |
| Analysis / animations | Transient plots, DC table, AC magnitude/phase, and DC sweep plot | Transient, AC, and DC sweep plotting now uses extrema-preserving sampling capped at roughly 900 indices per trace and range scans without full-size temporary arrays; a million-sample synthetic test verifies bounded output and retained narrow peaks. Browser profiling with large real ngspice traces remains. Transient vectors plot in-app; browser-verified component current and wire voltage probes, mixed voltage/current axes, shared time cursor, selected result CSV export, stale-result indication, a one-point DC table, AC frequency response magnitude/phase with complex real/imaginary CSV columns, voltage-source DC sweep, and horizontal zoom/fixed-step pan/reset/cursors across all plots are implemented. Project files persist selected trace IDs and horizontal plot ranges. Transient sample scrubbing and user-controlled play/pause/rewind synchronize the plot cursor with result-derived LED brightness, capacitor voltage glow, and inductor current glow. Conventional current now animates on unbranched schematic leads only when endpoint device currents agree; branched or ambiguous ideal-wire paths are deliberately omitted. Unit tests cover forward/reverse direction, KCL mismatch rejection, and a branched ground return. Bounded one- and two-parameter R/C/L stepping returns independently labeled waveform series and preserves each case's axis in CSV. Transient MAX/MIN/AVG/RMS results display by requested vector and parameter case. Labeled-node voltage initial conditions and optional transient UIC are implemented and verified against a WASM fixture. Linear VCVS/VCCS output vectors and branch-current probes pass a WASM fixture; a separate NPN switch fixture verifies collector-current probing. A WASM fixture verifies diode-current vector naming and forward current; another checks scalar measurement output. Dependent-source variants, delay/trigger measurements, capacitor/inductor current ICs, draggable pan, vertical-axis zoom, and dockable waveform windows remain. |
| Interoperability | Not implemented | No LTspice parser or model bundle is present. |
| Legal release review | Partial | Owner selected MIT for ELSim source; exact npm dependency inventory and runtime notices are included. ngspice source-file audit, final binary notices, and imported model provenance UI remain. No engine binary or vendor assets are bundled. |

## 7. Primary references checked

- ngspice source: https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/ (M0.3 spike pinned to `a80f6e3e95d51534905b1f23410a951802666656`)
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
