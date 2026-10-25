# ELSim performance benchmarks

## Firefox 5,000-part navigation recheck (2026-10-25)

The focused large-schematic browser benchmark passed in Firefox on the documented i7-12700F host. The 5,000-part/4,900-wire project rendered in 842.15 ms with 64 parts and 551 wires mounted. Selection median/p95 was 6/17 ms, Ctrl+A reached the next frame in 75 ms, wheel zoom reached two animation frames in 38 ms median / 56 ms maximum, pan in 17/17 ms, and keyboard navigation in 22/29 ms. These are single-run local observations, not cross-machine budgets. They are consistent with prior same-host runs and do not identify a measured regression or justify a broad renderer rewrite. No solver or WASM run was part of this test.

## Reuse inspected imported-library sections (2026-10-25)

`analyzeModelLibraries` now reuses the section names collected during its initial library inspection when resolving section-qualified `.LIB` dependencies. The previous dependency pass rescanned the target library source to list those sections. Parser and dependency output is unchanged; the focused `subcircuit-library` test passes, including the large multi-reference section fixture.

On the documented i7-12700F host, version 15 of `npm run benchmark:performance:quick` measured 1,001 imported libraries referencing a shared 2,000-section library at 179.770 ms median / 351.739 ms p95 before and 133.584 ms / 160.777 ms after. This is a local seven-run benchmark snapshot, not a portable guarantee. TypeScript and `git diff --check` pass; no WASM build, browser suite, or Pages workflow ran.

A fresh seven-run repeat after commit `0c2dae0` measured 123.003 ms median / 128.457 ms p95 for the same case. This is consistent with the first post-change snapshot and remains below the before snapshot; the lower repeat median is not treated as another application speedup. Other quick-benchmark domain p95 results remain below the documented 500 ms target on this host.

## Long connected wire-current animation fixture (2026-10-25)

The quick benchmark now also builds two continuous supply/return wire buses with 5,000 resistor taps and a 5 A current source, for 10,000 two-endpoint wire segments in two connected wire networks. It checks the expected 5 A source-end and 1 mA last-segment currents and verifies that the first 20 visible-wire samples exactly match full-network sampling. On the documented i7-12700F host, connectivity took 40.4 ms median / 64.7 ms p95; full-network sampling took 9.08 / 30.79 ms, while visible-wire sampling took 2.19 / 3.91 ms. This is domain-sampler timing, not browser rendering or frame-paint latency. `npm run benchmark:performance:quick` passes without building/running ngspice WASM.

## Firefox 501-part animation spot check (2026-10-25)

One focused run of the existing 501-part resistor/inductor/transformer fixture passed in Firefox with the local ngspice WASM. All 250 resistor, 225 inductor, and 25 transformer primary/secondary glows changed at the requested sample, and offscreen animation stayed skipped until Fit all. The shared animation callback took 2 ms. The viewport scrub reached its second animation frame in 5 ms; after fitting the full circuit, it reached the second frame in 19 ms. The corresponding Playwright scrub intervals were 48.29 ms in the viewport and 422.92 ms full-canvas, with 31 and 638 DOM mutation records; those intervals include browser automation and, for the full-canvas case, repeated per-component assertions, so they are not application frame latency. Idle and playback RAF medians were both 17.06 ms, with one playback interval above 1.5× median. This single run found no specific renderer bottleneck to optimize and is not a cross-device guarantee. Existing WASM reused; no rebuild or Pages workflow ran.

## Firefox process-role memory attribution (2026-10-25)

The Firefox memory sampler now reports peak process-tree PSS/RSS by inferred Firefox role and records the largest processes in each phase. A focused role-classification test covers browser main, content, GPU, socket, extensions, RDD, utility, and Playwright helper processes. One eight-window million-sample profile passed with the existing WASM runtime and measured 1,000,130 samples, 32 rendered traces, and 154,796,032 bytes of WASM linear memory. During solve/result transfer, the Firefox content-process group peaked at 548.4 MiB PSS / 622.8 MiB RSS; browser main peaked at 461.1 / 569.4 MiB. Startup content processes together peaked at 122.8 / 195.7 MiB across four processes. These are separate process peaks and may occur at different samples. The content process includes both the page and its Web Worker, so this attributes memory to the process hosting ELSim but does not split UI, worker JavaScript, and WASM. Role names are inferred from `/proc` process names/arguments and may vary across Firefox versions. This is one local run, not a stable budget or cross-machine comparison.

## Firefox memory phase attribution repeat (2026-10-25)

`npm run benchmark:browser:memory -- --plot-windows 8 --repeats 3` passed three fresh Firefox runs with the existing local ngspice runtime. Each solved 1,000,130 transient samples and rendered 32 traces across eight windows; the worker reported 154,796,032 bytes (147.6 MiB) of WASM linear-memory capacity in every run. Solver/result-transfer process-tree peaks had medians of 1,052.4 MiB PSS and 1,399.9 MiB RSS, with run ranges of 1,013.3–1,054.9 MiB PSS and 1,360.1–1,400.5 MiB RSS. Plot-validation/interaction peaks had medians of 775.0 MiB PSS and 1,122.7 MiB RSS. One result-validation sample reached 1,012.0 MiB PSS / 1,357.8 MiB RSS while the other two were 669.8 / 1,015.1 MiB and 687.0 / 1,035.5 MiB; the 100 ms sampler and short phase make that phase’s distribution too noisy to summarize as a stable peak. PSS/RSS include Firefox and all descendants, not ELSim-only memory, and Firefox heap APIs were unavailable. This establishes a same-host profile, not a cross-machine budget; next memory investigation needs per-process attribution to separate browser baseline, worker, and solver allocations.

## Reuse connectivity for repeated sheet instances (2026-10-25)

When building the explicit `.save` vectors for hierarchical schematic node voltages, netlisting now caches connectivity by sheet definition. Each instance path still gets its own saved vectors, while repeated instances no longer repeat the same sheet connectivity analysis. A unit regression verifies internal voltage vectors are emitted with distinct paths for two instances of the same nested sheet.

On the documented i7-12700F host, version 15 of `npm run benchmark:performance:quick` measured the 5,000-instance hierarchy netlist at 189.258 ms median / 223.005 ms p95 before the cache. Two post-change snapshots measured 116.218 / 144.215 ms and 118.276 / 142.502 ms. Connectivity was 69.362 / 82.451 ms before and 68.905 / 82.484 ms in the latest run, as expected because root connectivity is unchanged. These are local run snapshots and timings vary; treat them as evidence of reduced work in this case, not a portable performance guarantee. The existing local ngspice runtime was reused; no WASM rebuild or Pages workflow ran.

## Cached animation marker metadata (2026-10-25)

Mounted animated parts now cache the `data-pin` identity for each live polarity marker and the positive/negative role of each capacitor plate. In the 501-part R/L/transformer fixture, this avoids 950 repeated marker-pin attribute reads per sample. The focused capacitor workflow passes, and the benchmark verifies every expected glow plus the checked inductor marker polarities. One run measured a 2 ms shared callback, 467.05 ms full-canvas Playwright scrub, and 638 DOM mutations. The callback measurement remains in the previous 2–3 ms range and full scrub time overlaps earlier runs, so no timing gain is established. No WASM rebuild or Pages workflow ran.

## Animation-only result sampling (2026-10-25)

The shared animation listener now requests only values used by the visible result animation: logic output for gates, current for current-flow indicators, both winding currents for transformers, voltage for resistor/lamp power and capacitor charge, charge when a solved behavioral-Q trace exists, and control state for controlled switches. Interactive hovered/selected readouts retain the full sample. Five Firefox engine regressions for capacitor, logic, transformer, resistor, and lamp animation plus six current-source, switch, and transistor workflows pass. Three repeats of the 501-part mixed R/L/transformer benchmark updated all expected glows and measured shared callback times of 2, 2, and 3 ms, the same rounded range as the preceding run; full-canvas scrub times were 460.05, 463.43, and 457.38 ms with 638 DOM mutation records each. This removes irrelevant trace-reader/state-helper calls by component kind but does not show a measured timing improvement. The callback's millisecond-scale readings are coarse and Playwright scrub time includes browser queries and automation. Existing local runtime reused; no WASM rebuild or Pages workflow ran.

## Logic-output steady-state DOM writes (2026-10-25)

The shared cursor listener now compares each logic gate/inverter's output state, accessible name, lead color, and glow style before changing the DOM. The focused Firefox/ngspice truth-table workflow attaches a `MutationObserver` to all seven output groups and leads, advances exactly one solved sample inside a steady output interval, and verifies zero SVG attribute mutation records; the subsequent truth-table transitions still update the visible and accessible output states. This removes repeated writes for unchanged values, but does not measure paint latency or claim a frame-time gain. TypeScript and the focused workflow pass using the existing local ngspice runtime; no WASM rebuild or Pages workflow ran.

## Firefox full-canvas glow update (2026-10-25)

The 500-resistor scrub fixture starts its voltage source at 1 V, then steps to 5 V, so current stays nonzero and keeps the same direction while its magnitude changes. Resistor/lamp, inductor, and transformer glow filters are now static CSS; solved power/current still drives their SVG opacity. Current polarity marker geometry is also cached by direction rather than magnitude. In a same-host Firefox single-run comparison, full-canvas DOM mutation records fell from 1,011 to 511, with inline `style` writes falling from 500 to zero; the interval to the second `requestAnimationFrame` callback changed from 107 ms to 89 ms. That callback interval is not a direct paint-time or single-frame measure. Full scrub action time changed from 224.69 to 201.20 ms. Single-run timing differences are inconclusive, but removing the 500 style writes and halving mutation records is directly observed. The focused benchmark and Firefox resistor, lamp, inductor, and transformer animation workflows pass. The production build passes at 235.5 KiB startup JS, 14.5 KiB CSS, and 249.9 KiB combined gzip against the existing 239.1/15/254 KiB caps. No WASM rebuild or Pages workflow ran.

### Repeat check

A later Firefox run on the same 501-component/1,001-vector fixture passed with 511 full-canvas mutation records (500 opacity attributes, zero inline style writes), a 204.46 ms Playwright scrub action, and an 89 ms interval to the second `requestAnimationFrame` callback. The repeated interval matches the prior run, while the full action duration differs; this did not establish paint latency or a portable performance budget. Per-part React reconciliation was subsequently replaced by one shared exact-sample listener, as described below. Existing local ngspice assets were reused; no WASM build or Pages workflow ran.

## Shared resistor animation frame update (2026-10-25)

Uninspected animated resistors no longer subscribe individually to cursor changes or rerender their React/SVG subtree per sample. One `CircuitPartLayer` frame listener samples the same component traces and updates each mounted resistor's existing power-glow opacity and current-polarity text in place. Resistor glow geometry stays mounted for every visible animated resistor even when its current sample is unavailable to React; without that geometry, the first benchmark incorrectly showed only two updated glows. The strengthened Firefox benchmark now requires 500 mounted glow nodes and all 500 opacity values to change between the Home/End samples. It also verifies polarity and changing result readouts at the first, middle, and last resistor. Inspected resistor readouts still use the regular sampled React path; other component animations are unchanged. Focused Firefox/ngspice regressions pass for resistor polarity/glow, capacitor charge, and lamp glow. Three Firefox runs recorded 513 full-canvas mutation records each (502 opacity writes), compared with 511 records in the preceding single-run sample; mutation count therefore did not improve. The prior `inputToSecondFrameMs` field measured the interval to the second `requestAnimationFrame` callback, not paint completion or a single frame budget. Its 17, 17, and 18 ms measurements cannot establish that the change missed a 16 ms frame target; the earlier 89 ms value has the same limitation. A new development-only profile measured the shared 500-resistor callback at 1–2 ms across three Firefox runs (timer values are rounded to whole milliseconds). Browser paint and missed-frame behavior still need a direct measurement. The production build passes at 236.0 KiB startup JS, 14.5 KiB CSS, and 250.5 KiB combined gzip within the 239.1/15/254 KiB caps. Existing local ngspice assets were reused; no WASM rebuild or Pages workflow ran.

### Cache mounted resistor nodes

The shared animation listener now resolves visible resistor glow and polarity-marker nodes when the mounted viewport changes, instead of querying the SVG tree on each cursor notification. This removes repeated per-frame DOM searches while preserving all 500 glow updates, polarity, inspected readouts, and offscreen culling. Three fresh Firefox runs recorded 513 mutation records per scrub. Their second-`requestAnimationFrame` intervals were 17, 18, and 16 ms, which is not a direct measurement of paint completion or a single-frame budget. The separate callback profile was 1–2 ms across three runs, with whole-millisecond timer resolution. TypeScript and the production build pass; the existing local ngspice runtime was reused.

### Mixed resistor/inductor animation profile (2026-10-25)

The Firefox mixed fixture contains 250 series resistors and 250 series inductors, plus one source, with 1,001 result vectors and 119 samples. One run changed all 250 resistor and 250 inductor glow values on the full-canvas scrub. It recorded 513 DOM mutations (502 opacity writes), a 2 ms shared listener callback, a 17 ms input-to-second-RAF interval, and a 324.05 ms Playwright scrub action. Idle and playback RAF medians were both 17.06 ms; neither exceeded 1.5× its median. The action and RAF figures are single-run observations, not before/after comparisons, frame-paint measurements, or portable budgets. In particular, 2 ms is callback duration, not render or paint completion. Focused Firefox/ngspice regressions also verify inductor polarity and transformer winding glows. Existing local runtime reused; no WASM build or Pages workflow ran.

### Continuous playback RAF cadence

The Firefox 500-resistor browser benchmark now measures one second of idle RAF cadence and one second while the app's result playback updates the full canvas. Across three same-host runs, idle median intervals were 17.08, 17.04, and 17.06 ms; playback medians were 17.08, 17.04, and 17.04 ms. Playback p95 was 17.14–17.18 ms, and no playback interval exceeded 1.5× its run's median. One idle run had a 33.26 ms outlier; the other idle runs and all playback runs had maximum intervals at or below 17.20 ms. The profiled 500-resistor update callback took 1–2 ms with whole-millisecond timer precision. On this Firefox/i7-12700F setup, the workload did not add a measurable RAF-cadence penalty versus idle. This is a single-host RAF-scheduling comparison, not direct compositor paint timing or a cross-device guarantee. Existing local ngspice assets were reused; no WASM rebuild or Pages workflow ran.

## Firefox live-readout update measurement (2026-10-25)

The 500-component animation benchmark now avoids mounting each component's continuously changing SVG `<title>` unless that component is selected, keyboard-focused, or hovered. Visual animation remains enabled for all visible result-animated parts. On the same local Firefox/i7-12700F setup, DOM mutation records during a full-canvas scrub fell from 4,009 to 3,511 (12.4%); second-frame timing was 176 ms before and 170 ms after. Each value is a single run, and the frame timing does not establish a reliable improvement. The live-readout count stays below 10 for 501 parts and the hovered component still receives its exact current result text. Focused Firefox benchmark and capacitor-charge interaction tests pass using the existing local WASM runtime; no rebuild or Pages workflow ran. This reduces tooltip churn but does not resolve the measured full-canvas animation latency; profiling and further optimization remain open.

## Quick domain benchmark refresh (2026-10-25)

`npm run benchmark:performance:quick` completed with benchmark version 15 on Node 18.20.4, Linux x64, and the documented i7-12700F host. It used two warmups and seven measured runs with `--skip-engine`; no browser, ngspice, WASM build, or Pages workflow ran. The 5,000-part chain measured 44.133 ms connectivity p95 and 61.918 ms netlist p95; the 5,000-part/4,900-wire grid measured 39.670/55.499 ms; and the 5,000-instance hierarchy measured 77.546/133.139 ms. These remain under the existing 500 ms large-circuit working budget.

The million-sample plot reducer returned 902 points at 1.042 ms p95, within the 5 ms target. On the wire-grid fixture, sampling all 4,900 wire networks measured 23.883 ms median, while sampling only the affected visible networks measured 0.035 ms; the existing scoped approach remains important for large schematics. The 1,000-reference/2,000-section library fixture measured 164.543 ms median / 169.461 ms p95. Raw retention experiment values were 47.168 ms median to parse all vectors versus 30.174 ms for the two displayable traces, with the trace-only production parser already avoiding 25.2 MB of arrays. These are local measurements and do not establish browser interaction latency or a cross-device guarantee; they provide no evidence for a broader rewrite.

## Imported model inspection reuse (2026-10-24)

`analyzeModelLibraries` now inspects each library's logical lines and section structure once, then reuses that inspection while collecting cross-library `.FUNC` signatures and parsing the complete libraries. This preserves forward function references and section validation while removing the second full source scan. The version-14 fixture with 1,000 `.LIB` references to a 2,000-section library resolved all references at 162.654 ms median / 167.593 ms p95, compared with 227.982 / 245.979 ms in the immediately preceding same-host baseline (about 29% lower median and 32% lower p95). A second uncontended run confirmed the result. These are local Node timings, not browser or user-visible latency guarantees. All 39 unit groups, TypeScript, and the focused Firefox multi-file section-import workflow passed. No WASM rebuild or Pages run.

Required model-asset traversal now builds include and subcircuit-dependency adjacency indexes once per call instead of rescanning every edge for each visited asset/model. The version-15 quick benchmark follows a 3,000-asset chain across 2,999 includes and 2,999 subcircuit references in 2.082 ms median / 2.938 ms p95, and verifies all 3,000 assets are retained. The deep-chain domain regression, all 39 unit groups, TypeScript, and the focused Firefox multi-file section-import workflow pass. These are local domain timings; browser file-picker latency is not measured.

## Quick domain benchmark refresh (2026-10-24)

`npm run benchmark:performance:quick` completed with version 14 on Node 18.20.4, Linux x64, and the same i7-12700F host described below. It uses two warmups and seven measured runs, skips the optional solver/runtime cases, and does not rebuild WASM. The 5,000-section chain measured 44.223 ms connectivity p95 and 60.042 ms netlist p95; the 5,000-resistor independent-wire grid measured 45.676/60.162 ms. The 5,000-instance repeated hierarchy measured 88.163 ms connectivity and 142.626 ms netlist p95. These all remain under the existing 500 ms large-circuit working budget; timings are local observations, not CI gates.

The one-million-sample plot reducer returned 902 points at 1.005 ms p95, within its 5 ms target. A repeated library-section lookup fixture (1,000 file references resolving against 2,000 sections) measured 227.982 ms median / 245.979 ms p95, with all 1,000 references resolving. This path remains below the broad 500 ms domain budget, and no before/after comparison justifies changing its index implementation. The imported-library parser fixtures also resolved 500 includes across 501 libraries at 19.459 ms p95 and 2,000 repeated device-model references at 13.512 ms p95.

The raw-retention experiment parsed 50,000 samples with 62 hidden vectors: retaining every vector required 26.4 MB of Float64 arrays, while the trace-only parser retained the two displayable voltage/current traces using 1.2 MB. The worker already uses that trace-only parser, so this comparison confirms the existing memory safeguard rather than identifying new savings. No browser, engine, WASM, or Pages workflow ran for this refresh.

This is a reproducible baseline, not a claim that every circuit of the same size has the same cost. The labeled fixture is a chain of 100, 500, 1,000, or 5,000 resistors. Every adjacent pair shares a named net; a 5 V source drives the first node and the final node is ground. The generated project contains `N + 1` parts, `2N + 2` labels, and `N + 1` nets. The runner verifies every pin is connected and netlisting emits no error before recording timings. A second fixture places resistors in 50-column rows and connects adjacent parts with independent two-endpoint wire segments; it checks all pin assignments, endpoint counts, and netlist diagnostics.

### Quick domain repeat (2026-10-24)

A fresh version-14 run on the same i7-12700F host measured 5,000-section chain connectivity/netlisting at 45.398/60.530 ms p95, the independent-wire grid at 41.528/53.967 ms, and 5,000-instance hierarchy at 87.239/145.447 ms. The million-sample plot reducer returned 902 points at 1.053 ms p95. All remain within the documented 500 ms large-circuit working budget and 5 ms reducer target. The 1,000-reference/2,000-section include fixture measured 222.378 ms median / 259.849 ms p95; this remains within the broad budget and provides no before/after evidence for a parser rewrite. Other imported-library p95 values were 18.305 ms for 500 include references, 22.625 ms for 2,000 duplicate-parameter declarations, and 13.210 ms for 2,000 repeated device-model lookups. Seven measured runs followed two warmups. This is a same-host repeat, not a second-machine or browser-memory measurement; no code change was justified by these numbers.

Run `npm run benchmark:performance` from the repository root. It compiles the relevant TypeScript modules into a temporary directory, performs two warmups and seven measured runs for connectivity, netlisting, hierarchy, raw parsing, and structured cloning, reports median and nearest-rank p95, and measures cold and cached plot reduction separately, then removes the temporary build. The plot fixture runs the production extrema reducer over sinusoidal Float64 vectors with narrow injected peaks and enforces a maximum output of 902 points. If the ignored local ngspice WASM runtime exists under `public/engine`, it also runs one cold-worker operating-point solve at each of 100, 1,000, and 5,000 resistor sections, checks that node N0 remains 5 V, and records solver startup, solve, and round-trip observations. It also runs 100k- and 1M-sample transient circuits in fresh workers, parses the raw output with ELSim's production parser, and records raw/vector bytes and 10 ms sampled process RSS. RSS is process-wide and the increase is an estimate relative to the pre-run process baseline; it is not a browser heap or exact per-worker allocation measurement. It does not require the optional runtime for domain/plot measurements and does not modify project files.

## Baseline

Measured on 2026-10-10 with Node 18.20.4, Linux x64, and an Intel Core i7-12700F (20 logical CPUs). Values are milliseconds unless noted.

| Resistor sections | Parts | Labels | Connectivity p95 | Netlist p95 | Netlist bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 101 | 202 | 1.997 | 1.343 | 1,607 |
| 500 | 501 | 1,002 | 5.482 | 4.654 | 8,807 |
| 1,000 | 1,001 | 2,002 | 8.454 | 8.066 | 17,809 |
| 5,000 | 5,001 | 10,002 | 48.196 | 54.436 | 101,809 |

| Input samples | Input bytes (Float64) | Output points | Reducer p95 |
| ---: | ---: | ---: | ---: |
| 100,000 | 800,000 | 901 | 2.816 |
| 1,000,000 | 8,000,000 | 902 | 0.983 |

The optional local ngspice 47 WebAssembly build was available for this run. Solver timings below are a single cold-worker observation per circuit size; parser and Node structured-clone estimates use the repeated-run statistics described above.

### Plot reducer cache-aware measurement

The current benchmark version measures cold downsampling and cached lookup separately. Cold vectors are prepared outside the timed interval so the first reducer pass is measured without including array allocation; each run uses a distinct vector so a previous pass cannot satisfy it from the WeakMap cache. The cached lookup row measures repeated requests for the same immutable vector/range after populating that cache.

| Input samples | Output points | Cold reduction median / p95 (ms) | Cached lookup median / p95 (ms) |
| ---: | ---: | ---: | ---: |
| 100,000 | 901 | 0.139 / 3.463 | 0.001 / 0.003 |
| 1,000,000 | 902 | 1.010 / 1.023 | <0.001 / 0.001 |

Measured 2026-10-14 on the same local Node/Linux/i7-12700F host stated above. The 100k p95 includes a single outlier; these are microbenchmark observations, not browser-frame or CI guarantees. Earlier reducer numbers in the baseline table were recorded by an older benchmark version and should not be compared directly with these cache-separated timings.

| Resistor sections | Module load | OP solve | Worker round trip | Raw bytes | Vector bytes | Raw parse p95 | Clone estimate p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 38.925 | 3.824 | 73.229 | 4,461 | 816 | 0.077 | 0.092 |
| 1,000 | 38.499 | 12.759 | 94.366 | 44,064 | 8,016 | 1.384 | 0.851 |
| 5,000 | 37.200 | 38.794 | 111.656 | 228,064 | 40,016 | 4.785 | 6.840 |

The same run includes actual transient worker measurements. It ran on the hardware/runtime listed above. ngspice produced 3.4% more adaptive samples than requested; the run checks that it meets at least 95% of the requested count and has exactly one voltage trace plus the time axis.

| Requested samples | Solved samples | Final V(out) | ASCII raw bytes | Parsed Float64 vector bytes | Raw parse (ms) | Solve + raw write (ms) | Worker round trip (ms) | RSS baseline / peak / increase |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 103,406 | 1.888 V | 5,473,068 | 1,654,496 | 104.563 | 316.469 | 495.292 | 213 / 305 / 92 MB |
| 1,000,000 | 1,034,006 | 1.888 V | 55,759,475 | 16,544,096 | 912.519 | 3,104.235 | 4,186.766 | 305 / 668 / 363 MB |

The observations sample process RSS every 10 ms and include the Node process, WASM runtime, ASCII raw string, and parsed typed arrays; do not interpret the increase as the incremental cost of vectors alone. The 1M case baseline already includes the preceding 100k run, so these RSS figures are process observations rather than isolated per-size memory costs. The benchmark keeps the raw string and parsed arrays inside the worker and returns only aggregate measurements to avoid duplicating the 55.8 MB raw payload in the parent.

These are one-point operating-point results; vector payload size is small compared with long transient traces. The clone observation uses Node `structuredClone`, not a browser `Worker.postMessage` transfer.

A 64-pixel spatial broadphase now narrows pin/label/segment candidate searches while retaining the exact existing geometry predicates. The measured 5,000-section connectivity p95 fell from 1,373.983 ms to 48.196 ms, and netlist p95 fell from 1,321.016 ms to 54.436 ms; both now meet the 500 ms working target. The 1,000-section measurements also remain within the 75 ms targets. Plot reduction remains bounded in output size. These results are from one local host; compare repeated runs on the same environment and keep numeric/topology checks intact when optimizing.

## Initial local budgets

These are working engineering targets for this fixture, not heterogeneous-CI pass/fail thresholds.

- 1,000-section chain: connectivity p95 at or below 75 ms; netlist p95 at or below 75 ms.
- 5,000-section chain: connectivity and netlist p95 at or below 500 ms.
- One-million-sample plot reduction: p95 at or below 5 ms and at most 902 output points.
- With the local engine present: 5,000-section operating-point solve at or below 100 ms, cold worker round trip at or below 200 ms, raw parsing at or below 10 ms p95, and 40 kB vector clone estimate at or below 10 ms p95.
- All project sizes: preserve every pin-to-net assignment and produce a parseable netlist with no error diagnostics. Performance work must not merge electrical nodes, drop traces, or approximate solver values.

## Not yet measured

The browser editor benchmark below measures reload readiness and click-to-selection completion, but not pointer-to-paint latency, animation update cost, higher trace-count rendering cost, or reliable peak browser/worker memory. The browser transient result is a single RC circuit with five simultaneously selected voltage/current traces; it does not represent higher trace counts or every circuit shape. Record hardware/runtime details before setting browser budgets. The nested hierarchy domain fixture below covers repeated two-level subcircuit instances; browser rendering and simulation performance for large hierarchical schematics remain unmeasured.

## Routed wire-heavy benchmark (2026-10-10)

On the same i7-12700F host, the 5,000-resistor fixture contains 4,900 routed wires and 34,300 segments. Before the wire-heavy measurement, `analyzeConnectivity` mapped each wire to a net by scanning the full segment array once per wire; that quadratic post-processing dominated this case. It now indexes each wire's first segment in one pass, preserving the prior net-selection rule. The 5,000-part connectivity p95 fell from 610.142 ms to 140.081 ms, and netlist p95 from 633.389 ms to 160.567 ms. Pin and net counts are checked at every fixture size; geometry predicates and solver values are unchanged.

| Resistors | Wires | Segments | Nets | Connectivity p95 (ms) | Netlist p95 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 98 | 686 | 102 | 2.845 | 2.180 |
| 500 | 490 | 3,430 | 510 | 9.769 | 7.851 |
| 1,000 | 980 | 6,860 | 1,020 | 20.311 | 16.708 |
| 5,000 | 4,900 | 34,300 | 5,100 | 140.081 | 160.567 |

## Nested hierarchy benchmark (2026-10-10)

The performance runner creates 100, 500, 1,000, or 5,000 instances of a two-level hierarchy. Each root instance connects three pins through labels, and both child-sheet subcircuit definitions must be emitted. The runner checks pin and label counts, required definitions, the final X instance, and absence of error diagnostics before timing connectivity and netlisting. On the same i7-12700F host, the 5,000-instance case has 15,000 root pins and labels; connectivity p95 is 138.603 ms and netlist p95 is 217.649 ms. These domain measurements fit the existing 500 ms large-circuit budget. They do not measure editor rendering, browser memory, or ngspice solve time for this repeated hierarchy.

| Root instances | Root pins | Labels | Nets | Connectivity p95 (ms) | Netlist p95 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 300 | 300 | 103 | 2.513 | 4.321 |
| 500 | 1,500 | 1,500 | 511 | 9.257 | 16.860 |
| 1,000 | 3,000 | 3,000 | 1,021 | 15.935 | 33.289 |
| 5,000 | 15,000 | 15,000 | 5,101 | 138.603 | 217.649 |

### Browser nested hierarchy

The browser performance test opens the project-original two-level divider example, expands its root sheet to 500 instances of the nested block, then reloads the app from the validated `.elsim` project state. All 500 instances share the same named input, output, and ground nets. It verifies the rendered part count, runs the circuit through the actual browser ngspice worker, checks the returned output trace, and fails on page errors.

| Browser | Hierarchy instances | Rendered parts | Editor reload-to-render (ms) | Run-to-result (ms) | Result vectors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 500 | 502 | 655.93 | 421.49 | 1,003 |
| Firefox | 500 | 502 | 698.93 | 781.09 | 1,003 |

These measurements are local single runs and are not budgets. They confirm the repeated two-level hierarchy path works in both browsers at this size; much larger browser schematics, memory, and interactive editing latency remain unmeasured.

### Repeat run (2026-10-10)

I reran the full benchmark on the same i7-12700F host with Node 18.20.4. The 5,000-instance nested hierarchy remained within the 500 ms domain target, with connectivity p95 199.797 ms and netlist p95 430.732 ms. The 5,000-part wire-heavy circuit measured 169.824 ms connectivity and 207.514 ms netlisting p95. Both show meaningful run-to-run variation from the earlier observations, so these are reference observations rather than a claim of a regression or improvement. The 1M-sample plot reducer returned 902 points at 1.1 ms p95.

| Fixture | Size | Connectivity p95 (ms) | Netlist p95 (ms) |
| --- | ---: | ---: | ---: |
| Nested hierarchy | 5,000 instances / 15,000 pins | 199.797 | 430.732 |
| Routed wires | 5,000 resistors / 34,300 segments | 169.824 | 207.514 |

The current 1M-sample solver observation produced 1,034,006 samples and the expected final output (1.888 V), with 55,759,475 bytes of ASCII raw data, 16,544,096 bytes of parsed vectors, 1,127.562 ms raw parsing, and 3,527.138 ms solve/write. Sampled process RSS was 360.9 MB at baseline and 719.0 MB at peak; the baseline includes the preceding 100k run, so this is not an isolated memory cost. This confirms the large-trace pipeline works in the local worker benchmark and keeps memory measurement as an open limitation.

A repeat on 2026-10-12 with the offset-based ASCII raw parser decoded the same 1,034,006-sample, 55,759,475-byte result in 483.156 ms, about 57% below the earlier 1,127.562 ms observation on the same host and benchmark. Solve/write measured 2,976.959 ms in this run; timing varies between runs. After the parser change, the four-window browser benchmark completed in 19.048 s in Firefox and 6.973 s in Chromium, with 16 rendered traces. Immediately preceding runs were 19.030 s / 7.972 s, so Firefox end-to-end time is unchanged and the Chromium difference is a single-run observation rather than a stable gain. Scrub updates were 28.60–35.63 ms in Chromium and 39.93–76.27 ms in Firefox. Main-thread timer gaps peaked at 117.8 ms and 93 ms respectively. Raw parsing is faster, but the Firefox end-to-end solve remains dominated by work outside the UI parser.

The hierarchy generator repeatedly resolved sheet IDs with linear array searches. Replacing those searches with a per-netlist `Map` preserves the same child definitions, ports, diagnostics, and netlist format while avoiding repeated scans. A subsequent run measured the 5,000-instance hierarchy netlist at 298.878 ms p95 versus 430.732 ms immediately before the change; connectivity was 184.198 ms. The netlist observation is about 31% lower, but timings vary between runs (an earlier run measured 217.649 ms), so the benchmark is evidence of a likely improvement rather than a stable guarantee.

### Browser large transient

`npm run benchmark:browser -- --grep "million-sample transient"` runs a 1 s RC transient with a 1 µs maximum step through the actual ngspice browser worker, app response handling, result plot, and time scrubber. It selects up to five available voltage/current traces and requires at least four plotted traces, then checks at least one million solved samples, cursor readout at the last sample, and no page errors. A 16 ms main-thread timer records its largest scheduling gap during the run. `resultReadyMs` covers Run click through the completion notice. Repeated scrub measurements include End → Home → End. The first scrub may include trace setup; later cursor updates reuse memoized SVG trace geometry and do not rescan the sample vectors. These are single local observations, not thresholds.

| Browser | Solved samples | Plotted traces | Result ready (ms) | Scrubs End/Home/End (ms) | Largest main-thread timer gap (ms) | Renderer heap before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1,000,130 | 5 | 7,999.36 | 240.51 / 37.18 / 22.34 | 108 | 26.0 → 26.0 MB |
| Firefox | 1,000,130 | 5 | 20,059.97 | 45.49 / 27.78 / 28.81 | 48 | unavailable |

Cursor-only updates now avoid rebuilding sampled polyline strings; changing traces, visible time range, or value scale still rebuilds affected geometry. Chromium's `performance.memory` numbers cover the page renderer and do not include the dedicated worker. Firefox does not expose that API in this run. With `VITE_ELSIM_PROFILE=1`, the worker temporarily observes WebAssembly module instantiation, retains the exported `memory`, and reports its buffer capacity after the run. This measures the WASM linear-memory capacity/high-water size, not total worker memory, resident physical memory, or browser process RSS. The normal app path does not install the instrumentation. To run the profiled benchmark, use `VITE_ELSIM_PROFILE=1 npm run benchmark:browser -- --grep "million-sample transient" --project=firefox`. A 2026-10-13 Firefox run solved 1,000,130 samples with eight windows and 32 traces: the worker reported 185,794,560 bytes (about 177 MiB) of WASM linear memory; result-ready time was 11,014 ms, and End/Home/End scrubs measured 106.77 / 36.48 / 36.92 ms. Renderer heap remained unavailable in Firefox. These are one-machine, single-run observations, not budgets or total-memory measurements. A 2026-10-12 Firefox profile measured 78 ms module load, 16,177 ms inside ngspice `callMain`, 1,649 ms for raw file reading/parsing and trace preparation, and 17,906 ms total worker time. About 90% of that earlier worker time was in the solver, not ELSim UI code. The runtime was built with `-O2`; an `-O3` A/B build is still needed. The pinned source and current runtime are present locally, but `emcc` is not installed in the current environment.

The profiled Firefox measurement makes WASM heap capacity observable for this workload. Cross-hardware browser measurements, browser-process/worker resident-memory measurement, and larger simultaneous trace/sample workloads remain open.

The maximum-window Firefox profile opens eight waveform windows with four traces each (32 rendered traces), all backed by the same 1,000,130-sample transient. Result-ready time was 19,067.54 ms; End/Home/End scrubs measured 70.52 / 52.23 / 46.91 ms, and the largest 16 ms timer gap was 48 ms. The prior four-window/16-trace profile on this host measured 20,059.97 ms result-ready and scrub times of 45.49 / 27.78 / 28.81 ms. In this single-run comparison, result-ready time was similar while scrub latency rose from 28–45 ms to 47–71 ms as rendered traces doubled; the largest timer gap remained 48 ms. It demonstrates the app renders and navigates eight windows, but does not establish performance budgets or worker-memory usage. The test uses the existing local runtime and does not compile it.

### Connection-dot pin reuse (2026-10-13)

The schematic already memoizes component pin positions for nearby-pin interactions. Connection-dot generation had independently recalculated the same pin locations on every schematic edit. It now receives that cached array and retains the same exact dot coordinates. On the 5,000-resistor/4,900-wire fixture (9,800 dots), the domain benchmark measured 10.361 ms median / 29.885 ms p95 without the cached pins and 8.257 ms / 10.089 ms with them. This measures only the dot-generation call; pin locations are still computed once for the editor and the results are single-host observations, not a UI frame-time claim.

### Floating plot render isolation (2026-10-13)

Each detached waveform window and its `ResultPlot` now memoize against the result, panel, and stable per-window actions. Unrelated schematic/editor state changes keep those plot subtrees from rendering again; changing the plot's result, traces, range, or bounds still updates it. Firefox's 116-case non-engine suite and two focused solver-backed multi-window flows pass. This change has not yet been compared with a controlled before/after browser timing, so no numeric latency or frame-rate improvement is claimed.

Cursor update isolation: transient plots no longer subscribe to the shared simulation cursor in the main `WaveformPlot` component. The moving marker, time label, and selected-value readout subscribe separately, so a scrub does not rerender the plot component and its static controls. One same-host post-change eight-window run measured result-ready at 19,049.07 ms and End/Home/End scrubs at 69.59 / 44.95 / 39.45 ms, versus 19,067.54 ms and 70.52 / 52.23 / 46.91 ms immediately before. These small differences from single runs are inconclusive; repeat runs are needed to assess any timing gain. The DOM still updates all eight cursor markers and readouts, as required for synchronized plots.

### Browser multi-trace transient

The performance Playwright suite builds a 24-resistor DC chain, runs a 10 ms transient through the browser ngspice worker, and uses the returned 49 vectors (24 currents and 25 node voltages) to render 40 traces in the waveform plot. The test requires at least 9,000 solved samples, selects one trace per animation frame so React commits each selection, checks that rendered SVG polylines match the selected traces, and enforces the 902-point maximum per plotted trace. It uses only actual solver output.

| Browser | Solved samples | Available vectors | Plotted traces | Max rendered points/trace | Result ready (ms) | Select/render (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 10,012 | 49 | 40 | 452 | 1,003.87 | 658.70 |
| Firefox | 10,012 | 49 | 40 | 452 | 2,005.67 | 817.00 |

These are single local observations, not release budgets. The rerun after memoizing trace geometry verifies the combined high-trace/high-sample browser workload at this size. Cursor-only changes do not regenerate the polylines. Larger simultaneous sample/trace counts and reliable browser/worker peak-memory measurement remain open.

### Nonlinear high-sample multi-trace browser run

A second fixture uses a pulsed 5 V source to drive 24 parallel 1 kΩ / diode branches. It verifies diode-current and branch-voltage vectors, solves 100,126 transient samples, selects 40 traces, checks that each rendered trace stays within the 902-point display limit, and moves the cursor to the final sample. This exercises a nonlinear device model together with many high-resolution traces rather than extrapolating from the RC-only million-sample case.

| Browser | Diodes | Samples | Available vectors | Plotted traces | Max rendered points/trace | Result ready (ms) | Select/render (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 24 | 100,126 | 74 | 40 | 597 | 6,035 | 2,963 |
| Firefox | 24 | 100,126 | 74 | 40 | 597 | 15,045 | 3,534 |

These are local single-run observations, not budgets. The circuit, engine fixture, point cap, and final cursor interaction passed in both supported browsers. Reliable browser/worker peak-memory measurement remains open.

## Legacy browser editor timing (2026-10-10)

These are results from the v2 Playwright benchmark in `npm run benchmark:browser` (Chromium and Firefox). The generated project contains one resistor and two net labels per component. `editorReadyMs` measures reload through rendered component count; selection timings include Playwright locator lookup, click/actionability work, and the React update. They are local historical measurements, not CI thresholds, and are not directly comparable to the in-browser v3 input-to-frame timings below.

| Browser | Parts | Editor ready (ms) | Selection median (ms) | Selection p95 (ms) | SVG elements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 100 | 296 | 102 | 113 | 1,610 |
| Chromium | 500 | 552 | 170 | 305 | 8,010 |
| Chromium | 1,000 | 789 | 352 | 458 | 16,010 |
| Firefox | 100 | 398 | 87 | 131 | 1,610 |
| Firefox | 500 | 596 | 173 | 240 | 8,010 |
| Firefox | 1,000 | 932 | 305 | 383 | 16,010 |

`CircuitPart` memoizes its SVG subtree and uses stable event wrappers that dispatch to the latest schematic handlers. The older Playwright locator-click measurements show substantial run-to-run variation, so use the input-to-frame comparison below when assessing selection updates. Heap readings from browser automation were inconsistent and are excluded from conclusions. SVG size grows linearly with parts and labels, so the next editor work should profile render cost and consider viewport culling or a canvas layer only if measured data supports it.

### Schematic label selection update (2026-10-10)

`CanvasNetLabel` now memoizes each label's SVG subtree and receives stable event wrappers, so selecting an object no longer rebuilds every label's SVG children. The editor benchmark now dispatches a synthetic click inside the browser and measures through the next animation frame; it excludes Playwright selector lookup and actionability overhead. The same benchmark configuration was run before and after label memoization on this host. This is one run per browser and is an engineering comparison, not a release budget.

| Browser | Parts / labels | Before median / p95 (ms) | After median / p95 (ms) | Median change |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 100 / 200 | 20.2 / 35.3 | 14.9 / 17.0 | -26% |
| Chromium | 500 / 1,000 | 56.5 / 194.9 | 43.2 / 166.5 | -24% |
| Chromium | 1,000 / 2,000 | 107.8 / 235.6 | 79.5 / 207.7 | -26% |
| Firefox | 100 / 200 | 14.0 / 16.0 | 13.0 / 15.0 | -7% |
| Firefox | 500 / 1,000 | 47.0 / 91.0 | 35.0 / 69.0 | -26% |
| Firefox | 1,000 / 2,000 | 92.0 / 142.0 | 77.0 / 106.0 | -16% |

SVG element counts remain unchanged because the complete schematic stays in the DOM for visibility and keyboard access. This change lowers selection update cost but does not solve first-render cost or very large-circuit accessibility/performance; those remain open.

### Routed-wire selection update (2026-10-10)

`CanvasWire` now memoizes each wire's SVG subtree, while its event handlers stay current through stable wrappers. Selection changes no longer rebuild every wire path or recalculate segment-drag hit regions. A new Playwright benchmark loads 1,000 resistors and 1,200 three-point wire paths, then measures synthetic part selection through the next animation frame. A controlled run used the same test and host against the committed renderer and the memoized renderer; each value below is a single local run, not a release budget.

| Browser | Renderer | Selection median / max-of-7 (ms) | Editor render (ms) |
| --- | --- | ---: | ---: |
| Chromium | Before | 1,261 / 1,290 | 4,256 |
| Chromium | After | 67 / 242 | 2,046 |
| Firefox | Before | 2,054 / 2,104 | 6,775 |
| Firefox | After | 57 / 70 | 2,891 |

The comparison shows much lower selection latency for this wire-heavy case. The max-of-seven value is noisy and the initial-render timing is not attributed to memoization. All wire paths remain in the SVG with their existing button role, keyboard selection, probing, and segment-drag behavior.


### 5,000-part browser schematic (2026-10-11)

The editor benchmark opens a 5,000-resistor schematic with 10,000 net labels and measures synthetic selection input through the next animation frame. This isolates UI update work from Playwright locator/actionability time. Every part remains a focusable named control; net-label controls are rendered only when their text intersects the visible view plus a 30-unit margin, while the selected label remains mounted during pan. Labels outside the view return when navigation brings them onscreen. Component symbol details are also drawn only within the visible view plus a margin; offscreen parts keep their accessible control and hit target.

| Browser | Parts | Editor ready (ms) | Selection median progression (ms) | Selection max-of-5 progression (ms) | SVG elements progression | Detailed parts in view |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 5,000 | 3,498 → 3,442 → 2,534 | 531.7 → 365.2 → 221.8 → 142.1 | 378.3 → 244.8 → 150.6 | 80,010 → 55,370 | 72 |
| Firefox | 5,000 | 4,001 → 4,165 → 3,152 | 308 → 74 → 15.0 → 14.0 | 76 → 30.0 → 18.0 | 80,010 → 55,370 | 72 |

`CircuitPartLayer` memoizes the part list across selection-only updates; individual parts subscribe to a small external selection/focus store. `CanvasNetLabelLayer` skips rebuilding 10,000 labels when component selection changes. The latest change renders full symbol artwork only near the viewport while retaining every offscreen part as a named focusable control and keeping its hit target; imported symbols always retain their full artwork. A same-host run changed the 5,000-part editor load from 3.44 to 2.53 s in Chromium and 4.17 to 3.15 s in Firefox. Selection median changed from 221.8 to 142.1 ms in Chromium and 15 to 14 ms in Firefox. The SVG shrank from 80,010 to 55,370 elements while all parts and labels remained present; 72 parts had full artwork in the initial view. Chromium selection still exceeds a 16 ms frame. These measurements are local observations, not release budgets. Browser heap metrics are omitted because available readings did not vary reliably with project size.

The latest label-rendering change replaces each label's separate transparent rectangle, leader line, and text element with a single SVG text node using a wide transparent stroke for hit testing. The visible label remains clickable, selectable, and keyboard accessible; its focus indicator now outlines the text. This reduces 5,000-part SVG element count from 55,370 to 35,370.

| Browser | Editor ready before / after (ms) | Selection median before / after (ms) | SVG elements before / after |
| --- | ---: | ---: | ---: |
| Chromium | 2,519.2 / 2,102.9 | 143.5 / 138.1 | 55,370 / 35,370 |
| Firefox | 3,152 / 2,681 | 15 / 15 | 55,370 / 35,370 |

These values are local single-run measurements from the same large-project benchmark and host, not release budgets. The primary gain is a smaller SVG and faster initial editor load; selection update time changes little because the remaining cost is elsewhere in the schematic.

The 2026-10-11 repeat run found a duplicate accessible-name `<title>` inside compact offscreen component controls: each control already exposes the same text through `aria-label`. Removing that duplicate retained the focusable named control and hit target and reduced the 5,000-part DOM by 4,928 SVG elements. Timing changes stayed within the run-to-run noise. This is a same-session before/after run, not a controlled release benchmark.

| Browser | Parts | Editor ready (ms) | Selection median / p95 (ms) | SVG elements before / after |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 5,000 | 2,068.9 / 2,020.1 | 142.3 / 151.6 → 133.0 / 147.1 | 35,370 / 30,442 |
| Firefox | 5,000 | 2,699.3 / 2,645.1 | 15.0 / 18.0 → 16.0 / 22.0 | 35,370 / 30,442 |

The Chromium selection result varied between 133.0 and 147.1 ms before label culling, so that step alone was not evidence of a selection-speed improvement. Viewport label culling was then measured locally in Chromium: at 5,000 parts, only 120 of 10,000 labels were mounted, SVG elements fell from 30,442 to 10,682, editor-ready measured 1,166 ms, and selection input-to-next-frame measured 42.8 ms median / 44.4 ms p95.

The selection path now updates the selected/focusable part controls immediately through the external store and schedules the inspector/app selection state at transition priority. This preserves a responsive canvas highlight while moving the larger application render out of the urgent input lane. The 5,000-part Chromium benchmark measured 7.7 ms median / 8.1 ms p95 input-to-next-frame; Firefox measured 3 ms / 4 ms. Editor-ready measured 1,157 ms in Chromium and 1,622 ms in Firefox, with 10,682 SVG elements and 120 mounted labels in both. Focused keyboard navigation, inspector update, visible-label selection, and group-edit tests pass. These are local single-run observations, not release budgets; repeatability and broader interaction coverage remain necessary.

### Repeatability run (2026-10-11)

The 5,000-part editor benchmark ran three independent times in each supported browser on the same Linux host (12th Gen Intel Core i7-12700F, 20 logical CPUs, 16 GiB RAM). Each run reloaded a fresh page and measured five separate selection updates; the reported per-run p95 is the maximum of those five samples.

| Browser | Editor-ready range (ms) | Selection median range (ms) | Selection max-of-5 range (ms) | Mounted labels | SVG elements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1,144–1,184 | 7.9–8.1 | 8.1–8.9 | 120 / 10,000 | 10,682 |
| Firefox | 1,638–1,656 | 3 | 4 | 120 / 10,000 | 10,682 |

All six runs passed. This supports run-to-run stability on this host only; it does not establish performance across other hardware. Firefox does not expose the performance.memory fields used by this benchmark, and Chromium's page-heap readings do not include the ngspice worker's WebAssembly linear memory. Browser/worker peak-memory measurement and an additional hardware baseline remain open.

A test-only probe also tried Chromium's `performance.measureUserAgentSpecificMemory()` under a local cross-origin-isolated Vite server (`crossOriginIsolated === true`) with experimental web-platform features enabled. The property existed, but every call rejected with “performance.measureUserAgentSpecificMemory is not available.” The probe configuration was removed; it did not change production response headers. This browser build therefore provides no usable user-agent memory estimate for the page/worker workload, so worker peak memory remains unmeasured.

### Browser waveform transport check

The worker now shares one parsed axis across all traces and transfers unique axis/value buffers to the UI, avoiding per-trace axis copies and a structured-clone copy of result vectors. The UI validates shared typed vectors once per response. A Playwright `MessageChannel` check used six 100,000-sample traces (5.6 MB total including one shared axis); both clone and transfer preserved values and shared-axis identity, and transfer detached the sender buffers as expected.

| Browser | Clone round trip (ms) | Transfer round trip (ms) | Payload |
| --- | ---: | ---: | ---: |
| Chromium | 3.90 | 0.20 | 5.6 MB |
| Firefox | 2.00 | 3.00 | 5.6 MB |

These small-payload timings vary by browser and are not budgets. Transfer’s consistent benefit is avoiding the waveform buffer copy and reducing peak duplicate memory; large end-to-end engine-worker runs remain to be measured.

### Viewport-aware component animation (2026-10-11)

Schematic result lookup now builds a case-insensitive trace index once per result instead of scanning the full vector list for each component. Cursor-linked voltage/current props are supplied only to components within the visible world-space viewport plus a 100-unit symbol margin. Offscreen components stay in the SVG for editing and keyboard access; changing the simulation cursor while they are offscreen leaves their React props unchanged. When the user pans or fits them into view, they receive the current solved sample. `fitEditorView` now computes pan offsets using the same sign convention as the SVG viewBox, so Fit all centers the actual content.

The browser benchmark creates 500 non-overlapping series resistors plus one source, solves 1,001 vectors over 116 transient samples, scrubs from the first to last sample, then uses Fit all to reveal an offscreen resistor. Both browsers showed 25 animated components in the initial viewport and all 501 after fitting; the offscreen resistor's latest voltage/current readout appeared on reveal. A controlled Chromium run without viewport culling measured 602 ms for the Playwright slider action/readout update; with culling the same test measured 486 ms (about 19% lower). A Firefox post-change run measured 370 ms. These are single local observations that include Playwright interaction timing, not release budgets; see the `browser-500-component-animation-scrub-v2` test in `tests/e2e/performance-benchmark.spec.ts`.

Playback subscription isolation (2026-10-12): the Schematic component no longer subscribes to each cursor tick. Visible animated parts subscribe individually, while wire-flow rendering subscribes in its own overlay; static wire paths and the parent schematic do not rebuild just because playback advances. The Firefox benchmark was updated for the current plot-window UI and made deterministic by waiting for the starter project to finish loading before seeding its fixture. On the same host, two runs on parent `8d932f2` measured 62.17 and 54.23 ms for the Home/End scrub-and-readout update (58.20 ms median); two runs on `29fa241` measured 49.10 and 55.98 ms (52.54 ms median), about 9.7% lower. Each run used 501 parts, 1,001 vectors, 116 samples, 19 visible animated components, and verified all 501 animate after Fit all. This small, non-interleaved comparison is suggestive rather than conclusive and is not a performance budget.

Visible wire-flow sampling (2026-10-12): the sampler maps wire edges and component pins to their ideal-wire connected component once when the project/result topology changes. On each cursor sample it now reads device currents and resolves flows only for graph components that contain currently visible wire IDs. The 5,000-resistor/4,900-wire fixture requested 20 wires; three timed runs measured 25.083 ms median / 29.927 ms p95 when sampling every network and 0.225 ms median / 25.243 ms p95 when sampling visible networks. The p95 is one startup outlier in this three-run microbenchmark; compare medians cautiously. Per-wire current flow matched the all-network result exactly, and the grounded-return and parallel-current Firefox workflows pass. This saves work when a large project has many separate wire networks; a single large visible network still requires resolving all of its branches.

Connection-dot broadphase (2026-10-12): connection-dot geometry used to compare every component pin and wire endpoint with every wire segment. It now indexes segments in 64-unit spatial cells and retains the exact segment and pin-distance checks, with a fallback for segments spanning many cells. The 5,000-resistor/4,900-wire endpoint fixture produced the same 9,800 dots as the prior brute-force predicates; seven local runs measured 16.035 ms median / 41.183 ms max (reported as a seven-sample p95). This is a single-host observation, not a budget. The unit regression compares both algorithms on pin attachments, T joins, unconnected crossings, and a long-segment fallback case.

### Current-model endpoint-wire benchmark (2026-10-12)

The wire-heavy fixture now uses the same independent two-endpoint segments as the editor and project format. This replaces the retired multi-point path fixture, which overstated wire segments and no longer represented circuits users can create. On the same i7-12700F host, the 5,000-resistor case contains 4,900 wires and exactly 4,900 segments; connectivity measured 35.640 ms median / 47.613 ms p95 and netlisting measured 41.502 ms median / 59.238 ms p95. The 1,000-resistor case measured 5.561 / 5.841 ms connectivity and 7.077 / 7.600 ms netlisting (median / p95). The runner asserts every benchmark wire contains exactly two endpoints. The optional local ngspice build also ran successfully: the 5,000-section operating point retained N0 = 5 V, and the 1M-sample transient produced 1,034,006 samples and V(out) = 1.888 V. No runtime was rebuilt for this benchmark.

### Circuit Checks label-index benchmark (2026-10-12)

The performance runner now measures `checkCircuit` on the resistor chain, endpoint-wire grid, and repeated two-level hierarchy fixtures. It records the resulting issue count alongside median/p95 timing so timing changes remain paired with diagnostic coverage. Initial measurements found repeated linear scans through all labels for every net and wire: on this i7-12700F / Node 18.20.4 host, Circuit Checks took 264.315 ms p95 for a 5,000-resistor chain and 464.178 ms p95 for 5,000 repeated hierarchy instances.

The checker now builds one trimmed label-name `Set` per sheet and uses constant-time lookups for orphan wires and floating terminals. This preserves the prior exact, case-sensitive label matching and does not change solver values or connectivity.

| Fixture | Parts/instances | Before p95 (ms) | After p95 (ms) | Issues before/after |
| --- | ---: | ---: | ---: | ---: |
| Named-net resistor chain | 5,001 | 264.315 | 54.557 | 0 / 0 |
| Two-endpoint wire grid | 5,000 | 63.628 | 59.585 | 201 / 201 |
| Repeated two-level hierarchy | 5,000 | 464.178 | 163.325 | 4,900 / 4,900 |

The repeated hierarchy result is about 65% lower and the named-net chain about 79% lower in this pair of observations. Timings vary by run and are not CI budgets. All existing electrical-check regressions passed after the change.

### Firefox large-editor measurement (2026-10-12)

The Firefox editor benchmark now waits for the starter project to persist before using it as the generated-project fixture; this fixes a race that made the benchmark fail before collecting data. One local run on the i7-12700F host measured:

| Parts | Editor ready (ms) | Single-selection median / p95 (ms) | SVG elements | Detailed parts |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 378 | 11 / 15 | 559 | 36 |
| 500 | 432 | 5 / 7 | 1,601 | 64 |
| 1,000 | 527 | 6 / 14 | 2,601 | 64 |
| 5,000 | 1,175 | 17 / 21 | 10,601 | 64 |

The generated schematic has twice as many net labels as parts. At 5,000 parts, only 64 components retain detailed SVG artwork and 105 labels render, while every component remains in the DOM for accessible selection. Firefox does not expose the benchmark's Chromium-only JS heap readings. These are single-run observations, not budgets.

After replacing selected-ID array scans with `Set` lookups and keeping only visible plus currently focused labels mounted, the same Firefox benchmark measured Ctrl+A selection across 5,000 components and 10,000 labels at 190 ms through the next animation frame. The post-selection SVG still mounted 105 labels. This is one run and has no comparable pre-change Ctrl+A baseline; the change removes quadratic membership scans and avoids mounting 10,000 offscreen label controls at once.

The wire-heavy fixture now uses 1,000 parts and 1,200 independent two-endpoint segments, matching the current document model. In Firefox, editor render was 1,444.58 ms, single-part selection was 32 ms median / 42 ms p95, and Ctrl+A selected 1,000 parts plus 1,200 wires in 125 ms through the next animation frame. The test asserts that all parts and wire segments become selected. This is one local run, not a budget.

Large-sheet SVG viewport culling (2026-10-12): the editor mounts only wire segments overlapping the visible world-space bounds and component symbols inside those bounds plus their existing detail margin. Selection remains in project state for offscreen items, and the currently focused wire/component stays mounted; keyboard spatial navigation pans to its target before focusing it. Wire-current overlay work also follows the visible set. In all four runs of the 5,000-part/4,900-wire fixture, the initial view mounted 64 parts and 580 wires. Two Chromium runs measured 993/998 ms initial render, 23.2/20.5 ms median and 134.1/131.8 ms max-of-seven for wheel event to two animation frames; two Firefox runs measured 1,162/1,192 ms render, with the latest corrected measurement at 47 ms median / 74 ms max-of-five effective wheel samples. The latest Firefox run measured 27/37 ms single-selection median/max-of-five and 155 ms Ctrl+A to the next frame. Fit all reveals additional offscreen components, and a focused Firefox/ngspice regression verifies remote wire flows return with correct 5 mA direction/magnitude and are culled again after zooming in. The earlier v5 zoom numbers started/stopped timing in the Playwright process and included browser-tool round trips; those are not comparable to the v6 in-browser wheel-event measurements and should not be used as app-latency estimates. These observations share one host and are not release budgets or cross-hardware comparisons. A second-machine run and reliable browser/worker peak-memory measurement remain open.

### Large mixed-selection movement (2026-10-12)

The production `moveSelectedSceneObjects` operation now builds movement maps from the immutable drag-start selection and applies them in one pass over the scene arrays. This avoids searching the full part/wire/label arrays once for each selected object on each pointer move. The performance runner calls this exact helper on the 5,000-resistor/4,900-wire fixture with every part and wire selected; seven local runs measured 1.146 ms median / 2.383 ms p95 on the i7-12700F / Node 18.20.4 host. The check confirms selected coordinates move by one grid step and the source project remains unchanged. This domain timing excludes React rendering, browser input dispatch, persistence, and the separate label array; it is not an end-to-end UI budget.

The browser path now previews a large mixed-selection drag by applying temporary transforms directly to visible selected SVG objects, without reparenting nodes or committing project state on pointer movement. Offscreen selected objects move in the single project update when the pointer is released. In a 5,000-part / 10,000-label Firefox fixture, a drag of all 15,000 selected objects measured 49 ms from pointer dispatch to the next animation frame; project coordinates remained unchanged during preview and all selected parts and labels moved after release. A prior measurement of the same interaction with project/React updates on each pointer move was 428 ms. Both are single local observations on the i7-12700F host, not budgets. The focused Firefox tests for group selection, mixed component/wire/label movement, and the large drag pass. The benchmark checks the visible object's actual SVG transform as well as the committed result.

### Memoized-connectivity Circuit Checks path (2026-10-12)

The editor computes connectivity in its own memoized selector and passes that result to `checkCircuit`. The performance runner now reports both that production call and the standalone form that computes connectivity internally. On this i7-12700F / Node 18.20.4 host, the memoized path p95 was 6.841 ms for a 5,001-part named-net chain, 13.824 ms for a 5,000-resistor wire grid, and 20.824 ms for 5,000 instances of the repeated two-level hierarchy. The standalone p95 was 57.425, 62.619, and 163.777 ms respectively. Both paths returned identical issue counts (0, 201, and 4,900). The benchmark is observational; it does not establish cross-machine budgets.

### Binary ngspice results (2026-10-12)

The simulation worker now asks ngspice to write binary raw files and parses the point-major `Float64` payload directly, avoiding UTF-8 expansion and per-number text parsing. `npm run benchmark:performance` reuses the existing ignored `public/engine` runtime; it does not build WASM. On the documented i7-12700F / Node 18.20.4 host, the 1,034,006-sample transient result fell from 55.8 MB ASCII to 16.5 MB binary, and parser time from 476 ms to 17 ms (about 96% lower). Sampled process RSS increase fell from about 237 MB to 127 MB (about 47% lower); this is process-level, sampled memory and not an isolated worker allocation. The solver/write time remained about 2.42 s, so this change targets result transport and parsing rather than circuit solve time. Real binary transient, operating-point, AC, DC-sweep, and noise outputs parsed successfully with the pinned local WASM runtime. `npm run typecheck`, all 28 unit groups, and the full local performance benchmark pass. The Firefox Playwright engine run could not start its Vite server in this restricted workspace (`listen EPERM`); no WASM rebuild or hosted workflow was run.

Worker-memory API check (2026-10-12): The existing local Emscripten wrapper exposes `FS` and `callMain` but keeps its WebAssembly memory handle private; its returned module object has no `HEAPU8` or `wasmMemory` property. A probe through the browser worker therefore failed before simulation and was removed. The `.wasm` binary declares a memory export internally, but the current generated JavaScript wrapper does not return it. Measuring the browser worker's WASM linear-memory capacity requires adding an explicit memory export to the local Emscripten build and rebuilding that runtime; process RSS and page heap remain distinct, less-specific measurements. No memory figure was inferred from this probe.


### Transient saved-window comparison (2026-10-12)

The benchmark now compares a 100 ms transient with full result saving against the same solve using ngspice `tstart=50 ms`. The full run retained 103,406 samples (1,654,750 raw bytes; 1,654,496 parsed vector bytes). The 50 ms window retained 51,701 samples (827,469 raw bytes; 827,216 parsed vector bytes), reductions of 50.00%, 49.99%, and 50.00%, respectively. Both runs ended at 1.887709 V on V(out), within the benchmark's exact-value parity check. This indicates lower saved-result and parser/transfer payload; it does not show reduced solver work or establish browser-memory reduction. The benchmark reused the existing ignored ngspice WASM and made no engine build.


### Eight-window Firefox cursor refresh (2026-10-12)

Two independent runs of the focused Firefox browser benchmark solved 1,000,130 transient samples and rendered eight windows with four traces each (32 SVG traces). Result-ready time was 9.99 s and 10.08 s. The three scripted cursor updates measured 100.89/95.00/32.04 ms and 97.02/85.24/31.03 ms; the final warmed update was consistently about 31–32 ms, while the first two were 85–101 ms. The 16 ms timer observed maximum interval delays of 101–104 ms during the full solve-and-render workflow. Firefox did not expose the heap metric used by this test, so no heap or worker-memory value is available. These runs verify responsive cursor updates after loading the large result, but do not establish a before/after rendering gain; the earlier 16-trace and eight-window measurements are not a clean directly comparable baseline. The test reused the local WASM runtime; no build was run.


### Shared-axis cursor readout fast path (2026-10-12)

Worker-produced traces all reference the same immutable axis array. Transient cursor readouts now use the selected cursor index directly when that shared-array identity is present, retaining binary-search fallback for independently supplied traces on a different axis. TypeScript checking and the focused Firefox million-sample/eight-window benchmark pass after the change. The latest warmed scrub was 31.02 ms versus 31.03 and 32.04 ms in the two immediately preceding runs; that difference is within run noise and is not evidence of a measurable user-visible speedup. The branch removes redundant per-trace binary searches, but the larger cursor/rendering comparison remains open. No WASM build was run.

### Playback sample lookup (2026-10-13)

Scaled and real-time playback now build one sample lookup when playback starts instead of repeating the same full-axis binary search code in each animation mode. The lookup estimates an index from the run's first/last times, checks a small nearby bracket, and falls back to exact binary search when adaptive steps exceed the bracket. Unit tests compare it against a nearest-sample reference for uniform, cubic-adaptive, and strongly nonuniform axes. A synthetic one-million-sample uniform axis with 500,000 lookups measured 35.73 ms median for the previous full binary search and 16.40 ms median for the bracketed lookup across five runs. This is a local microbenchmark, not an end-to-end browser playback measurement. The focused Firefox playback workflow could not run because the configured Vite server was denied local port binding; no WASM rebuild was performed.

Adding a ground-voltage probe to a swept result also now indexes the first trace per sweep case with a `Set`, avoiding the previous nested-prefix scan. It preserves one `V(0)` trace for each unique sweep index (including the unstepped case) and is linear in result-trace count; no end-to-end timing claim is made.


### Large-schematic zoom latency (2026-10-12)

Firefox on the documented i7-12700F host measured pointer-wheel zoom on a 5,000-part / 10,000-label schematic through two animation frames. Before viewport-state isolation, median/p95 were 148/175 ms. Live zoom and pan state now updates inside the schematic; the view is committed to the project after 200 ms of inactivity, and its pending value is included in project export and autosave. One same-host run after the change measured 17/40 ms median/p95, an 88% median and 77% p95 reduction. The focused Firefox regression checks wheel zoom and middle-button pan, waits for persistence, reloads, and verifies the restored viewBox. Typecheck and the focused browser regression pass. This is one before/after pair, not a release budget; a full build or WASM rebuild was not run.

### Visible-wire current sampling (2026-10-12)

The wire-flow sampler now resolves a stable visible-wire set to its wire objects and connected graph components once, then reuses that selection on subsequent cursor samples. Current injections and branch flow magnitudes are still recalculated per sample. On the 5,000-resistor/4,900-wire fixture, the quick domain benchmark measured 0.037 ms median / 0.055 ms p95 with the stable visible set, versus 0.041 / 0.062 ms when rebuilding the same 20-wire set before each sample; a full-network sample measured 26.766 / 26.879 ms. This is one local run; the stable-set delta is small and is not a cross-machine or browser frame-time claim. `npm run benchmark:performance:quick` runs the domain, hierarchy, plot, and wire benchmarks without ngspice solver or memory workloads; the full benchmark remains available for engine measurements.

### Indexed schematic wire culling (2026-10-12)

Viewport queries now reuse a 256-unit spatial hash built when the wire array changes. For 4,900 independent segments and a 1,600 × 1,000 world-space viewport containing 25 wires, two quick-benchmark runs measured indexed queries at 0.021 ms median both times; full scans measured 0.095 and 0.073 ms. Building the index measured 2.147 ms median in the second run, so the benefit applies to repeated pan/zoom queries rather than the initial build or a single query. These are local Node measurements, not browser frame-time claims; max-of-seven values had outliers. Exact intersection checks preserve membership and z-order, while long-wire and very-large-viewport fallbacks are covered by the geometry regression. The focused Firefox large-schematic workflow passes, mounting 64 parts and 580 wires; its single render observation was 1,227 ms and is not a directly comparable before/after measurement.

The same bounded-object index now drives component and net-label culling. On the 5,000-resistor fixture, component queries returned the same 36 visible parts in original order; a quick benchmark measured 0.016 ms median query versus 0.128 ms full scan, with 1.64 ms median index construction. A focused Firefox workflow with 5,000 components and 10,000 labels mounted 64 parts and 105 labels after select-all, completed the scenario in 829 ms, measured select-all at 40 ms to two frames, and passed its zoom and mixed-selection drag checks. This is a single local observation, not a comparable before/after claim. Browser heap metrics remain unavailable in Firefox.

### Large-schematic keyboard navigation (2026-10-12)

Directional component navigation now finds the nearest target in one pass, preserving the prior distance ranking and stable tie order without allocating or sorting a filtered component list. The selection update shares the editor's urgent SVG-state / transition-priority inspector path and clears stale wire/label selection. The focused Firefox 5,000-part wire fixture verifies focus moves to the next component and measured 42 ms from arrow-key dispatch through two animation frames in the normal viewport. This single observation includes React updates and is not a before/after comparison or release budget.

### View-only editor updates (2026-10-12)

Connectivity, electrical diagnostics, and analysis-setting validation now retain their memoized results when only pan/zoom state changes. The 5,000-part Firefox browser benchmark recorded 21 ms median / 23 ms max zoom input-to-two-frames, 38 ms select-all input-to-frame, and 29 ms full-selection-drag input-to-frame. This is a single local run without a before/after comparison; it does not establish a performance budget. The focused circuit-check workflow passes after fitting the schematic before focusing an off-screen component.

### Viewport-culling wire connection dots (2026-10-12)

Connection-dot coordinates are indexed when wire geometry changes and the SVG layer renders only dots intersecting the visible world-space viewport (including an 8-unit edge margin). This removes offscreen dot circles from the DOM while preserving dots for visible wire joins and component pins. The quick benchmark calculated 9,800 candidate points in 15.221 ms median / 37.229 ms p95, but it does not measure SVG mounting or browser frame time; no UI speedup is claimed from that domain measurement. Focused Firefox coverage verifies a remote pin-connection dot is culled and returns after Fit All. Typecheck, all 28 unit groups, and production build passed; no WASM build was run.

### Viewport-culling junction markers (2026-10-12)

Junction SVG groups now use a memoized point index and render only markers in the world-space viewport, with a 6-unit margin matching the marker radius. A focused Firefox regression checks that an offscreen marker is omitted and returns after Fit All; it passes alongside the connection-dot culling regression. The domain test suite, TypeScript check, and production build pass. No SVG frame-time comparison is available yet, so no rendering speedup is claimed.

### Large selection clipboard indexing (2026-10-12)

Selected-part clipboard creation previously checked every selected pin against every wire, then checked every copied junction against every copied wire. It now queries the existing wire spatial index at each selected pin and copied junction, retaining the exact point-on-segment checks and original wire order. A local stress run with 5,000 selected resistors and 4,999 endpoint wires retained every wire and measured 16.63 ms median / 36.07 ms max across nine runs. This is a single-host current measurement, not a before/after claim or budget. The Firefox full-circuit copy/paste test confirms the selection includes all newly pasted wires and no source wire IDs; the test waits for the debounced project save before inspecting local storage.

### Junction cleanup on wire deletion (2026-10-12)

Wire deletion used to rescan every remaining segment for each explicit junction. It now queries a single wire spatial index and keeps the same exact segment predicate, retaining a junction only when at least two remaining segments meet there. A local fixture with 5,000 wires and 2,500 junctions retained all 2,500 junctions at 3.84 ms median / 13.59 ms max across nine runs. This is a current single-host measurement, not a before/after claim or budget. Unit coverage verifies both preserved multi-segment junctions and removal of junctions after their crossing wires are deleted.

### On-demand project archive code (2026-10-12)

Portable project ZIP creation/parsing was moved from the initial App import into the explicit save/open handlers. The production build now emits a 6.36 KB (2.45 KB gzip) `projectArchive` chunk and reduces initial JavaScript transfer from 223.1 to 221.1 KiB gzip on the existing build budget report. The main application chunk remains 582.12 KB minified and still triggers Vite’s 500 KB warning. Firefox save-with-provenance and open-project workflows pass. This change is a measured 2.0 KiB initial-transfer reduction; it does not claim a meaningful startup-time change.

### Large wire selection membership checks (2026-10-12)

The editor now memoizes project wire IDs as a `Set` and filters selected IDs against it, replacing a repeated array search that could compare each selected wire against the entire project wire list. Ordering and stale-ID cleanup behavior are unchanged. Firefox Ctrl+A selection and multi-wire group-move regressions pass; no standalone timing comparison is claimed.

### Immutable undo history snapshots (2026-10-12)

Undo history now retains prior immutable `Project` roots by reference. Normal edits no longer clone every active part, wire, and label, and grouped gestures no longer `structuredClone` the full project at pointer-down; unchanged arrays and sheet subtrees are shared between history entries. A local 5,000-part/4,999-wire object fixture measured the removed full `structuredClone` at 11.28 ms median / 12.43 ms max and the old active-array snapshot at 0.50 / 0.91 ms across nine runs. The new path stores the existing root reference. This measurement is a Node microbenchmark, not a browser latency or memory claim. Firefox verifies property edit, wire endpoint, and child-sheet undo/redo; the full 43-case Firefox UI smoke suite and production build pass.


### Shared simulation run snapshots (2026-10-12)

Starting a simulation now keeps the current immutable `Project` root as its run snapshot instead of calling `structuredClone` on the entire project. Netlist generation and sweep preparation read project data, and the worker message boundary serializes the simulation payload; this removes the extra main-thread project copy before those steps. The 5,000-part/4,999-wire fixture's removed full-project clone measured 11.28 ms median / 12.43 ms max in the existing nine-run Node microbenchmark. This is not a direct measurement of simulation startup latency or browser peak memory. Firefox verifies the starter circuit run and all eight cases of a three-parameter sweep with the local engine. No WASM rebuild was performed.


### Large clipboard paste assembly (2026-10-12)

Paste builds cloned parts in one local array and assigns new references from a prebuilt case-insensitive set, with a next-index cursor per SPICE prefix. This removes both repeated array copies and rebuilding/scanning the full reference set for every pasted part. A Node microbenchmark with 5,000 existing resistors and 5,000 pasted resistors measured the previous array-plus-`nextRef` loop at 3,641.27 ms median / 3,687.09 ms max, versus 2.94 ms median / 3.51 ms max for one reference set plus append (three versus five runs). This isolates array and reference allocation; it is not an end-to-end browser paste measurement. The focused Firefox full-circuit regression confirms every pasted component has a unique reference, every newly pasted component and wire is selected, and no original wire is selected. The earlier array-only microbenchmark is superseded by this combined measurement.

### Connection-dot viewport index (2026-10-13)

The 4,900-wire fixture produces 9,800 wire connection dots. The rendering path previously copied each point into an object with a generated ID, then built the general object viewport index (including per-object ID and bounds maps). A point-specialized index retains point coordinates directly and only generates SVG keys for visible points. In one same-host Node benchmark run, building the old generic index took 3.832 ms median / 5.383 ms p95, versus 1.453 ms / 2.305 ms for the specialized point index. Query time was similar (0.018 ms versus 0.021 ms median), with identical 45 visible points and source order on the 1,600-by-1,000 viewport. This measures index setup/query, not end-to-end frame time. A later run with redundant pin/wire endpoint checks skipped at already-confirmed dot coordinates measured derivation at 13.068 ms median / 33.284 ms p95; its earlier separate observation was 15.755 ms / 36.030 ms. These separate runs are not a controlled before/after comparison. The point index falls back to a direct candidate pass for extremely broad viewports rather than iterating unbounded empty grid cells.


### On-demand netlist generation (2026-10-12)

SPICE netlist generation now lives in a separate module loaded when the user runs a simulation or opens the generated-netlist dialog. Analysis-setting validation remains synchronous so invalid fields still focus before a run; the simulation flow awaits the generator module before building the worker request. Parameter-sweep preparation is likewise loaded on Run, and CSV serialization only loads when a user exports a plot. Firefox verifies the generator is absent from initial page resources, the dialog renders the edited source after loading it, an actual starter transient completes and downloads CSV, and all eight cases in a three-parameter sweep solve using the existing local WASM runtime. The production build moved a 36.41 KB minified / 9.74 KiB gzip generator, a 6.96 KB / 2.50 KiB gzip sweep module, and a 1.38 KB / 0.60 KiB gzip CSV module out of the initial bundle. Initial JavaScript fell from 221.0 to 210.7 KiB gzip (10.3 KiB saved). The main chunk fell from 581.88 to 538.42 KB minified and still exceeds Vite's 500 KB warning. A further UI optimization moved Circuit Checks to an on-demand 18.73 KB / 5.52 KiB gzip chunk and removed its full-circuit diagnostic pass from project-edit renders. The latest production build reports 205.9 KiB initial JS gzip (4.8 KiB below the previous build), 218.8 KiB combined initial JS+CSS, and a 519.92 KB main chunk; Vite still reports the 500 KB minified chunk warning. `npm test` (28 groups), `npm run typecheck`, production build, and the focused Firefox circuit-check regression passed. No WASM rebuild was performed.


### Schematic selection and wire hit targets (2026-10-12)

The schematic now disables browser text selection while drawing selection boxes; in Chromium and Firefox a native text-selection gesture had canceled the pointer stream during right-to-left crossing selection. Wire segments also include a transparent hit rectangle with a minimum 14-unit width and height, so vertical/horizontal wires have a nonzero pointer target and remain Ctrl-click selectable even when their SVG line geometry is zero-width or zero-height. The 43-case `npm run test:e2e:ui` suite passes in Chromium, including crossing selection, vertical-wire multi-selection, model reload, symbol accessibility, and transient-measurement flows; the two schematic selection regressions also pass in Firefox. No render-time or frame-rate gain is claimed. The full app has not yet completed a file-by-file UI audit.

### Lazy examples picker (2026-10-12)

The examples catalog and its search/topic picker now load when the user opens Examples. The production build emits a 9.23 KB / 3.35 KiB gzip `ExamplesDialog` chunk; the initial JavaScript transfer falls from 205.9 to 203.5 KiB gzip, and the main entry falls from 520.07 to 511.54 KB minified (149.01 to 146.50 KiB gzip). This removes 2.51 KiB gzip from the initial transfer; the picker chunk is fetched on first open. Browser regressions confirm request timing, search/filter persistence, and replacement confirmation. The 45-case Chromium UI smoke suite passes with the original “All” default filter. The main entry still exceeds Vite’s 500 KB minified warning, so overall bundle work remains open. No WASM or Pages build was run.

### Large parameter-sweep component selector (2026-10-13)

The sweep editor now memoizes eligible-component calculation and indexes imported device models by normalized name. When a sheet has more than 100 eligible components, the native selector renders at most the first 100 filtered matches plus the currently selected component when needed; a search field filters by reference or component type. A focused Firefox regression creates 250 eligible resistors, asserts the option list stays at or below 101, and selects a late component by search. The focused full-circuit paste regression also passes in Firefox, confirming that only newly pasted wires remain selected. This bounds selector DOM size; no end-to-end render-time gain is claimed.

Wire current-flow phase now advances by elapsed time normalized to a 60 Hz reference frame, clamped to 50 ms after a delayed frame. This keeps current-scaled marker speed consistent across refresh rates and avoids a large jump after a stalled tab. A unit check compares one second of motion at 30/60/120 Hz; the Firefox real-simulation animation workflow and all 28 unit groups pass. This is a timing-consistency correction, not a solver or render-throughput claim.

### On-demand analysis editors (2026-10-13)

Parameter stepping and transient measurement/initial-condition editors are now separate dynamic chunks. With no configured sweeps or transient measurements/initial conditions, the project inspector keeps small launch controls and defers the full editors until the user adds an item. Existing saved settings still load their editor immediately. The production main entry decreased from 512.76 KB / 146.97 KiB gzip to 493.04 KB / 141.61 KiB gzip, clearing Vite's 500 KB warning; initial JavaScript transfer is 198.7 KiB gzip, with 12.9 KiB CSS and 211.6 KiB combined. Firefox tests cover deferred loading and editing, plus real initial-condition and sweep runs. All 48 Firefox UI-smoke cases, 28 unit groups, TypeScript checking, and production size-budget build pass. No WASM rebuild or Pages build was run.


### Cached schematic interaction analysis (2026-10-13)

Wire probing, wire context menus, and result overlays now reuse the same memoized connectivity analysis the application already computes. Probe and context-menu hit tests also query the schematic wire spatial index rather than scan all wire segments. Net-label context menus resolve the existing SVG label target directly, removing a full project-label scan plus per-label DOM queries on each right-click. Hierarchy deletion checks and transient-measurement signal menus are memoized until sheet or circuit structure changes. Firefox validates net-label context actions, wire/component voltage probing, and transient-measurement editing; all 28 unit groups, typechecking, and the production build pass. This removes redundant interaction-time work; no latency reduction is claimed without a controlled before/after browser measurement. No WASM or Pages build was run.

### UI maintenance and Firefox smoke audit (2026-10-13)

The 500-instance hierarchy benchmark now accounts for viewport culling: 502 parts exist in the project, but only 10 circuit-part SVG nodes are mounted in the initial Firefox viewport. The operating-point run completes with 1,003 result vectors and preserves the selected `V(out5)` trace. One culling-aware run measured 406 ms reload-to-first-render and 481 ms from Run to results; this is one observation, not a before/after comparison or budget. The full 49-case Firefox `@ui-smoke` suite passed in 51.9 seconds. It covers first-use flows, accessibility names, menus, selection, editing, hierarchy, responsive layout, and deferred editors. The targeted polarized-capacitor workflow also passed. Review found invalid ESR/winding-resistance diagnostics focused the capacitor value field; the inspector now focuses the resistance field. Obsolete CSS selectors for retired UI controls were removed; CSS output decreased from 13.18 to 12.51 KiB gzip in the comparison build. Current production output is 493.17 KB minified / 141.77 KiB gzip for the main JS entry, 12.51 KiB gzip CSS, and 211.1 KiB combined initial JS+CSS; configured size budgets pass. No WASM build or Pages workflow was run.

### Deferred guided-lesson analysis (2026-10-13)

Example-specific prediction and result-analysis copy now lives in a separate module requested only after a guided example lesson is opened. The production build emits a 27.94 KB / 8.12 KiB gzip lesson-analysis chunk; initial JavaScript is 191.7 KiB gzip and combined initial JavaScript plus CSS is 204.0 KiB gzip. The Firefox UI regression confirms the lesson module is not requested on startup and is requested when a lesson opens. The Firefox/ngspice lesson workflows confirm solved RC, capacitor-discharge, flyback, transformer, controlled-source, voltage-controlled-switch, and current-controlled-source feedback using the existing local runtime. `npm run build`, all 28 unit groups, all 51 tagged Firefox UI-smoke cases, and these seven lesson workflows pass. The helper now indexes project parts once, only reads traces for the active lesson, uses binary search on sorted result axes, and recalculates only when lesson inputs change. A Node microbenchmark with 5,000 parts measured 64 linear ID searches at 0.784 ms median versus one map plus 64 indexed lookups at 0.390 ms; six fixed sample searches on a 1,000,000-point axis measured 42.469 ms with linear scans and 0.006 ms with binary search. These are synthetic microbenchmarks, not end-to-end app timings. No WASM rebuild or Pages workflow was run.

### Large-schematic and million-sample Firefox observations (2026-10-13)

The 100/500/1,000/5,000-part Firefox benchmark recorded initial render times of 378.92/397.26/462.25/664.14 ms; viewport culling kept the 500–5,000-part renders at 64 visible parts and 105 labels. Selection medians were 8–11 ms with p95 of 10–15 ms; Ctrl+A took 34 ms, moving a 15,000-object mixed selection took 25 ms, and zoom took 21 ms median / 25 ms max. A separate 5,000-part/4,900-wire case rendered 64 parts and 551 wires in 813.38 ms, with 12/18 ms selection median/p95, 42 ms select-all, 38/52 ms zoom median/max, and 15 ms arrow navigation. These are single-run local observations, not budgets or before/after gains.

Two Firefox runs also solved 1,000,130 transient samples and rendered eight plot windows with 32 traces. Result-ready time was 10,026/11,021 ms. Scripted cursor updates measured 108.50/117.51 ms, 31.26/42.01 ms, and 40.04/36.60 ms over the three successive scrubs; observed interval delay peaked around 107/114 ms during solve. Firefox did not expose a heap metric. These measurements use the existing local WASM runtime and do not include a WASM build; the cursor figures include browser automation overhead and are not a controlled before/after comparison.

### Firefox benchmark harness refresh (2026-10-13)

The 7-case Firefox browser benchmark suite now matches the current editor. The 500-part animation and 49-part nonlinear fixtures assert viewport-culling bounds rather than requiring every offscreen SVG node to be mounted. The two multi-trace fixtures seed explicit waveform-window traces and measure visibility toggles in those windows instead of querying the retired global trace picker. They also wait for the starter project autosave before reading it. The complete suite passes. One run recorded: 501-part animation scrub 33.46 ms; 500-instance hierarchy first render 386.85 ms and solve 502.65 ms; 1,000,130-sample / 32-trace result ready 9,980.8 ms with three scrub interactions at 106.64/36.17/42.09 ms; 24-section / 40-trace result ready 982.79 ms with visibility toggle/render 1,319 ms; nonlinear 100,126-sample / 40-trace result ready 6,013.68 ms with toggle/render 1,321 ms; 5,000-part first render 655.7 ms; and 5,000-part / 4,900-wire render 782.72 ms. These are local single-run observations with no controlled before/after, and should not be used as universal budgets.

### Cross-browser performance sample (2026-10-13)

The 14-case browser benchmark run exercised Chromium and Firefox using the existing local WASM runtime. The hierarchy case exposed a portability-only assertion issue: the persisted `V(out5)` trace ID is canonicalized to lowercase in Firefox. The assertion now compares IDs case-insensitively; the targeted Firefox rerun passes, and the same hierarchy scenario passed in Chromium in the original run. The other 13 cases passed in that run. A post-fix full-suite rerun was not performed. Single-run observations: the 500-instance hierarchy editor rendered in 396 ms Chromium / 407 ms Firefox and reached operating-point results in 425 ms / 514 ms; the 5,000-part editor rendered in 639 ms / 645 ms; the 5,000-part/4,900-wire render took 633 ms / 778 ms. For the 1,000,130-sample, 32-trace scenario, results arrived in 3,975 ms Chromium / 10,014 ms Firefox; later repeated cursor interactions were about 22–46 ms / 30–67 ms. Firefox worker memory was unavailable, and Chromium's heap readings were inconclusive. Measurements are local single-run observations with no controlled before/after comparison and are not budgets. No WASM rebuild or Pages workflow was run.

### Firefox performance follow-up (2026-10-13)


All seven current browser performance cases pass in Firefox. The 500-component animation scrub was 28.1 ms; 500-instance hierarchy first render / operating point was 400.3 / 488.6 ms; and the one-million-sample, 32-trace run completed in 10,999 ms, with later scrubs at 70.2, 32.4, and 29.9 ms. In the 5,000-part editor, selection input-to-frame median/p95 was 11/23 ms and zoom median/max was 21/24 ms; the 5,000-part/4,900-wire case rendered in 793.5 ms with selection median/p95 13/19 ms and zoom median/max 38/50 ms. In the 40-trace plot case, the existing 1,329 ms visibility-toggle aggregate deliberately waits one animation frame after each of 80 toggle operations. Four single-toggle samples measured 0–1 ms synchronous click-dispatch duration and 18/36/39/30 ms through two animation frames. The aggregate therefore should not be read as one-click latency; the measured click handler itself did not show a long synchronous task. These are single-host local observations and not budgets or controlled before/after gains. Existing local ngspice runtime was reused; no WASM or Pages build was run.

Five same-host Firefox repeats of only the 500-component animation scrub ran against the current sampler-stability and component-property memoization code. The `scrubMs` values were 25.26, 28.21, 25.85, 29.71, and 31.82 ms (median 28.21 ms, range 25.26–31.82 ms). The earlier one-run value was 28.1 ms, so this does not demonstrate a timing gain. The metric times Playwright's keyboard action through the cursor-readout assertion; it is not a pure browser frame-time measure. The run confirms the benchmark and viewport/cursor behavior in five fresh Firefox contexts, not a performance budget. No WASM rebuild was performed.

### Firefox million-sample WASM memory profile (2026-10-13)

With `VITE_ELSIM_PROFILE=1`, Firefox completed the one-million-sample transient with 1,000,130 saved samples, eight waveform windows, and 32 rendered traces. Run-to-results was 10,031 ms. The worker profile recorded 71 ms module load, 9,619 ms in ngspice, 40 ms result parsing, 9,732 ms worker total, and 185,794,560 bytes (177.19 MiB) of WebAssembly linear-memory capacity after result parsing. WebAssembly linear memory can grow but cannot shrink, so this is the worker's linear-memory high-water capacity for this run; it excludes JavaScript heaps and browser/process overhead. Firefox did not expose its JavaScript heap readings (`performance.memory` returned null). The main-thread interval monitor saw a maximum 62 ms delay during the workload. Three cursor scrub timings were 66.96, 32.05, and 32.02 ms; each includes Playwright key dispatch and a DOM assertion and is not a pure render-time measurement. This precisely records WASM capacity, not total browser/worker peak memory; the latter remains open. Existing local WASM was reused without rebuilding.

### Memoized wire lookup in the schematic renderer (2026-10-13)

Selected/hovered wire resolution now uses a memoized ID map, avoiding two full `project.wires.find(...)` scans on each Schematic render (including two full scans when no wire is selected or hovered). Typecheck, the Firefox hover/connection-dot, pointer endpoint, and keyboard endpoint regressions pass; the focused 5,000-part/4,900-wire benchmark also passes (784 ms render, 11/17 ms selection median/p95, 37/53 ms zoom median/max in this run). A synthetic Node microbenchmark with a prebuilt 4,900-wire array/map and 50,000 empty-hover lookups measured the old two-scan path at 0.99–1.38 s across repeated rounds and the guarded indexed path at 0.06–1.97 ms. This isolates lookup complexity and excludes one-time map construction; it is not an end-to-end UI speedup claim. Production build and transfer budgets pass (204.3 KiB initial JS+CSS gzip). No WASM or Pages build was run.

### Group-drag DOM lookup (2026-10-13)

The first movement of a multi-selection drag previously ran one `querySelector` for every selected object that passed viewport checks. It now enumerates the currently rendered part/wire/label SVG objects once and resolves visible selected objects through a temporary ID map; viewport culling and the single project update on release are unchanged. Firefox mixed part/wire/label drag, part-group copy/move, and full-circuit pasted-wire selection regressions pass. The 5,000-part / 10,000-label benchmark confirms Ctrl+A, a 15,000-object drag preview, and final committed coordinates; one run measured 29 ms for select-all and 27 ms from the drag input to the next frame. The earlier run was 25–26 ms; this noisy timing does not establish a speedup, while the code path now has one DOM enumeration instead of repeated tree searches. Typecheck and production build pass, with 204.3 KiB initial JS+CSS gzip. No WASM or Pages build was run.

At that stage, the drag-start snapshot resolved selected part, wire, and label IDs through memoized maps and copied only selected objects and their wire points. The follow-up below removes those per-object copies and reuses full project arrays for Ctrl+A selections. The original 28 ms result is retained as the pre-follow-up measurement; it is not a controlled baseline.

### Connection-dot geometry allocation follow-up (2026-10-13)

`wireConnectionDotPoints` no longer allocates a combined candidate-wire array for each pin or endpoint query. It checks the long-wire list and matching spatial bucket in place, uses squared-distance checks for pins, and uses an exact squared-distance path for horizontal and vertical wires. Built-in component pin offsets are cached by kind, and the common 0/90/180/270-degree pin rotations avoid repeated trigonometry. Existing `geometry-edit` coverage compares dot output with a full geometric reference including long segments, T joins, pin joins, and a non-connecting crossing; three focused Firefox grid/dot workflows pass. All 30 unit groups, TypeScript, and the production size-budget build pass. On the same i7-12700F host, separate seven-run benchmark processes measured 9.97 ms median / 43.48 ms p95 for deriving 9,800 dots, compared with 12.18 ms / 40.79 ms immediately before and 12.29 ms / 32.89 ms in another preceding run. The median is lower, but the spread and separate-process runs do not establish a reliable gain; repeated/interleaved measurements remain needed. No WASM build was run.

### UI selection regression and current production build (2026-10-13)

Ctrl-click on a wire previously entered the wire drag/pointer-capture path, and the matching click could be consumed as a canvas click before the wire joined the multi-selection. Modified wire presses now update additive selection directly and suppress only their duplicate click. The focused regression passes. The complete 51-case UI-smoke suite passed in 49.3 seconds in Chromium and 53.1 seconds in Firefox; the full 116-case Firefox non-engine suite passed in 2.5 minutes. The parameter-sweep fixture waits until the recovery gate enables Run before sending Escape after reload. All 29 unit groups and TypeScript pass. A local `npm run build` (no WASM or Pages step) emitted a 466.90 kB minified main JS entry (134.69 KiB gzip), 12.63 KiB gzip CSS, and 204.3 KiB initial JS+CSS gzip, within current budgets. These results verify the tested interactions and bundle gate, not every possible UI state or accessibility behavior.

### Single-object drag preview (2026-10-13)

Dragging one part, wire segment, or net label previously called `setProject` for every pointer event, mapping the full relevant collection and triggering editor rerenders throughout the drag. These object types now get a temporary SVG transform; the project is updated once on release. Wire endpoints similarly update the existing line, hit target, and active endpoint handle directly, committing the endpoint once on release. Common selected-object actions also resolve IDs through the schematic's existing maps. Seven Firefox regressions cover mixed group drag, standalone wire and component drag, endpoint geometry, keyboard editing, hover, and connection dots. All 29 unit groups and the production build pass; the current build's initial JS+CSS remains within its configured size budget. The change removes repeated state writes by construction, but no measured end-to-end timing comparison was run. No WASM or Pages build was run.

### Frame-coalesced waveform cursor notifications (2026-10-13)

Cursor state now changes synchronously, while both React subscriber groups are notified together at most once per animation frame. A focused unit test checks that multiple updates in one frame expose the newest exact sample and produce one notification. Firefox playback continues to animate current flow. This bounds React notification work during rapid scrubbing by display frames; no measured before/after frame-time comparison was run. No WASM or Pages build was run.

### Copy/paste selection movement regression (2026-10-13)

The Firefox full-circuit copy/paste regression now verifies the copied parts and wires form one movable selection after paste: dragging a copied part must move every copied part and wire by the same snapped offset and leave all originals unchanged. Five repeated pre-extension runs and the extended focused run pass. This is correctness coverage, not a performance measurement. No WASM build was run.

### Firefox large-project and waveform UI refresh (2026-10-13)

All seven Firefox browser performance cases passed using the existing local ngspice runtime. Results: 500-component/1,000-vector animation scrub 27.9 ms; 500-instance hierarchy editor-ready 381 ms and operating-point result-ready 526 ms; 1,000,130-sample transient with eight windows/four traces each result-ready 11.0 s, repeated scrub 67/33/31 ms, and maximum interval delay 37 ms. The 5,000-part/10,000-label project measured 660 ms editor-ready, 21 ms select-all input-to-frame, 24 ms mixed-group drag-to-frame, and 20 ms median zoom-to-two-frames. The 5,000-part/4,900-wire project measured 770 ms render, 12/25 ms selection median/p95, 63 ms select-all input-to-frame, 39/53 ms zoom median/max, and 16 ms arrow navigation. Firefox returned no WASM linear-memory or JS heap values. These are single-host observations with no before/after claim; the 40-trace visibility aggregate still includes awaited animation frames, while its click handlers remain 0–1 ms synchronously. No WASM rebuild was performed.

### Wire-selection isolation experiment (2026-10-13)

A trial moved per-wire selected state to an external store and memoized the visible-wire layer. Focused selection tests and the build passed, but repeated Firefox select-all-to-frame observations varied from 43–64 ms with the store-only trial and 71–74 ms after adding the memoized layer, against an earlier single 63 ms observation. These samples do not demonstrate a gain and the added store requires scanning/notifying selected wire IDs. The experiment was fully reverted; the existing selected-wire prop path remains. The benchmark needs controlled repeat/interleaved profiling before another change is justified.

### Lazy component animation trace plans (2026-10-13)

Visible component animation now resolves pin nets and result-vector references once per part/result through a lazy `WeakMap`, then reads values by the cursor sample index. Off-screen parts allocate no plan until they enter the animation viewport. Trace reads preserve the previous shared-axis fast path and nearest-time lookup for distinct axes. Five Firefox runs of the 500-part/1,000-vector scrub measured 27.1, 27.1, 28.1, 34.8, and 36.1 ms (median 28.1 ms), versus three pre-change runs at 30.6, 30.7, and 32.6 ms (median 30.7 ms). The overlap and spread mean this is a promising local observation, not a reliable performance guarantee. Wire, capacitor, transformer, lamp, logic-gate, and voltage-controlled-switch animation regressions pass against the existing local runtime. No WASM rebuild was run.

The shared `scrubToTime` browser helper now waits for the controlled sample to render after each binary-search step before reading the time label. Three repeated capacitor-animation runs pass; this removes a test race where intermediate scrub updates could select the wrong sample.

### Waveform drag-pan update batching (2026-10-13)

Transient, AC, and DC sweep plot drag-pan now accumulates pointer deltas and applies at most one range update per animation frame. Pointer release/cancel flushes any pending delta so the final gesture is not dropped. This bounds React and persisted-range update frequency to the display frame rate during high-frequency pointer events; no end-to-end timing gain is claimed. The focused Firefox transient plot interaction regression passes, and the test now accepts the engineering time unit exposed by the accessible cursor announcement (`s`, `ms`, `µs`, `ns`, or `ps`) instead of requiring the word “seconds”. No WASM rebuild was run.

### ngspice WASM linear-memory measurement (2026-10-13)

The Node benchmark worker now captures the instantiated WebAssembly `memory` export and records its byte length before and after `callMain`; because `memory.grow` is monotonic, the post-run size is the solver instance's committed linear-memory high-water mark. On the i7-12700F with the existing local runtime, memory was 19,660,800 bytes before both runs, stayed at 19,660,800 bytes for a 103,406-sample transient, and grew to 63,242,240 bytes (60.3 MiB) for 1,034,006 samples. That million-sample solver/raw-write run took 2,712 ms in this Node worker benchmark. Sampled process RSS increased by 112,369,664 bytes in the million-sample case; this includes the parent process, Node, parser, raw buffers, and worker, so it is not a WASM-only measurement. This closes the WASM linear-memory measurement gap for the Node benchmark path, but browser/WebView total-memory measurements and a second hardware baseline remain open. No WASM rebuild was run.

The existing Firefox/Chromium browser benchmark was also run with `VITE_ELSIM_PROFILE=1`, using its development-only worker instrumentation and the same local runtime. Both browsers reported 185,794,560 bytes (about 177 MiB) of WASM linear-memory capacity for 1,000,130 samples, eight windows, and 32 plotted traces. Firefox result-ready time was 10.04 s and warmed scrubs were 62.84/41.57/39.67 ms; Chromium was 3.99 s and 45.89/29.68/22.52 ms. These are single-host local observations, not stable performance comparisons. Chromium page heap stayed at 39.6 MB before/after at the API's reported precision; Firefox exposes no corresponding page-heap value. WASM linear memory is not total worker allocation or resident memory, so total browser/worker memory and a second hardware baseline remain open. No WASM rebuild or Pages deployment was run.

### Firefox large-circuit and waveform benchmark recheck (2026-10-13)

Ran `VITE_ELSIM_PROFILE=1 npm run benchmark:browser -- --project=firefox` against the existing local WASM runtime; all seven scenarios passed in 39.6 s. The 500-component animated circuit selected and scrubbed correctly (25.17 ms scrub sample); its 500-instance hierarchy loaded the editor in 378 ms and operating-point results in 490 ms. The 1,000,130-sample transient produced eight windows and 32 plotted traces in 9.998 s, with 185,794,560 bytes of WASM linear-memory capacity. Three warmed Home/End scrubs took 53.50, 32.33, and 38.20 ms; the 16 ms timer observer's maximum excess delay was 47 ms during the run. For the 5,000-part/4,900-wire editor, 64 parts and 551 wire segments were mounted; initial render was 760 ms, selection median/p95 7/11 ms, select-all input-to-frame 74 ms, zoom median/max 37/51 ms, and arrow navigation 15 ms. The 40-trace visibility toggle reached two animation frames in 27–34 ms per sample; the 1.33 s total covers toggling all 40 traces twice with a frame between each. These are one-machine diagnostics rather than cross-machine budgets; the large-result timer delay remains a responsiveness measure to watch. No WASM rebuild or Pages workflow ran.

### Shared waveform coordinate formatting (2026-10-13)

Transient, AC/noise, and DC plots now keep a bounded weak cache of formatted SVG point strings, keyed by the immutable axis/value/index objects and the full visible coordinate transform. Reopening equivalent windows therefore reuses the same exact point string instead of formatting it again; AC transformed sample ranges and extrema also share work across windows using an explicit trace/mode key. Unit tests verify identical windows avoid rereading vector samples, distinct plot scaling regenerates points, and transformed AC modes use separate cached extrema. The full Firefox engine suite completed with 77 passing cases and one pre-existing cursor-readout race; after adding a wait for the selected off-state sample, that isolated NPN case passes as well. Six focused transient/AC/noise/DC workflows pass, as do all 30 unit groups, TypeScript, and the production bundle. The million-sample Firefox benchmark showed 9.3–9.5 s solver time; maximum 16 ms timer excess varied from 35 to 50 ms across repeated runs, so no end-to-end timing gain is claimed. This change removes repeated formatting by construction; its precise frame-time benefit remains unmeasured. No WASM rebuild or Pages workflow ran.

### Full-selection drag snapshots (2026-10-13)

Multi-object drag start now retains immutable project-record references instead of cloning each selected component and label and copying each selected wire's two endpoint tuples. For a Ctrl+A selection, the drag snapshot reuses the project's complete part, wire, and label arrays; the movement helper recognizes those exact full-array snapshots and creates the translated output in one pass without an intermediate ID map. Partial selections still resolve IDs through the existing per-project maps and preserve drag-start semantics. The 119-case Firefox non-engine UI suite passed immediately before this change; focused Firefox regressions for full-circuit pasted-wire selection, dragging a multi-wire selection, and mixed component/wire/label movement pass afterward. The large-project Firefox benchmark reports 19 ms from the 15,000-object drag input to the next frame, compared with a previous 28 ms single run; timing is noisy and does not establish a speedup. TypeScript and all 30 unit groups pass. No WASM rebuild or Pages workflow ran.

### Wire-flow sample vector lookup reuse (2026-10-13)

The UI's per-cursor wire-flow sampling now caches result-vector reads for the duration of one sample. Both endpoints of a two-terminal component, and repeated winding/pin references, therefore reuse the same resolved scalar rather than re-querying the result trace. Four Firefox animation regressions pass (wire playback, capacitor charge, LC energy exchange, and transformer windings). Five 500-component Firefox scrub runs measured 24.68, 26.85, 27.58, 28.45, and 41.87 ms (median 27.58 ms), overlapping the prior five-run 27.1–36.1 ms range (median 28.1 ms); this does not establish an end-to-end speedup. All 30 unit groups and TypeScript pass. No WASM rebuild or Pages workflow ran.

### Imported symbol render memoization (2026-10-13)

Imported symbol artwork is now a memoized child of each circuit part. A cursor update can still refresh the part's result readout and animation, but static imported lines, arcs, text, and pin labels are not mapped into a new React element tree unless the parsed symbol or selection color changes. The Firefox imported-IC symbol workflow passes, along with all 30 unit groups and TypeScript. No dedicated timing comparison is available, so this records a reduction in redundant React work rather than a measured speedup. No WASM rebuild or Pages workflow ran.

### Built-in symbol render memoization (2026-10-13)

Built-in symbol geometry now renders in a memoized child. Static components reuse their SVG element tree across simulation cursor updates; components with solved-value animation still receive updated animation inputs and render normally. Firefox capacitor charge, transformer winding, and lamp glow regressions pass. All 30 unit groups, TypeScript, and the production build pass; the initial JS+CSS gzip budget is 207.1 KiB. No dedicated timing comparison is available, so this records a reduction in React element mapping for static components rather than a measured speedup. No WASM rebuild or Pages workflow ran.

After this change, the focused 501-component/1,001-vector Firefox playback benchmark passed with a 26 ms scrub measurement. Earlier repeats ranged from 25.26 to 31.82 ms, so this single result is only a regression check and does not establish a measurable speedup.

### Waveform trace-control memoization (2026-10-13)

Trace toggle controls now have stable visibility/removal callbacks and render behind a memo boundary. Plot zoom or responsive resize can update chart axes without rebuilding unchanged selected-probe controls. Two Firefox workflows passed: rerunning preserves probe colors and visibility, and opening probes across multiple waveform windows preserves the selected traces. TypeScript and the production budget build pass (207.1 KiB initial JS+CSS gzip). No controlled timing comparison was run; this records fewer redundant React renders by construction, not a measured speedup. No WASM rebuild or Pages workflow ran.

### AC/DC cursor update isolation (2026-10-13)

AC, noise, and DC sweep plot parents no longer subscribe to cursor changes. Small cursor label, marker, and readout components subscribe independently, so cursor movement updates those elements without reconstructing chart axes, grid labels, trace selectors, and the chart's other SVG children. Firefox AC cursor/keyboard/zoom and cross-window synchronization, noise analysis rendering, and DC sweep cursor/zoom checks pass. All 30 unit groups, TypeScript, and the production build pass (207.1 KiB initial JS+CSS gzip). This is a render-boundary change; no controlled timing comparison was run. No WASM rebuild or Pages workflow ran.

The complete engine-independent Firefox Playwright suite was rerun after the plot changes: 119 tests passed in 2.5 minutes. This is broad UI regression coverage, not a performance comparison. Engine-tagged workflows are excluded from this command; no WASM rebuild was performed.

### Wire-flow SVG path-string reuse (2026-10-13)

Current-flow SVG segments keep their last sampled coordinate array and serialized `points` attribute. When another simulation sample produces identical geometry, a coordinate comparison reuses the prior string rather than mapping and formatting each point again; direction, magnitude, and dot animation remain sample-driven. Three Firefox checks pass for active playback, geometry refresh after moving a component, and transformer windings. All 30 unit groups, TypeScript, and the production build pass (207.2 KiB initial JS+CSS gzip). The 501-component Firefox playback check measured 30.98 ms, within the earlier 25.26–31.82 ms range; no performance gain is established. No WASM rebuild or Pages workflow ran.

### Large-hierarchy connectivity and netlist generation (2026-10-13)

Two repeated-work paths were removed from hierarchy processing. Connectivity now tracks each net's lexicographically smallest token while grouping instead of copying and sorting a growing token list; duplicate label names are checked with per-net sets. Netlist generation parses imported model libraries once per artifact, indexes subcircuit definitions by case-insensitive name, and parses the generated sheet library once instead of reparsing it for every placed `X` instance. The 30 unit groups, TypeScript, and Firefox's nested reusable-divider comparison against an equivalent flattened circuit pass. On the same i7-12700F host with seven benchmark runs, the 5,000-instance hierarchy's connectivity median changed from 159.99 ms before to 73.18 ms after grouping, then measured 79.80 ms in the final run. Netlist median changed from 243.76 ms before to 157.87 ms after grouping and 107.79 ms after definition caching. These sequential local runs show a substantial reduction in repeated work, but they are not interleaved and are not cross-machine guarantees. The quick benchmark skipped ngspice; the focused Firefox run used the existing WASM runtime. No WASM rebuild or Pages workflow ran.

Connectivity's disjoint-set lookup now uses iterative path compression so unusual label ordering cannot make recursive lookup overflow the JavaScript stack. A 16,000-label adversarial fixture verifies every reverse-ordered, globally connected label resolves to the same net. Parent roots keep lexical union behavior; no standalone performance gain is claimed for this safety fix. A further quick run with both hierarchy optimizations measured 76.79 ms connectivity and 110.67 ms netlisting for 5,000 instances, consistent with the earlier results within local run variation.

The quick benchmark now includes 400 placed subcircuit ICs against 600 imported definitions (43,199 library bytes). Reusing each parsed library's model records for netlist output reduced median generation from 7.861 ms (8.352 ms p95) to 5.520 ms (6.416 ms p95), about 30% lower median on this host. Both runs produced the same 2,204-line, 57,519-byte deck with no diagnostics. This is a single-host seven-run before/after comparison, not a universal timing guarantee; the benchmark skips ngspice.

Imported device-model references now use a case-insensitive name index instead of scanning every `.MODEL` card for each placed D/Q/J/M device; the first matching definition retains the prior lookup behavior. A second fixture places 400 NMOS devices using the last of 600 imported models (31,199 library bytes). Median netlisting fell from 18.974 ms (19.525 ms p95) to 5.616 ms (6.026 ms p95), about 70% lower median. Both runs produce the same 1,004-line, 48,517-byte netlist with no diagnostics. All 30 unit groups and TypeScript pass. These local seven-run timings are not cross-machine guarantees; the quick benchmark skips ngspice.

### Full UI audit and Firefox stress recheck (2026-10-13)

The complete 119-case engine-independent Firefox UI suite passed, as did all 30 unit groups and TypeScript. The seven-case Firefox browser stress suite also passed against the already-built local ngspice runtime; no WASM rebuild or Pages run was done. This run measured 26.31 ms for a 501-component/1,001-vector scrub, 373 ms editor readiness and 490 ms operating-point readiness for 500 hierarchical instances, and 11.03 s for a 1,000,130-sample transient with eight plot windows and 32 traces. Three warmed scrub samples were 52.99, 38.42, and 31.39 ms; the maximum observed delay beyond the 16 ms timer interval was 47 ms during the simulation, 13 ms during plot validation, and 5 ms during cursor scrubbing. The 40-trace benchmark reached two animation frames in 26–35 ms for each toggle; its 1.33 s total covers toggling all traces twice with a frame between actions. In the 5,000-part/4,900-wire editor, 64 parts and 551 wire segments were mounted; initial rendering was 795 ms, selection median/p95 was 12/17 ms, select-all-to-frame was 62 ms, zoom-to-two-frames median/max was 40/58 ms, and arrow navigation was 16 ms. These are one-machine diagnostics close to earlier observations, not proof of a regression or speedup. No broken UI path reproduced, so this audit did not justify a broad renderer rewrite. Cross-machine timing and manual assistive-technology review remain open.

### Reusable viewport-query candidate marks (2026-10-13)

Part, wire, label, junction, and connection-dot visibility queries now deduplicate spatial-cell candidates with a reusable `Uint32Array` generation-mark buffer instead of constructing a `Set` for each query. Queries still sort source indexes before exact overlap checks, preserving z-order, focused-item inclusion, and edge visibility. Results are built with a direct loop rather than one temporary array per candidate. The 5,000-wire quick benchmark measured 0.017 ms median query time (previous sample: 0.019 ms); part query was 0.012 ms (previous: 0.016 ms), and connection-dot query was 0.014 ms (previous: 0.019 ms). A focused Firefox 5,000-part/4,900-wire navigation run passed: selection median/p95 11/16 ms, select-all-to-frame 61 ms, and zoom-to-two-frames median/max 37/56 ms, compared with the preceding single run at 12/17, 62, and 40/58 ms. Differences are within local timing noise; the established improvement is reduced temporary allocation by construction, not a measured speedup. All 30 unit groups and TypeScript pass. No WASM rebuild or Pages run.

### Lazy advanced source waveform controls (2026-10-13)

SINE, EXP, and SFFM inspector fields were extracted from the initial app module into a dynamically loaded editor shared by voltage and current sources. DC, PULSE, and PWL workflows do not request this code; selecting an advanced waveform loads it on demand. The initial JS+CSS gzip budget moved from 207.5 KiB to 207.0 KiB; the deferred waveform chunk is 1.13 KiB gzip. Firefox confirms the chunk is absent at startup, arrives when SINE is selected, and the source then simulates through the existing local ngspice WASM runtime. TypeScript and the production frontend build pass. No WASM rebuild or Pages run.

### Full UI audit and Firefox stress recheck (2026-10-13)

The complete 120-case engine-independent Playwright suite passed in Firefox in 2.6 minutes, including copy/paste of the full circuit followed by a mixed copied-part/wire move, hover transitions, responsive layout, accessible focus, waveform windows, and lazy UI modules. All 30 unit groups passed. The seven-case Firefox performance suite also passed against the existing local runtime. The 501-component animation scrub measured 26.94 ms; the 500-instance hierarchy rendered in 355 ms and returned operating-point results in 513 ms; the 1,000,130-sample transient with eight windows and 32 traces completed in 9.98 s. Warm scrubs were 60.08/40.40/36.67 ms, with a 41 ms maximum delay beyond the 16 ms timer during simulation. The 40-trace plot toggle reached two frames in 29–34 ms. The 5,000-part/4,900-wire editor rendered in 764 ms, with 7/13 ms selection median/p95, 47 ms select-all-to-frame, 40/57 ms zoom-to-two-frames median/max, and 18 ms arrow navigation. These one-host values remain close to previous observations and do not establish a broad performance regression or gain. No reproducible defect surfaced in the audit. The production build and transfer-budget check pass: 207.0 KiB initial JS+CSS gzip against the 245 KiB budget. No WASM rebuild or Pages run.

### Focus restoration fix and Firefox performance recheck (2026-10-13)

Closing a floating waveform panel while its close control has keyboard focus now restores focus to the topmost remaining plot, or to the schematic after the final plot closes. The focused Firefox regression passes both paths. The complete 121-case engine-independent Firefox UI suite, all 30 unit groups, TypeScript, and the production size-budget build pass. Focused Firefox stress cases also passed against the already-built local ngspice runtime: a 1,000,130-sample transient with eight windows and 32 traces completed in 10.05 s with 185,794,560 bytes of WASM linear-memory capacity; warmed cursor scrubs measured 59.09/33.57/40.55 ms; the 40-trace case rendered 452 points per trace and reached two frames in 25–34 ms per toggle; and the 5,000-part/4,900-wire editor rendered in 756 ms with 7/11 ms selection median/p95, 57 ms select-all-to-frame, and 39/55 ms zoom-to-two-frames median/max. The 16 ms timer observer recorded 42 ms maximum excess during solving, 22 ms during plot validation, and 5 ms during cursor scrubbing. These single-host readings are close to existing results; they do not establish a performance gain or justify a broad renderer rewrite. Firefox does not expose the page-heap metric used by Chromium, and WASM capacity is not total worker/browser memory. No WASM rebuild or Pages run.

### Current Firefox large-schematic recheck (2026-10-13)

The focused 5,000-part/4,900-wire Firefox benchmark mounted 64 parts and 551 wires, rendered in 787 ms, selected in 12 ms median / 17 ms p95, handled Ctrl+A in 61 ms to frame, zoomed in 39 ms median / 56 ms maximum to two frames, and navigated by arrow key in 21 ms. A same-host quick domain run measured 5,000-wire connectivity/netlisting at 44.6/50.6 ms p95 and 5,000-instance hierarchy connectivity/netlisting at 91.1/133.6 ms p95. These are current single-run observations and do not establish a gain or regression. The Firefox 5,000-part browser test passed; the quick benchmark skipped ngspice.

### Full Firefox UI sweep (2026-10-13)

The complete 121-case engine-independent Firefox UI suite passed, including mixed-object drag, full-circuit copy/paste wire selection, endpoint movement, waveform windows, responsive layout, and keyboard focus. All 30 unit groups, TypeScript, and the production transfer-budget build pass (207.4 KiB initial JS+CSS gzip against 245 KiB). The 5,000-part/4,900-wire Firefox benchmark mounted 64 parts and 551 wires; render took 778 ms, selection median/p95 was 8/17 ms, Ctrl+A reached the next frame in 67 ms, zoom-to-two-frames median/max was 39/57 ms, and arrow navigation took 15 ms. Compared with the previous 787 ms run, these are within single-run variation and do not establish a speedup. No additional reproducible UI defect surfaced, so this sweep does not justify a broad renderer rewrite. No WASM rebuild or Pages workflow ran.

### Indexed keyboard navigation (2026-10-13)

Directional part navigation on the 5,000-part schematic now uses a memoized spatially ordered index and binary search to avoid scanning all parts on each arrow-key press. Selection semantics remain unchanged: the closest part in the requested direction wins by the existing weighted-distance rule, with project order as the tie-breaker, and the prior nearest-part fallback is retained. A deterministic unit comparison checks the indexed result against the former brute-force rule across 20 varied layouts, 25 origins per layout, and all four directions. The focused browser benchmark now samples seven successive keyboard moves and reports their median plus maximum (the maximum of seven is not a statistical p95).

| Browser | Arrow input to two frames, median | Maximum of seven samples |
| --- | ---: | ---: |
| Chromium | 15.1 ms | 25.3 ms |
| Firefox | 18.0 ms | 32.0 ms |

An earlier one-sample Chromium observation was 33 ms; the new repeated measurements suggest lower latency, but this is a single post-change run and is not a controlled before/after comparison. All 30 unit groups, TypeScript, and the focused two-browser benchmark pass. The browser benchmark config reuses a running local server outside CI to avoid a port collision; CI still starts a fresh server. No WASM rebuild or Pages workflow ran.

### Firefox M4.3 stress and memory recheck (2026-10-13)

The seven-case Firefox stress suite passed using the already-built local WASM runtime. One initial run exposed a stale benchmark locator (`alert` instead of the app's `alertdialog`) in the nested-hierarchy setup; the selector was corrected, and that case passed in isolation. The test config now accepts `ELSIM_PERF_PORT` so a fresh profiled run can avoid an occupied local port. Measurements: 501-component/1,001-vector cursor scrub 28.0 ms; 500 hierarchical instances mounted 10 parts initially, editor ready in 389 ms, operating point ready in 474 ms; one-million-sample transient with eight windows and 32 plotted traces ready in 11.02 s. The profiled Firefox worker reports 85 ms module load, 10.26 s solver time, 42 ms result processing, and 185,794,560 bytes of WASM linear-memory capacity. Firefox does not expose the browser page heap; this WASM capacity is not total browser/worker memory. The 5,000-part/4,900-wire editor mounted 64 parts and 551 wires and rendered in 803 ms; selection was 13/20 ms median/p95, Ctrl+A 42 ms to frame, zoom 40/56 ms median/max to two frames, and arrow navigation 20/26 ms median/max. The largest observed excess over a 16 ms timer interval was 52 ms during solving and 18 ms during cursor scrubbing. These are single-host observations and do not prove cross-device performance or a speedup. No WASM rebuild or Pages workflow ran.

### Chromium browser and WASM memory sample (2026-10-13)

The matching profiled Chromium run solved 1,000,130 samples, rendered eight windows with 32 traces, and completed in 4.03 s (3.67 s ngspice solver, 24 ms module load, 41 ms result processing). Chromium's renderer reported 39.6 MB used / 50.4 MB allocated JS heap both before and after the solve; the worker reported 185,794,560 bytes of WASM linear-memory capacity. These metrics describe different contexts and browser APIs may account for typed-array backing stores differently, so they must not be added or presented as total resident memory. Warm scrubs measured 48.03/32.09/27.92 ms; the 16 ms timer observer recorded up to 87.5 ms excess during solving, 42 ms during plot validation, and 4.5 ms during scrubbing. The sample adds Chromium renderer-heap evidence but does not close the total browser/worker resident-memory or second-machine gaps. Existing local WASM was reused.

### Current Firefox stress recheck (2026-10-14)

All seven browser stress cases pass using the existing local ngspice runtime. Firefox measured 24.74 ms for a 501-component result-animation scrub; 338 ms to render and 500 ms to solve the 500-instance hierarchy; and 11.04 s for a 1,000,130-sample transient with eight plot windows and 32 traces. Three warm scrubs took 54/41/32 ms. In the 5,000-part fixture, 64 parts and 105 labels were rendered; editor-ready was 630 ms and selection median/p95 was 5/10 ms. The 5,000-part/4,900-wire fixture rendered in 760 ms with 8/16 ms selection median/p95, 78 ms select-all-to-frame, and 38/53 ms zoom-to-two-frames median/maximum. The 40-trace case measured 1,329 ms aggregate over 80 visibility toggles; four individual toggles took 28–53 ms to reach two animation frames, with 0–1 ms synchronous click-handler time. The nonlinear 100,126-sample case also rendered 40 traces and took 5.98 s to produce results. The million-sample run's largest 16 ms timer delay was 49 ms during solving; Firefox did not expose heap or WASM-memory metrics in this run. These single-host samples are consistent with prior observations, not a controlled comparison or cross-device guarantee. All 122 engine-independent Firefox UI tests, six focused hierarchy/source-sweep workflows, all 30 unit groups, TypeScript, and the production size-budget build pass. No WASM rebuild or Pages workflow ran.

### Repeated Firefox 5,000-part navigation benchmark (2026-10-14)

Three fresh Firefox runs of the 5,000-part/4,900-wire navigation test each mounted 64 parts and 551 wires. Initial render was 763/766/771 ms; selection median/p95 was 11/16, 7/15, and 8/11 ms; select-all-to-frame was 77 ms in all three; zoom-to-two-frames median/max was 38/53, 38/54, and 37/55 ms; arrow navigation median/max was 19/27, 20/32, and 20/30 ms. These runs provide a small repeatability sample on the same machine. They do not establish a before/after gain; selection, zoom, and navigation remain close to earlier local readings. The test passed all three repetitions without rebuilding WASM.

### Repeated million-sample plot profile (2026-10-14)

The profiled Firefox/Chromium benchmark was rerun with the existing local `-O2` runtime on fresh dev-server ports. The worker now forwards its dev-only profile through the existing progress channel; the app logs it on the main thread so Playwright can capture it consistently. Both browsers solved 1,000,130 samples and rendered eight windows with 32 traces. Chromium result-ready was 4,016 ms (24 ms module load, 3,538 ms in ngspice, 40 ms result processing, 185,794,560-byte WASM linear-memory capacity); Firefox was 10,045 ms (72 ms module load, 9,677 ms in ngspice, 39 ms result processing, same WASM capacity). Warm End/Home/End scrubs were 42/33/29 ms in Chromium and 60/36/39 ms in Firefox. The 16 ms timer observer's maximum excess during cursor scrubbing was 7.8 ms and 9 ms respectively; the largest all-phase delays were 97 ms during Chromium solve and 38 ms during Firefox solve. Chromium renderer heap reported 39.6/50.4 MB before and after; Firefox does not expose that API. These are single-run same-host observations, not stable cross-device results. An `-O3` comparison remains unavailable because Emscripten is not installed; no WASM rebuild or Pages workflow ran.

### Transient plot range-scan fusion (2026-10-14)

Transient auto-ranging now derives exact voltage/current bounds from the extrema-preserving sample indices already used to draw each trace, removing the previous second full-range scan per visible vector. A 1,000,000-sample unit fixture confirms those indices retain the exact min/max. The real browser workload still solves 1,000,130 samples and renders 32 traces in eight windows. Three post-change Chromium runs reported result-ready at 3,945–4,006 ms and plot-validation timer excess at 22–30 ms; a preceding single run was 3,947 ms and 27 ms respectively. These measurements do not establish a wall-clock gain because solver time dominates and run variance overlaps; the change removes redundant sample reads by construction. No WASM rebuild was run.

### Fresh Firefox M4.3 profile (2026-10-14)

Ran all seven `npm run benchmark:browser -- --project=firefox` scenarios with `VITE_ELSIM_PROFILE=1`, `ELSIM_PERF_PORT=4198`, and the existing local WASM runtime; all passed in 40.4 seconds. The fresh port matters because the config can reuse an already-running Vite server outside CI, and that server does not inherit environment variables supplied to a later Playwright invocation. A first run accidentally reused such a server: its million-sample simulation passed, but the profile assertion correctly failed because no profile was enabled. The fresh-port rerun and full suite both verified the profile path; no product-code change was needed.

The million-sample circuit produced 1,000,130 samples, eight plot windows, and 32 rendered traces in 9,996 ms. The worker reported 71 ms module load, 9,671 ms in ngspice, 39 ms result processing, 9,783 ms total, and 185,794,560 bytes (177.19 MiB) of WASM linear-memory capacity. End/Home/End scrub interactions took 50.42/33.03/39.04 ms; the 16 ms timer observer measured maximum excess delay of 38 ms during simulation, 23 ms during plot validation, and 3 ms during scrubbing. Firefox exposes neither `performance.memory` heap values nor total browser/worker RSS through this test, so total process memory remains unmeasured.

The 500-instance hierarchy rendered in 357 ms and returned its operating point in 493 ms. The 24-section/40-trace transient was result-ready in 526 ms, with 29–38 ms for sampled visibility-toggle-to-two-frame updates; the nonlinear 100,126-sample/40-trace run was result-ready in 5,964 ms. The 5,000-part editor rendered in 639 ms. In the 5,000-part/4,900-wire editor, initial render was 747 ms, selection median/p95 was 11/15 ms, select-all-to-frame was 40 ms, zoom-to-two-frames median/max was 38/59 ms, and arrow navigation median/max was 19/25 ms. The 500-component animation scrub was 26.95 ms. These are single-host observations, not cross-device budgets or before/after claims. No WASM rebuild or Pages workflow ran.

### Firefox browser process-tree memory sample (2026-10-14)

The million-sample Firefox stress test was sampled from Linux `/proc` at 100 ms intervals, summing the Firefox browser process and its descendants. Across the 1,000,130-sample solve and eight plot windows with 32 traces, the Firefox process tree peaked at **1,046.2 MiB proportional set size (PSS)** and **1,383.8 MiB summed resident set size (RSS)**. PSS apportions shared pages and is the more useful aggregate estimate; RSS counts shared pages once per process. The same run reported 185,794,560 bytes (177.19 MiB) of WASM linear-memory capacity, 10,016 ms result readiness, and 58.74/40.92/36.61 ms End/Home/End scrub times. Firefox does not expose page-heap metrics in this run. This is a single-run browser-process measurement on the documented host, not an application-only allocation, cross-platform budget, or before/after optimization claim. A repeat solve took 10,010 ms with similar WASM capacity and scrub times, but only the first run had the process sampler attached. Cross-machine profiling remains open.

The same million-sample scenario now accepts `ELSIM_PERF_PLOT_WINDOWS=1..8` to compare plot counts while keeping the solved circuit and four traces per window fixed. One Firefox run with a single window peaked at 1,092.9 MiB PSS / 1,465.0 MiB RSS and 9,986.7 ms result readiness; the eight-window run above peaked at 1,046.2 MiB / 1,383.8 MiB and 10,016.1 ms. Both reported the same 185,794,560-byte WASM memory capacity. These single, non-interleaved samples vary more than the apparent window-count difference and do not show that plot windows drive the high process peak; repeatable phase-specific sampling is needed before changing rendering or result retention.

### Repeated Firefox M4.3 profile (2026-10-14)

Reran all seven Firefox browser stress scenarios on a fresh Vite port with `VITE_ELSIM_PROFILE=1` and the existing ignored WASM runtime; all passed in 40.8 seconds. The 1,000,130-sample/eight-window/32-trace case was result-ready in 10,006 ms (9,570 ms in ngspice, 42 ms result processing) with 185,794,560 bytes of WASM linear-memory capacity. Three End/Home/End scrubs took 54.36/35.24/44.99 ms; the 16 ms timer observer recorded maximum excess delays of 48 ms during solve, 22 ms during plot validation, and 7 ms during scrubbing. Firefox's page heap fields remain unavailable. The 500-instance hierarchy rendered in 355 ms and solved in 478 ms. The 5,000-part/4,900-wire editor rendered in 745 ms with 64 parts and 551 wires mounted; selection median/p95 was 6/20 ms, select-all-to-frame 41 ms, zoom-to-two-frames median/max 41/57 ms, and arrow navigation median/max 17/30 ms. The 40-trace visibility-toggle update ranged from 26–55 ms to two animation frames; the nonlinear 100,126-sample/40-trace case was result-ready in 6,982 ms. Results are single-run same-host observations and do not establish a gain, regression, or browser-process memory budget. No WASM build or Pages deployment ran.

### Current cross-browser UI performance checkpoint (2026-10-14)

The focused Chromium/Firefox browser benchmarks passed against the existing local runtime. A 500-instance, 1,003-vector hierarchical circuit rendered 14 in-viewport parts in 375/356 ms and reached operating-point results in 428/537 ms in Chromium/Firefox. The 5,000-part/4,900-wire schematic mounted 64 parts and 551 wires; initial render was 639/756 ms, selection median/p95 5.1/9.4 ms and 9/18 ms, Ctrl+A-to-frame 31.5/45 ms, zoom-to-two-frames median/max 31.9/77.6 ms and 40/55 ms, and arrow-navigation median/max 26.8/30.5 ms and 17/20 ms. These are one-host samples consistent with prior measurements; no code change or speculative renderer rewrite is justified by them. No WASM rebuild or Pages workflow ran.

### Pointer-dismiss handler cleanup (2026-10-14)

The app-shell pointer-down handler now checks the one animation-settings `<details>` element through a ref instead of querying the whole document, and avoids updating sheet-menu state when no sheet menu is open. This handler runs on every pointer-down, including schematic drag starts. Firefox verifies outside clicks dismiss both menus while preserving wire selection and sheet-menu actions. The 5,000-part/4,900-wire interaction benchmark passed after the change: Chromium rendered in 616 ms with 5.3/9.7 ms selection median/p95; Firefox rendered in 788 ms with 10/16 ms selection median/p95. These single samples are consistent with the immediately preceding run and do not establish a speedup. No WASM rebuild was needed.

### Firefox UI audit checkpoint (2026-10-14)

The 95 tagged engine-independent Firefox UI-smoke tests passed, including focus visibility and names, full-circuit copy/paste followed by moving only the pasted selection, responsive canvas guidance, wire selection, hover/delete targeting, dialogs, and editor shortcuts. The separate focused clipboard regression and both accessibility checks also passed. All 34 unit groups and TypeScript passed. A fresh 5,000-part/4,900-wire run mounted 64 parts and 551 wires; initial render was 762 ms, selection median/p95 9/15 ms, Ctrl+A-to-frame 45 ms, zoom-to-two-frames median/max 38/52 ms, and arrow-navigation median/max 17/23 ms. These are one-host readings within the existing range and do not establish a gain or regression. No reproducible UI defect surfaced in this checkpoint, so no speculative renderer change was made. No WASM build or Pages workflow ran.

### Eight-window Firefox plot recheck (2026-10-14)

The existing local runtime solved 1,000,130 transient samples and rendered 32 traces across eight plot windows in 10,067 ms. End/Home/End cursor interactions took 53.31/48.71/36.57 ms; the 16 ms interval observer recorded maximum excess delays of 40 ms during solving, 17 ms during plot validation, and 7 ms during cursor scrubbing. Firefox did not expose page-heap or WASM-memory values in this run. This is consistent with earlier same-host profiles and does not indicate a new plot-rendering bottleneck. The runtime was reused; no WASM build or Pages workflow ran.


### Quick domain profile repeat (2026-10-14)

`npm run benchmark:performance:quick` (benchmark version 10, seven measured runs after two warmups) rechecked the domain, hierarchy, and plot paths without invoking the local ngspice runtime. It ran on the documented i7-12700F host.

| Fixture | Size | Connectivity median / p95 (ms) | Netlisting median / p95 (ms) | Full circuit checks p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Labeled resistor chain | 5,000 resistors | 36.97 / 42.33 | 48.39 / 57.22 | 48.82 |
| Two-endpoint wire grid | 5,000 resistors, 4,900 wires | 34.63 / 46.64 | 41.23 / 49.59 | 54.40 |
| Two-level repeated hierarchy | 5,000 root instances | 76.77 / 87.37 | 110.21 / 133.34 | 104.11 |

All remain within the current 500 ms domain targets. One-million-sample cold plot reduction was 1.04 ms median / 1.04 ms p95 with the 902-point bound. The quick profile does not measure browser rendering, solver execution, or cross-machine behavior; no new optimization was justified by these measurements.

### Firefox 5,000-part interaction recheck (2026-10-14)

The existing `editor-wire-heavy-navigation-v9` Playwright benchmark was rerun on Firefox after the full UI audit. With 5,000 parts and 4,900 independent two-endpoint wires, initial render was **760.93 ms**; viewport culling mounted 64 parts and 551 wires. Selection median/p95 was **6/18 ms**, select-all-to-frame **46 ms**, zoom-to-two-frames median/max **40/57 ms**, and arrow-navigation median/max **18/21 ms**. The focused benchmark passed. These are one-host measurements, consistent with the preceding Firefox profile; they do not establish a cross-device budget or justify speculative renderer changes. No WASM rebuild or Pages workflow ran.

### Quick domain profile repeat (2026-10-14 follow-up)

A fresh `npm run benchmark:performance:quick` run (benchmark version 10, two warmups and seven measured runs) on the documented i7-12700F host confirmed the large domain paths remain inside the existing 500 ms budget:

| Fixture | Size | Connectivity p95 (ms) | Netlisting p95 (ms) | Full circuit checks p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Labeled resistor chain | 5,000 resistors | 47.90 | 63.29 | 55.04 |
| Two-endpoint wire grid | 5,000 resistors, 4,900 wires | 47.51 | 49.48 | 62.79 |
| Two-level repeated hierarchy | 5,000 root instances | 88.72 | 135.58 | 111.55 |

One-million-sample cold plot reduction was 1.04 ms p95 with the 902-point cap. Compared with the previous quick repeat, results remain within same-host variance and do not point to a new domain bottleneck. This does not measure UI rendering, ngspice runtime, or cross-machine behavior.

### Firefox UI audit and large-schematic recheck (2026-10-14)

The complete 172-workflow engine-independent Firefox suite passed. The focused 5,000-part/4,900-wire benchmark mounted 64 parts and 551 wires; initial render was 808 ms, selection median/p95 10/31 ms, select-all-to-frame 41 ms, zoom-to-two-frames median/max 40/57 ms, and arrow-navigation median/max 26/29 ms. These single-run values remain consistent with prior same-host results and do not establish a regression or speedup. An additional UI optimization caches imported symbol drawing bounds across repeated IC instances; its bounds and cache reuse are covered by a unit regression, but the browser benchmark does not isolate that path. No WASM rebuild or Pages workflow ran.

### Imported-library dependency indexing (2026-10-14)

The quick domain benchmark now includes 501 imported model libraries and 500 project-local `.LIB filename section` references to a shared library. The analysis resolved all 500 references with a median of **9.33 ms** and p95 of **9.67 ms** on the documented i7-12700F host. Dependency analysis indexes asset basenames once and caches each target library's section list, avoiding a full imported-asset scan and repeat section parse for each reference. This synthetic fixture is a scaling check, not a user-facing latency budget; it does not include browser rendering or ngspice solving.

### Repeated result-animation scrub baseline (2026-10-14)

The focused `browser-500-component-animation-scrub-v2` test was run three times in fresh contexts per browser with the existing local ngspice runtime. The fixture has 501 parts, 1,001 vectors, and 119 transient samples; it animates 19 visible parts initially and all 501 after Fit all. End-keyboard scrub-to-readout times were 33.32, 37.07, and 34.06 ms in Chromium (median 34.06 ms), and 47.57, 50.59, and 49.89 ms in Firefox (median 49.89 ms). These include Playwright keyboard interaction and assertion time, not pure frame time. The earlier same-host Firefox pair measured 49.10 and 55.98 ms (median 52.54 ms); the overlap does not demonstrate a rendering gain. A controlled before/after comparison remains open. No WASM build or Pages workflow ran.

### Production entry bundle breakdown (2026-10-14)

`npm run build` passed and emitted a 562.59 KB minified application entry (161.18 KiB gzip), above Vite's advisory threshold, with total initial JavaScript and CSS at 230.6/245 KiB gzip. A temporary Rollup `generateBundle` report attributed 554,927 rendered bytes to `src/ui/App.tsx`, 78,319 to `src/domain/project.ts`, 77,371 to `src/domain/subcircuitLibrary.ts`, and 48,791 to `src/domain/componentDefinitions.ts`; these are module contributions before minification and are not additive download sizes. The startup budget still passes, and this report does not show an initial-load latency regression. Do not split chunks just to silence Vite; compare browser startup and interaction behavior before/after any proposed extraction. Source-map output was generated locally for this inspection only and is not part of the application artifact.

### Firefox performance suite recheck (2026-10-14)

All seven `npm run benchmark:browser -- --project firefox` cases passed against the existing ignored local ngspice runtime; no runtime compilation was performed. The 500-component/1,001-vector animation scrub took 51.60 ms. A million-sample transient rendered 32 traces across eight plot windows, reached results in 11.00 s, and recorded scrub times of 66.71/42.74/34.70 ms; Firefox did not expose heap or WASM-memory readings. Forty-trace plot visibility toggles took 0 ms synchronously and 22–42 ms through two frames. The 24-diode, 100,126-sample nonlinear circuit became result-ready in 6.97 s. In the 5,000-part/4,900-wire editor, initial render was 791 ms, selection median/p95 12/17 ms, select-all-to-frame 71 ms, zoom-to-two-frames median/max 42/57 ms, and arrow-navigation median/max 18/21 ms. Values remain consistent with previous same-host results and do not establish a new bottleneck or a cross-device budget. No WASM rebuild or Pages workflow ran.

### Firefox multi-trace waveform recheck (2026-10-14)

The focused `browser-24-section-40-trace-transient-v3` benchmark passed on Firefox with 10,012 solved samples and 40 selected traces. Each plotted polyline was capped at 452 points. Four single-trace visibility toggles took 24–33 ms from input through two animation frames; synchronous handlers measured 0 ms. Toggling all traces sequentially took 1,334 ms across the full test sequence, which intentionally waits a frame after each of 80 button changes and is not a single user interaction. The single-run result does not justify a broad plot rewrite; repeat profiling is needed before claiming a performance change. Existing local WASM was reused.

### Firefox 500-component full-canvas scrub follow-up (2026-10-14)

The focused 500-component/1,001-vector benchmark passed five fresh Firefox contexts against the existing local WASM runtime. The viewport scrub-to-readout measurements were 43.99, 43.99, 37.64, 45.33, and 37.78 ms (median 43.99 ms); after Fit all revealed all 501 components, the full-canvas scrub measured 73.10, 75.05, 79.04, 76.10, and 75.10 ms (median 75.10 ms). Both measurements include Playwright keyboard interaction and a UI assertion, so they are diagnostic end-to-end timings rather than frame-only measurements. The full-canvas case is slower, but this synthetic result alone does not identify the responsible renderer work or prove a regression; it should guide a controlled profile before changing cursor update behavior. No WASM rebuild or Pages workflow ran.

The benchmark now also records DOM mutations during the two scrub phases. Three instrumented Firefox repeats measured 40.89/100.92 ms, 41.29/75.73 ms, and 48.85/71.97 ms (viewport/full-canvas); each phase produced 11 mutation records, affecting only two schematic component groups. The observer and Playwright action/assertion add measurement overhead, so compare these values only with matching instrumented runs. The component mutation count rules out a broad React rerender of all 501 parts; it does not isolate browser SVG paint time. No renderer change is justified by this profile alone.

### Firefox UI recheck and 5,000-part performance repeat (2026-10-22)

All 125 tagged engine-independent Firefox UI-smoke workflows passed, along with all 34 unit-test groups, TypeScript, and the production build. Initial JavaScript and CSS measured 234.0 KiB gzip against the configured 245 KiB budget (221.1 KiB JavaScript and 12.9 KiB CSS). The main JavaScript entry still triggers Vite's raw-size advisory, but its gzip size remains within budget and the heavier editors, plots, examples, and import tools are already lazy-loaded.

The focused `editor-wire-heavy-navigation-v9` benchmark was repeated three times in Firefox with 5,000 parts and 4,900 two-endpoint wires. Initial render measured 993.01, 913.83, and 968.67 ms (median 968.67 ms); selection median/p95 was 11/24 ms, select-all-to-frame was 51–55 ms, zoom-to-two-frames median was 35–50 ms, and arrow navigation median was 18–21 ms. The preceding single-run render measurement was 760.93 ms. The host load average was 8.02 while collecting the repeat, so the render difference is not attributable to application changes or a stable regression; interactive timings remain consistent with the prior check. Repeat on an idle or second machine before treating startup rendering as a target. No UI renderer change, WASM rebuild, or Pages workflow was made.

### Firefox performance suite recheck (2026-10-23)

All seven `npm run benchmark:browser -- --project firefox` workflows passed using the existing local ngspice WASM runtime. The 500-component/1,001-vector animation scrub measured 45.49 ms in the initial viewport and 85.97 ms after Fit all; each scrub changed only two component groups (11 DOM mutation records). A 500-instance hierarchy reached the editor in 375 ms and solved its operating point in 469 ms. The million-sample transient completed in 11.00 s with 1,000,130 solved samples and 32 traces across eight plots; repeated scrub timings were 97.21/36.41/33.39 ms. Firefox did not expose heap or WASM-memory readings. Forty-trace waveform rendering reached 10,012 samples in 494 ms; the 100k-sample nonlinear diode run completed in 6.97 s. For 5,000 parts, the editor was ready in 679 ms and selection median/p95 was 6/18 ms. For 5,000 parts plus 4,900 wires, render readiness was 810 ms, selection median/p95 12/16 ms, select-all-to-frame 47 ms, zoom-to-two-frames median/max 40/60 ms, and arrow-navigation median/max 21/32 ms. These are local single-run observations, not cross-device guarantees. No WASM rebuild, UI code change, or Pages workflow ran.

The million-sample Firefox case was then repeated alone with `VITE_ELSIM_PROFILE=1`, which enables worker profiling and asserts a positive Emscripten linear-memory capacity. It solved 1,000,130 samples and reported 185,794,560 bytes (177.2 MiB) of WASM linear-memory capacity; worker timings were 59 ms module load, 10,012 ms solver, 41 ms result processing, and 10,115 ms total. Browser result-ready was 11,027 ms, with scrub timings 93.21/35.36/39.41 ms. Firefox page-heap fields remained unavailable. This is allocated WASM linear-memory capacity for this run, not peak browser-process memory or a cross-device budget. Existing WASM was reused.

### Firefox UI and waveform performance audit repeat (2026-10-23)

All seven `npx playwright test --config playwright.performance.config.ts --project=firefox` cases passed against the existing local runtime. The 500-component/1,001-vector scrub benchmark mounted two components initially; viewport and full-canvas scrubs changed two component groups and took 42.15/80.72 ms end-to-end. Input-to-second-animation-frame was 10/13 ms, so the larger automation round trip does not indicate a matching application render stall. A million-sample transient rendered 32 traces across eight windows and reached results in 9.996 s; repeated scrub times were 75.38/36.84/35.72 ms, and the largest sampled timer delay was 43 ms during simulation, 14 ms during plot validation, and 7 ms during scrubbing. The 40-trace UI rendered with 452 points per trace; single visibility toggles took 23–38 ms through two frames and 0 ms synchronously. The 24-diode/100,126-sample case reached results in 5.955 s. In the 5,000-part/10,000-label fixture, editor ready was 646 ms, select-all-to-frame 22 ms, and full selection drag 21 ms; in the 5,000-part/4,900-wire fixture, ready was 751 ms, mounted 64 parts/551 wires, select-all-to-frame was 48 ms, zoom median/max was 39/55 ms, and arrow navigation median/max was 19/29 ms. The hierarchy fixture reached editor and operating-point results in 345/460 ms. These are local observations, not cross-device budgets. No new UI bottleneck or safe renderer rewrite was identified; no WASM build or Pages workflow ran.


### Firefox phase-specific process memory sampling (2026-10-23)

`npm run benchmark:browser:memory -- --plot-windows 1` (or `8`) runs the focused million-sample Firefox benchmark with the existing WASM runtime and samples Firefox process-tree `/proc/<pid>/smaps_rollup` every 100 ms. The sampler identifies Firefox process roots and includes all descendants. Logged phase markers divide samples into startup, solver/result transfer, result validation/transfer, and plot/cursor interaction. Use `--repeats 2` through `--repeats 5` to launch fresh browser runs and report per-phase PSS/RSS medians and ranges; the default is one run. PSS and summed RSS include Firefox and descendants, not ELSim-only allocations, and the solver/result-transfer phase includes result creation before the worker profile marker.

Three corrected one-window runs peaked at 969.4, 1,004.1, and 990.4 MiB PSS (median 990.4 MiB); three eight-window/32-trace runs peaked at 1,036.2, 1,046.3, and 1,081.6 MiB (median 1,046.3 MiB). The two runs with a two-second post-result hold recorded post-profile PSS maxima of 627.8 MiB (one window) and 687.0 MiB (eight windows); the corresponding pre-profile peaks were 990.4 and 1,081.6 MiB. All six runs reported the same 185,794,560-byte WASM linear-memory capacity. The approximate 56 MiB median overall-peak difference is only a same-host observation; background process load and non-interleaved run variance remain, so it is not a memory budget or proof that plot count alone caused the difference. Firefox page-heap values remain unavailable. The sampler is Linux-only and reads `/proc`; a second representative machine and stronger allocation attribution remain M4.3 work.

### Alternating plot-window memory check (2026-10-25)

Ran four fresh Linux/Firefox process profiles in alternating order (1, 8, 8, 1 windows), using the same million-sample circuit, local WASM, 100 ms sampler, and all three phase markers. One-window solver/result-transfer PSS peaks were 1,083.1 and 980.4 MiB; eight-window peaks were 1,037.8 and 1,112.1 MiB. The total-peak ranges overlap and reverse order does not yield a stable plot-count effect. During the post-result plot/cursor phase, the one-window peaks were 651.9/664.2 MiB and eight-window peaks were 749.4/784.6 MiB; this repeated increase is process-tree PSS, not ELSim-only memory, and includes Firefox rendering/process allocations. The ngspice solve/result-ready times and 177.2 MiB WASM capacity remained essentially the same across configurations. Two Chromium runs of the same fixture showed `performance.memory.usedJSHeapSize` unchanged at its reported precision before versus after: 37.3 MiB for one window and 33.1 MiB for eight. That API excludes worker memory and does not attribute graphics/process memory. Existing plot code also shares downsampled indices and formatted polyline strings for identical trace/view keys. These observations do not identify a safe app-side memory optimization; second-hardware and browser-process attribution remain open.

### Result-file cleanup and phase-boundary memory sample (2026-10-23)

The ngspice worker now removes each `.raw` file from Emscripten's virtual filesystem immediately after reading it into a standalone buffer, and processes parameter-sweep result files one at a time. A focused Firefox million-sample run passed with 1,000,130 samples, five result vectors, 177.2 MiB WASM linear-memory capacity, 9.77 s ngspice solve, and 40 ms result parsing. A separate Firefox process-tree sample after the change peaked at 1,039.1 MiB PSS during the combined solver/result-transfer interval, 656.7 MiB during result validation/transfer, and 630.1 MiB during plotting and cursor interaction. The run verifies the workflow, but the one-run result and non-app-specific process measurement do not establish a memory reduction.

The sampler now records a process-memory sample at each phase boundary as well as on its 100 ms interval. This prevents marker lines received in one polling batch from leaving result-validation phases unmeasured. The phase sample is still an instantaneous Firefox process-tree observation, not ELSim-only allocation; a controlled before/after distribution and second-machine run remain necessary for an optimization claim.

### Firefox scrub input-to-frame profiling (2026-10-23)

The 500-component/1,001-vector animation benchmark now records the slider's `input` event, the first resulting DOM mutation, and the next two animation-frame callbacks alongside Playwright's whole keypress/assertion duration. Two Firefox runs measured full-canvas scrub round trips of 81.38 and 81.80 ms, while the first React DOM mutation occurred 0 ms after input and the second animation-frame callback occurred 5 and 11 ms after input. Viewport runs measured 49.81 and 47.06 ms end to end, with the second callback at 13 and 14 ms. Both states changed two component groups (11 mutation records). In this headless local benchmark, the larger Playwright round-trip time does not correspond to an 80 ms app-side render stall. These frame callbacks are diagnostic observations, not a physical display-presentation guarantee or a cross-device performance budget. No schematic rendering optimization is justified by this sample; the test reuses the existing local WASM runtime.

### Large waveform CSV construction (2026-10-23)

Waveform CSV download now generates at most 8,192 row strings at a time, yields between chunks, and supplies those chunks directly to the download `Blob`; it no longer stores a JavaScript row string for every solved sample and then builds a second joined full-file string. The serializer preserves the existing header, number formatting, mixed-axis columns, and complex AC columns. Unit tests compare joined chunk output byte-for-byte with the small-output serializer across chunk boundaries, and a focused Firefox/ngspice journey verifies the downloaded first-circuit CSV. The final `Blob` still retains the exported data, so this bounds temporary row-object accumulation rather than total export size; a million-row memory benchmark has not been run.

### Current quick domain profile (2026-10-23)

`npm run benchmark:performance:quick` (benchmark version 11, two warmups and seven measured runs) passed on the documented i7-12700F host. For 5,000 resistors, labeled-chain connectivity/netlisting/full-check p95 measured 46.0/56.1/52.5 ms; the 5,000-resistor/4,900-wire fixture measured 44.5/55.6/61.5 ms; and the 5,000-instance hierarchy measured 88.8/132.7/110.4 ms. One-million-sample plot reduction measured 1.03 ms median / 1.04 ms p95. The benchmark also sampled 20 visible wires out of 4,900: all-network flow sampling measured 16.6 ms median / 25.4 ms p95, while the viewport-restricted sampler was about 0.015 ms median. Connection-dot calculation from cached pin coordinates measured 5.3 ms median / 6.6 ms p95 for 9,800 dots. Group-drag model update measured 0.43 ms median / 1.29 ms p95 for 5,000 parts and 4,900 wires. Solver and browser rendering were skipped; these local domain samples do not represent UI frame times or other hardware.

### Firefox large-editor profile repeat (2026-10-23)

The focused `measure selection and navigation latency in a 5000-part wire schematic` browser benchmark passed in Firefox without invoking the simulator. The 5,000-part/4,900-wire project mounted 64 parts and 551 wires and rendered in 767.22 ms. Selection input-to-frame median/p95 was 11/13 ms, select-all-to-frame was 46 ms, zoom-to-two-frames median/max was 40/56 ms, and arrow navigation median/max was 20/31 ms. These single-host measurements are consistent with recent runs and do not show a new renderer bottleneck or establish a cross-device budget.

### Firefox full browser performance recheck (2026-10-23)

All seven `npm run benchmark:browser -- --project=firefox` cases passed against the existing local ngspice WASM runtime. The 500-component animation scrub changed two component groups; input-to-second-frame was 2 ms after viewport fit and 4 ms across the full canvas. The 500-instance hierarchy reached editor/operating-point results in 353/454 ms. The 1,000,130-sample transient with 32 traces across eight windows reached results in 10.01 s; repeated scrub measurements were 85.27, 32.84, and 46.26 ms, with maximum sampled timer delays of 43 ms during simulation, 17 ms during plot validation, and 13 ms during cursor scrubbing. The 40-trace test rendered at most 452 points per trace; four individual visibility toggles took 24–34 ms through two frames, while the 1,333 ms full-toggle aggregate intentionally waits one frame after each of 80 operations. The nonlinear 100,126-sample/40-trace result took 5.98 s. The 5,000-part editor mounted 64 parts/551 wires and rendered in 766 ms; selection median/p95 was 6/11 ms, select-all 47 ms, zoom median/max 36/57 ms, and arrow navigation median/max 18/28 ms.

An eight-window `npm run benchmark:browser:memory -- --plot-windows 8` repeat completed 1,000,130 samples in 11.04 s. The worker profile attributed 9.762 s to ngspice solve, 40 ms to result processing, and reported 185,794,560 bytes (177.2 MiB) of WASM linear-memory capacity. Linux process-tree peak was 1,064.3 MiB PSS / 1,424.1 MiB RSS during the combined solve/result-transfer phase, 968.4/1,323.9 MiB during result validation/transfer, and 724.7/1,086.5 MiB during plot interaction. These process figures include Firefox and all descendants, not ELSim-only allocations. Firefox heap APIs were unavailable. This is one same-host run, not a before/after comparison or a memory budget; a second hardware profile and repeated phase distributions remain open. No WASM build or Pages workflow ran.

### Culling margin allocation review (2026-10-23)

`CircuitPartLayer` calculates each part's small bound directly when building the spatial index or rendering visible parts, without allocating an intermediate ID-to-margin map for every part whenever the parts array changes. Imported-symbol bounds are held in a `WeakMap` keyed by parsed symbol object and calculated only when a placed part uses that symbol, avoiding work for unplaced imported symbols and reusing bounds across part edits. Culling bounds and symbol geometry are unchanged. TypeScript, all 38 unit-test groups, the production build, both large-project Firefox benchmarks, and focused imported-symbol/fit-view Firefox checks pass. The 5,000-part/4,900-wire run rendered in 826.86 ms, with selection median/p95 8/19 ms, select-all-to-frame 41 ms, zoom median/max 40/49 ms, and arrow navigation median/max 16/18 ms. The 5,000-part/10,000-label run rendered in 631.18 ms and measured 20 ms group drag, 25 ms select-all, and 21/24 ms zoom median/max. A follow-up 5,000-part/10,000-label run rendered in 703.12 ms with 24 ms group drag, 26 ms select-all, and 21/31 ms zoom median/max. These isolated values vary and do not establish a before/after speedup; the change removes redundant per-part storage and avoids bounds work for unused symbols. No WASM build or Pages workflow ran.

### UI selection update and full browser audit (2026-10-23)

App-level selection setters now skip React state updates when the ordered selected IDs are unchanged, avoiding redundant parent and memoized-schematic work while preserving wire selection order. TypeScript, all 661 unit tests, all 149 engine-independent Firefox UI workflows, four focused Firefox mixed-selection/copy-paste regressions, the production build, and all 16 Chromium/Firefox browser-performance tests pass. The 5,000-part/4,900-wire schematic rendered in 620/754 ms in Chromium/Firefox; select-all-to-frame was 30/56 ms in the Chromium/Firefox browser suites respectively (the focused post-change Firefox rerun measured 40 ms). The 500-instance hierarchy reached operating-point results with 1,003 vectors in 429/505 ms. The million-sample transient with 32 traces across eight plot windows completed in 3.96/10.08 s, with warmed Firefox scrubs at 34.92–47.44 ms after the initial 107.25 ms sample. The 501-part animation scrub changed only two visible component groups and took 34.45/64.8 ms in the viewport in Chromium/Firefox. These are single-run observations; they do not establish a before/after gain for the no-op selection guard or a cross-device budget. The existing SVG viewport culling, memoized schematic layers, bounded trace sampling, and worker transfer paths remain the measured architecture; no broad renderer rewrite is supported by this run. No WASM rebuild or Pages workflow ran.
# Waveform CSV trace selection lookup (2026-10-23)

CSV export now builds a `Set` from the selected trace IDs before filtering the result vectors. This preserves the result-vector order and selected-trace behavior while avoiding repeated linear searches through the selected IDs. A local synthetic lookup comparison with 10,000 vectors and 5,000 selected IDs measured 55.96 ms median / 56.67 ms p95 with `Array.includes`, versus 0.28 ms / 0.50 ms with a `Set`. This isolates only the ID-selection stage; CSV row formatting, memory, and end-to-end export duration were not measured. TypeScript and the Firefox RC first-use workflow, including selected voltage/current CSV export with the existing local ngspice runtime, pass. No WASM rebuild or Pages workflow ran.

### Firefox full browser performance audit repeat (2026-10-23)

All seven `npm run benchmark:browser -- --project=firefox` workflows passed against the existing local ngspice WASM runtime. The 500-component animation test updated two component groups; viewport scrub took 42.52 ms end-to-end and the full-canvas scrub 75.41 ms, while the second animation frame followed the input by 13 and 20 ms. The 500-instance hierarchy reached editor/operating-point results in 352/457 ms. The million-sample transient with 32 traces across eight windows reached results in 9.99 s; repeated scrubs were 85.07, 33.25, and 46.80 ms, with maximum sampled timer delays of 47 ms during simulation, 24 ms during plot validation, and 12 ms during scrubbing. The 40-trace/10,012-sample test rendered at most 452 points per trace, and the 100,126-sample nonlinear case reached results in 6.02 s. In the 5,000-part/10,000-label fixture, editor ready was 633 ms, select-all-to-frame 21 ms, and full group drag 24 ms. In the 5,000-part/4,900-wire fixture, render readiness was 753 ms, mounted 64 parts/551 wires, selection median/p95 was 6/19 ms, select-all-to-frame 46 ms, zoom median/max 42/57 ms, and arrow navigation median/max 19/23 ms. These are local observations, not cross-device budgets; results are consistent with recent same-host runs and do not point to a new broad renderer bottleneck. No WASM rebuild or Pages workflow ran.

### Firefox trace-visibility memo check (2026-10-23)

The focused 40-trace/10,012-sample Firefox benchmark was repeated before and after wrapping each SVG polyline in a memoized component. The four click-to-two-animation-frame samples were 23/34/33/32 ms before and 24/33/33/32 ms after; solver/result readiness was 979/1,009 ms. The change did not improve the measured interaction, so it was discarded. The two-frame interval includes browser frame scheduling and does not isolate React or paint cost; no trace-render bottleneck is established by these samples. The final renderer remains unchanged. No WASM rebuild or Pages workflow ran.

### Firefox maximum-trace visibility profile (2026-10-23)

The focused browser benchmark uses the maximum 256 saved traces supported by one plot window and 10,012 ngspice samples. It renders 452 points per trace (under the 902-point cap), reaches results in about 2.0 s, and verifies that hiding one trace removes its plotted line. Across five post-change runs, a visibility click through two animation frames took 27–45 ms. The one pre-change sample was 37 ms; this range overlaps and does not demonstrate an end-to-end latency gain. The UI now caches sampled indices and value ranges by selected trace and visible time range. A visibility-only update aggregates cached ranges for the currently shown traces instead of rereading about 115,000 sampled values across 256 traces. This bounds repeated data scanning by selected trace count and avoids it on hide/show, but the browser timing remains inconclusive. No WASM rebuild or Pages workflow ran.

### Firefox focused UI audit (2026-10-23)

The 501-part/1,001-vector animation scrub benchmark updated only the two visible component groups and recorded 11 DOM mutations. Firefox scrub time was 45.84 ms in the normal viewport and 74.44 ms after fitting all 501 components; the second animation frame followed the input by 5 ms and 12 ms respectively. The 500-instance hierarchy benchmark mounted 14 parts initially, reached editor readiness in 374 ms, and produced the 1,003-vector operating-point result in 509 ms. These single-host readings do not establish a regression or justify a renderer rewrite. Four focused Firefox regressions passed for wire selection, full-circuit paste selection, repeated paste, and mixed component/wire/label movement. TypeScript and all 38 unit-test groups pass. No source code, WASM runtime, or Pages deployment changed.

### AC/noise visibility range reuse (2026-10-23)

AC magnitude/phase and noise plots now cache each selected trace's extrema-preserving indices and the corresponding transformed or raw range for the current mode and frequency viewport. Visibility changes aggregate those cached ranges for the visible traces rather than rereading every sampled value for overall dB/phase limits or per-unit noise axes. Four focused Firefox/ngspice workflows pass for AC mode/range changes, voltage- and current-noise scaling, and DC sweep behavior; AC and voltage-noise tests also disable and restore a trace and verify its plotted line. This change removes repeated sampled-value scans by construction; no separate AC/noise wall-time comparison was run. No WASM rebuild or Pages workflow ran.

### Lazy reusable-sheet settings dialog (2026-10-23)

The reusable-sheet ports/parameters dialog is now a lazy-loaded UI module, fetched only when its settings action is opened. The production build emitted a separate 7.30 kB / 2.32 KiB gzip `SheetSettingsDialog` chunk. Initial JS+CSS gzip fell from 237.6 to 236.6 KiB; the raw main entry fell from 583.81 to 578.25 kB. Three focused Firefox workflows covering port edits, parameter overrides, and child-sheet undo/redo pass. The user-visible behavior is unchanged except that opening this rarely used dialog may wait for the component chunk on first use; an accessible loading status is shown during that request. No WASM build or Pages workflow ran.

### Lazy multi-section model import dialog (2026-10-23)

Single-file and batch model-section selection now lives in a lazy-loaded component, fetched only when an imported model library needs a section choice or the dependency report requests a section repair. The build emitted a separate 4.24 kB / 1.32 KiB gzip chunk. With both the sheet-settings and model-sections dialogs deferred, initial JS+CSS gzip is 235.9 KiB (down from the prior 237.6 KiB); the raw main entry is 574.82 kB (down from 583.81 kB). Firefox keyboard accessibility, multi-file section selection, and punctuated/numeric section-name workflows pass. The dialogs show an accessible loading status while their chunks load. No WASM build or Pages workflow ran.

### Shared active-sheet object indexes (2026-10-23)

The app-level inspector and memoized schematic now share the memoized parts-by-ID and net-labels-by-ID maps for the same immutable scene arrays, removing duplicate full-array map allocations on scene edits. The wire map remains local to the schematic. Focused Firefox net-label context and full-circuit paste-selection workflows pass, as does the 5,000-part/4,900-wire benchmark (779 ms render; 6/11 ms selection median/p95; 74 ms select-all; 37/55 ms zoom median/max; 19/24 ms navigation median/max). The build reports 236.0 KiB initial JS+CSS gzip and a 574.73 kB raw main entry. The benchmark is within prior same-host variance, so this is an allocation reduction without a claimed frame-time gain. No WASM build or Pages workflow ran.

### Analysis settings source indexing (2026-10-23)

`validateAnalysisSettings` now filters the schematic part list once to collect voltage/current sources, then reuses that list for transient pulse/SINE/EXP/SFFM/PWL checks and AC, noise, and DC source validation. For transient analysis this replaces five full-array source filters with one full-array collection plus filters over the smaller source list; operating-point analysis avoids collecting sources. All 38 unit-test groups, focused Firefox invalid-pulse and voltage-source waveform workflows, TypeScript, and production build pass. This is a reduction in array passes, not a measured wall-time claim. No WASM build or Pages workflow ran.

### Full browser UI and performance recheck (2026-10-23)

All 144 engine-independent Firefox `@ui-smoke` tests and all 14 Chromium/Firefox browser performance cases passed against the existing local runtime. The 5,000-part/4,900-wire editor rendered in 617.88 ms in Chromium and 757.13 ms in Firefox; selection median/p95 was 5.6/10 ms and 7/14 ms, respectively. The 5,000-part/10,000-label fixture rendered in 566.03 ms and 634.48 ms, with 64 detailed parts and 105 visible labels mounted in both browsers. In the million-sample transient with 32 traces across eight windows, results arrived in 3.95 s in Chromium and 10.99 s in Firefox; the maximum sampled timer delay during the Firefox run was 47 ms during simulation and 20 ms during plot validation. The 40-trace chart rendered no more than 452 points per trace. The aggregate 1.33 s trace visibility measurement includes 80 changes, each intentionally followed by a browser animation-frame wait; individual visibility toggles took 23–37 ms through two frames. These are local single-run observations, not cross-hardware budgets. No WASM rebuild or Pages workflow ran.

### Hidden schematic labels (2026-10-23)

Schematic viewport indexing now excludes labels whose `visible` flag is false. Previously these labels were inserted into the spatial index and revisited by viewport queries before being discarded at render time. Filtering is memoized to label-list changes, reducing index storage and candidate processing when projects contain hidden labels. A focused Firefox regression verifies hidden labels stay absent from the visual and keyboard-interactive scene. No before/after timing comparison was run, so no latency gain is claimed.

### Firefox large-editor follow-up (2026-10-23)

A fresh run of the large-project editor benchmark passed in Firefox. At 5,000 parts and 10,000 visible labels, 64 detailed parts and 105 labels were mounted; editor readiness was 661 ms, select-all to frame 25 ms, group drag of 15,000 selected objects to frame 25 ms, and zoom input to two frames was 26 ms median / 32 ms maximum. Selection input-to-frame was 5 ms median / 12 ms p95. These values are consistent with recent same-host runs and do not establish a before/after improvement from hidden-label index filtering. Firefox heap counters are unavailable in this run. No WASM rebuild or Pages workflow ran.

### Firefox UI maintenance check (2026-10-23)

Two fresh large-schematic Firefox workflows pass. The 5,000-part/10,000-label case mounted 64 parts and 105 labels, became interactive in 683 ms, and measured selection at 9/12 ms median/p95, select-all at 29 ms, a 15,000-object drag at 36 ms, and zoom at 27 ms median / 31 ms maximum to two frames. The 5,000-part/4,900-wire case rendered in 846 ms, with selection at 9/18 ms median/p95, select-all at 41 ms, zoom at 41 ms median / 67 ms maximum, and arrow navigation at 20 ms median / 36 ms maximum to two frames. These single-host results are within recent history and do not identify a broad rendering bottleneck. Component rendering was cleaned up to reuse kind lookup sets and memoize custom subcircuit pin offsets during cursor-driven rerenders; no timing improvement is claimed for that allocation reduction. Firefox whole-circuit wire copy/paste and capacitor/transistor animation regressions pass. No WASM rebuild or Pages workflow ran.

### Firefox large-schematic pan baseline (2026-10-23)

Extended the 5,000-part/4,900-wire Firefox editor benchmark to measure middle-button pan input through two animation frames and assert that the schematic view changes. Three fresh runs passed; pan latency medians were 14/17/17 ms and maxima were 17/17/18 ms for a 5-step, 80×50 px drag. Each run mounted 64 parts and 551 wires; render readiness was 786–812 ms. The repeated pan results stay near one 60 Hz frame and do not identify panning as a current optimization target on this host. This is a local browser observation, not a cross-device budget. The benchmark does not rebuild or load ngspice WASM.

### Firefox one-window process memory recheck (2026-10-23)

The phase-aware Linux sampler ran the existing million-sample Firefox transient with one plot window and four traces; the existing local ngspice WASM was reused. The run solved 1,000,130 points in 11.06 s page result-ready time; the worker profile reported 9.975 s in ngspice, 40 ms in result processing, and 185,794,560 bytes (177.2 MiB) of WASM linear-memory capacity. Sampled Firefox process-tree PSS peaks were 576.5 MiB at startup, 950.7 MiB during solver/result transfer, 621.2 MiB during result validation/transfer, and 631.1 MiB during plot/cursor interaction. The phase sampler observed all required markers and collected 162 samples at 100 ms intervals. This is one run on the documented host: PSS includes Firefox and all descendants, does not attribute memory to ELSim or ngspice, and is not a cross-device budget. Its phase distribution is consistent with prior measurements; it does not identify plot rendering as the source of the high peak. Repeated distributions and a second hardware baseline remain open. No WASM build or Pages deployment ran.

### Firefox eight-window process memory recheck (2026-10-23)

Repeated the phase-aware Linux sampler with eight plot windows and 32 traces over the same 1,000,130-sample transient, reusing the existing local ngspice WASM. Page result-ready time was 11.02 s; worker profiling reported 9.99 s in ngspice, 42 ms result processing, and 185,794,560 bytes (177.2 MiB) WASM linear-memory capacity. Firefox process-tree PSS/RSS phase peaks were 606.8/963.8 MiB at startup, 1,132.3/1,495.7 MiB during solver/result transfer, 649.0/1,012.9 MiB during result validation/transfer, and 673.3/1,038.7 MiB during plot interaction. The phase sampler passed and recorded all expected markers. Compared with the same-day one-window run, the solver-phase PSS peak was about 182 MiB higher, while the later phases were close; this pair of non-interleaved runs is too small and process-wide to attribute the difference to plot count. Firefox heap remains unavailable, and process-tree measurements include the browser and its descendants rather than ELSim allocations. The repeated distribution, allocation attribution, and second hardware baseline remain open. No WASM build or Pages deployment ran.

### Shared waveform-axis validation (2026-10-23)

Each ngspice result shares one time-axis `Float64Array` across all traces. The engine-response validator now caches strict-order validation for each shared axis during that response, while still checking every trace's values and validating the axis's finite samples. An isolated Node microbenchmark of only the monotonic-axis scan for one million values and 32 shared traces measured 21.83 ms median / 28.04 ms p95 when scanning once per trace, versus 0.68 / 2.05 ms when scanning once for the response (nine runs; same host). This does not include value-vector validation, worker transfer, React rendering, or ngspice solve time. The 1,000,130-sample Firefox workflow with eight plot windows/32 traces passes; result-ready remained 11.04 s because solver time dominates, and the workflow does not isolate this validation cost. All 38 unit groups and TypeScript pass. No WASM rebuild ran.

### Firefox UI and performance sweep (2026-10-23)

All 149 Firefox `@ui-smoke` cases and all eight browser performance workflows passed against the existing local runtime. No WASM rebuild was run. The 5,000-part/4,900-wire schematic rendered in 797 ms with 64 parts and 551 wires mounted; selection median/p95 was 7/17 ms, select-all 68 ms, zoom median/maximum to two frames 37/60 ms, pan 16/19 ms, and arrow navigation 20/38 ms. The 5,000-part/10,000-label variant rendered in 658 ms with 64 parts and 105 labels mounted; select-all and a 15,000-object drag each reached the next frame in 25/27 ms, zoom was 25/31 ms, and selection was 12/15 ms median/p95. These values are single-run local observations consistent with prior same-host variation.

The 501-component/1,001-vector animation fixture changed two visible components per viewport scrub; the cursor update reached its next frame in 1 ms and second frame in 10 ms, while the full-canvas scrub reached them in 0/14 ms. The 500-instance nested hierarchy reached editor readiness in 395 ms and operating-point results in 488 ms with 1,003 vectors. The million-sample transient solved 1,000,130 samples across eight windows and 32 traces in 11.02 s; three repeated sample scrubs measured 94.97, 45.04, and 38.46 ms, with a 29 ms maximum sampled main-thread timer delay. Firefox heap and WASM memory counters were unavailable in that run.

The 40-trace, 10,012-sample fixture reached results in 1,008 ms; individual visibility-toggle-to-two-frame readings were 30–34 ms. The 256-trace stress fixture reached results in 2,020 ms and a visibility toggle in 29 ms. Five repeated runs before a per-polyline memo experiment measured 32–44 ms; five after measured 30–46 ms. The overlapping ranges do not show a meaningful renderer improvement, so the extra per-polyline memo boundary was discarded. The nonlinear 100,126-sample / 40-trace fixture reached results in 6,970 ms. Its 1,329 ms aggregate visibility figure contains 80 toggles each followed by a deliberate browser-frame wait; it is not one toggle's latency. No broad SVG-renderer change is justified by these measurements alone.

### Full local performance benchmark repeat (2026-10-23)

`npm run benchmark:performance` completed using the existing ignored `public/engine/ngspice.mjs` and `.wasm`; it does not build WASM. On the documented i7-12700F host, the 5,000-part/4,900-wire domain fixture measured connectivity at 36.1/43.7 ms median/p95 and netlisting at 44.0/60.6 ms; the 5,000-instance hierarchy measured 79.2/94.3 ms and 114.1/136.8 ms respectively. The 1,000,130-sample transient completed solve/raw writing in 2.67 s, parsed in 17.8 ms, and used 63.2 MB of WASM linear memory (the process RSS increase was about 103 MB). A retained 50 ms-to-100 ms sample window reduced the raw/vector payload by about 50%. These domain/solver measurements do not replace browser interaction or second-hardware profiling. Results are consistent with existing same-host observations and do not reveal a new hotspot requiring code changes.

### Firefox million-sample process-memory comparison (2026-10-23)

The Linux process-tree sampler was repeated twice per configuration against the existing local WASM runtime, solving 1,000,130 samples each time with 185,794,560 bytes of WASM linear memory and complete startup, pre-run, worker-profile, and result-ready phase markers. One window rendered four traces and reached results in 10.03–10.06 s; repeated cursor scrubs ranged 24–36 ms. Eight windows rendered 32 traces and reached results in 10.00–10.06 s; scrubs ranged 35–62 ms.

| Plot windows | Startup peak PSS / RSS (MiB) | Solve and result-transfer peak PSS / RSS (MiB) | Validation peak PSS / RSS (MiB) | Plot interaction peak PSS / RSS (MiB) | Overall peak PSS / RSS (MiB) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 587.2–592.7 / 937.6–943.5 | 1,004.8–1,005.3 / 1,362.1–1,362.4 | 609.1–651.3 / 966.0–1,009.4 | 661.2–661.3 / 1,019.1–1,020.2 | 1,004.8–1,005.3 / 1,362.1–1,362.4 |
| 8 | 581.0–628.6 / 932.7–981.4 | 1,041.9–1,114.1 / 1,400.5–1,472.0 | 642.1–671.8 / 1,001.4–1,029.7 | 687.3–704.1 / 1,047.9–1,062.1 | 1,041.9–1,114.1 / 1,400.5–1,472.0 |

These are two same-host observations per configuration, not a portable memory budget. PSS/RSS sum Firefox and its descendants, not ELSim-only allocations; Firefox page-heap counters were unavailable. The solve/result-transfer phase dominates both peaks. The one-window overall PSS peak was tightly grouped, while the eight-window peak varied by 72.2 MiB; more repetitions and a second machine are needed before drawing conclusions about a plot-count effect. No WASM rebuild or Pages workflow ran.

### Raw result vector retention (2026-10-23)

The browser worker now uses a trace-only raw parser that identifies displayable vectors from the complete variable-name list, then allocates typed arrays only for those vectors. The general parser still retains every variable by default. ASCII and binary fixtures verify that filtering preserves axes, metadata, and plotted values, including point-major binary alignment. This removes arrays for internal vectors by construction; no before/after browser-memory measurement was made. The focused Firefox RC simulation passed with the existing local runtime; all 38 unit-test groups and TypeScript passed. No WASM rebuild or Pages workflow ran.

The repeatable `npm run benchmark:performance:quick` synthetic raw-file case uses 50,000 points, one plotted voltage vector, one duplicated branch-current vector, and 62 hidden internal vectors (26,401,371-byte binary input). On the i7-12700F host, the all-vector parse retained 26,400,000 bytes of axis/vector arrays; trace-only parsing retained 1,200,000 bytes, a 95.45% reduction in allocated result-array capacity. The binary path also skips decoding hidden scalar values: a same-run synthetic comparison measured 44.100 ms median / 50.784 ms p95 for all vectors and 24.528 / 32.202 ms for displayable traces. These figures are local synthetic observations, not budgets or predictions for a particular browser circuit. The benchmark validates that all-vector mode retains all 65 non-axis variables while trace-only mode retains `V(out)` and `i(@r1[i])`, filtering `i(r1)` as a duplicate.

The full benchmark also compares parser modes on actual ngspice operating-point output for 100, 1,000, and 5,000 resistor sections. Those `.save all` decks produced only displayable node-voltage vectors, so trace-only mode avoided no arrays. At 5,000 sections it parsed in 6.244 ms versus 5.886 ms for all-vector mode (0.358 ms difference in this single paired run). This shows the synthetic reduction applies only when a result contains hidden or duplicate vectors; simple resistor-chain output gains no memory reduction. The million-sample transient still produces only the time axis and `V(out)` and completed raw parsing in 16.167 ms; no extra arrays were available to filter.

### Incremental pin-location update (2026-10-24)

The version-14 quick domain benchmark now compares recalculating every pin coordinate with the editor's immutable-part cache when one of 5,000 parts changes. Full recomputation measured 1.473 ms median / 2.886 ms p95; the incremental path measured 0.263/0.274 ms and returned identical coordinates and order (about 82% lower median in this run). This is a local Node microbenchmark for a one-part edit, not end-to-end browser latency. The production build passed at 236.8/237 KiB startup JavaScript and 250.5/251 KiB combined JavaScript/CSS gzip. No WASM rebuild or Pages workflow ran.

### Domain benchmark recheck (2026-10-24)

`npm run benchmark:performance:quick` completed with benchmark version 14 on the documented i7-12700F host. It skips ngspice and reports seven-run medians and nearest-rank p95 for the general cases. The 5,000-part resistor chain measured 38.422/46.990 ms for connectivity and 47.337/57.517 ms for netlisting; the 5,000-part/4,900-wire fixture measured 34.553/42.999 ms and 43.656/57.760 ms respectively. The 5,000-instance hierarchy measured 76.125/88.520 ms for connectivity and 110.323/123.655 ms for netlisting. These local results remain within the existing 500 ms domain budget.


The visible-wire current-flow comparison now uses 31 timed samples after three warmups, so its nearest-rank p95 is not simply the maximum of seven samples. On the 4,900-wire fixture, sampling 20 visible wires measured 0.009 ms median / 0.017 ms p95 with the stable set and 0.011/0.012 ms while rebuilding the set for each sample. The earlier 21 ms seven-sample p95 did not reproduce; this comparison does not justify changing the production cache. Sampling every network measured 16.308/25.388 ms. The results preserve exact per-wire flow values. These are Node domain timings, not browser animation-frame measurements. No WASM rebuild or Pages workflow ran.

The same version-14 run now includes 2,000 separate imported libraries, each declaring the same global `.PARAM`. Analysis returned all 2,000 conflict locations and measured 20.478 ms median / 21.662 ms p95. This includes parsing and is a local scaling baseline, not a before/after performance claim.

A second importer scaling case resolves 1,000 file-form `.LIB` references to one selected section in a shared 2,000-section model library. It resolved all references and measured 244.7 ms median / 297.5 ms p95, including parsing and dependency analysis. This is a local baseline, not an isolated section-lookup timing or before/after performance claim.

A third importer case contains 2,000 diode instances in one subcircuit, all referencing the same global D model. Dependency analysis resolves all 2,000 references at 12.759 ms median / 12.993 ms p95 including parsing. The repeated lookup cache is scoped by asset, subcircuit owner, and model name; this aggregate timing is a local baseline, not a before/after claim.

Importing the 2,000-section shared library used by the section-reference case validates all 2,000 selected section names. That aggregate case changed from 242.182 ms median / 280.706 ms p95 to 223.372 / 228.416 ms after replacing nested membership scans with prebuilt sets. These are one version-14 run on each side on the same machine, including parsing and all dependency checks; interpret them as an observed comparison, not a stable performance guarantee.

### Domain benchmark recheck (2026-10-23)

`npm run benchmark:performance:quick` completed with benchmark version 13 on the documented i7-12700F host. It skips all ngspice work and reports seven-run medians and nearest-rank p95. The 5,000-part resistor chain measured 37.350/43.019 ms for connectivity and 47.754/62.234 ms for netlisting; the 5,000-part/4,900-wire fixture measured 32.599/45.785 ms and 44.092/58.058 ms respectively. The 5,000-instance hierarchy measured 76.293/89.138 ms for connectivity and 110.059/122.209 ms for netlisting. The million-sample plot reducer measured 1.044/1.064 ms, and cached lookup remained below 0.001 ms median/p95. All remained within the existing 500 ms domain budget.

For the 9,800-dot wire fixture, connection-dot generation measured 7.810 ms median / 36.578 ms p95 without reusing pin locations and 5.173/5.909 ms with the editor's cached pin locations. Both versions returned identical dot coordinates and order. The current SchematicEditor already supplies cached pin locations, so this measurement confirms that optimization is active; the p95 of the uncached case is sensitive to an outlier and is not an end-to-end editor latency. The benchmark also found viewport query costs below 0.02 ms after index construction, while constructing spatial indexes costs roughly 1.6–3.8 ms. No broad renderer change follows from this isolated domain profile. This run used no ngspice runtime, did not rebuild WASM, and did not run a Pages workflow.

### Firefox cursor-update repeat (2026-10-24)

The focused 501-component / 1,001-vector animation benchmark was run five times in Firefox with the existing local WASM runtime. In the normal viewport, the Playwright scrub interval measured 41.36–61.49 ms (42.42 ms median); after fitting all 501 components, it measured 87.20–94.58 ms (90.80 ms median). Those intervals include browser automation and assertion work, so they are not frame latency. Instrumented cursor updates reached the next animation frame in 0–1 ms in all ten viewport/full-canvas samples; the second frame arrived in 3–19 ms in the normal viewport and 5–20 ms with the full schematic visible. Each scrub changed 11 DOM mutation records while two component groups had changing titles; offscreen components stayed unmounted before Fit. The repeated frame results do not show a missed first frame or justify a renderer change. This is one host and one controlled synthetic circuit; it does not establish cross-device performance. No WASM rebuild or Pages workflow ran.

### Startup transfer rebaseline (2026-10-24)

After the October 23 native component and transient-analysis additions, the production build measured **233.9 KiB startup JavaScript** and **247.5 KiB combined JavaScript/CSS gzip**, compared with 229.6/243.2 KiB at the previous rebaseline. The size guard now caps those at 235 KiB JS and 250 KiB combined; CSS measured 13.6 KiB against its 15 KiB cap. This records the measured feature growth while retaining 1.1 KiB JS and 2.5 KiB combined headroom. No browser startup-time comparison was made, so the byte totals should not be read as a measured latency change. The frontend build reuses the local runtime and does not run Pages or compile WASM.

### Startup budget reallocation (2026-10-24)

The ngspice `RSHUNT` simulation setting adds a small amount of eager project validation and toolbar UI. The build measured 235.2 KiB startup JavaScript, 13.7 KiB CSS, and 248.9 KiB combined gzip. To keep the same 250 KiB total transfer cap, the JavaScript sub-budget is reallocated from 235 KiB to 236 KiB using unused CSS headroom; the CSS cap remains 15 KiB. This records artifact size only and does not claim a browser startup-latency change. No WASM rebuild or Pages workflow ran.

### Firefox eight-window process-memory spot check (2026-10-24)

The phase-aware Linux sampler completed one Firefox run with eight plot windows and 32 traces over 1,000,130 transient samples, reusing the existing local ngspice WASM. Results became ready in 10.09 s; the worker reported 9.52 s in ngspice, 40 ms in result processing, and 185,794,560 bytes (177.2 MiB) of WASM linear-memory capacity. Firefox process-tree PSS/RSS peaks were 611.3/962.0 MiB at startup, 1,004.2/1,361.9 MiB during solve/result transfer, 630.9/989.0 MiB during validation/transfer, and 675.0/1,034.8 MiB during plot interaction. All required phase markers were observed across 160 samples at 100 ms intervals. The solve-phase PSS is within the earlier one-host observations; the peak is process-wide and does not attribute memory to ELSim, ngspice, or plot count. This is one spot check, not a repeat distribution or portable budget. No WASM rebuild or Pages workflow ran.

An immediately following one-window/four-trace Firefox run solved the same 1,000,130 samples in 10.01 s and reported the same WASM linear-memory capacity. Its process-tree PSS/RSS peaks were 528.6/878.2 MiB at startup, 1,076.9/1,434.6 MiB during solve/result transfer, 646.7/1,005.7 MiB during validation/transfer, and 665.1/1,023.9 MiB during plot interaction. All phase markers were observed across 153 samples. The one-window solve-phase peak exceeded the eight-window spot check by 72.7 MiB, demonstrating that this pair cannot establish a plot-count relationship; repeat distributions and a second machine remain open. No WASM rebuild or Pages workflow ran.

### Repeated one-window process-memory check (2026-10-24)

Added `--repeats 1..5` to the Linux memory sampler and ran two fresh one-window Firefox profiles, each solving 1,000,130 samples with four traces and 185,794,560 bytes of WASM linear-memory capacity. Both runs passed with every phase marker. Solve/result-transfer PSS peaks were 994.7 and 1,031.9 MiB (median 1,013.3); RSS peaks were 1,351.7 and 1,388.2 MiB (median 1,370.0). Across both runs, PSS ranges were 573.4–600.3 MiB at startup, 994.7–1,031.9 MiB during solve/result transfer, 627.6–681.7 MiB during validation/transfer, and 647.5–692.2 MiB during plot interaction. This confirms visible same-host run variance; two samples are insufficient for a stable distribution or memory budget. No WASM rebuild or Pages workflow ran.

### Repeated eight-window process-memory check (2026-10-24)

Ran the same two-repeat command with eight plot windows and 32 traces. Both Firefox profiles solved 1,000,130 samples, reported 185,794,560 bytes of WASM linear-memory capacity, and observed every phase marker. Solve/result-transfer PSS peaks were 1,038.8 and 1,085.5 MiB (median 1,062.2); RSS peaks were 1,395.5 and 1,443.6 MiB (median 1,419.5). Across the two runs, PSS ranges were 588.3–611.4 MiB at startup, 1,038.8–1,085.5 MiB during solve/result transfer, 651.4–675.0 MiB during validation/transfer, and 672.7–705.8 MiB during plot interaction. Compared with the two one-window runs above, the solver/result-transfer PSS median was 48.9 MiB higher and the observed ranges did not overlap. Four total runs on one host are not enough to claim a stable plot-count cost or memory budget; the sampler measures Firefox and descendants rather than ELSim allocations. No WASM rebuild or Pages workflow ran.

### Three-repeat eight-window process-memory refresh (2026-10-24)

Ran three fresh Firefox profiles with eight plot windows and 32 traces against the existing local ngspice WASM. All runs solved 1,000,130 samples, reported identical 185,794,560-byte (177.2 MiB) WASM linear-memory capacity, and observed every phase marker. Solver/result-transfer PSS peaks were 1,012.2–1,079.8 MiB (median 1,013.8); RSS peaks were 1,367.2–1,420.7 MiB (median 1,370.0). Startup peaks were 598.7–613.8 MiB PSS / 947.4–964.6 MiB RSS; plot-validation/interaction peaks were 674.4–694.4 / 1,032.5–1,048.0 MiB. Validation/transfer had a large first-run outlier: PSS/RSS ranged 657.4–963.3 / 1,014.0–1,320.1 MiB, so the median (658.8/1,016.5) is more representative of these three runs but not a stable bound. Each run completed the million-sample Firefox workflow; result-ready time was 10.02–11.07 s and worker solver time 9.63–9.94 s. PSS/RSS include Firefox and descendants, not ELSim-only memory; this remains a same-host distribution and does not establish plot-count cost or a portable budget. No WASM rebuild or Pages workflow ran.


### Wire spatial-index reuse during pin edits (2026-10-24)

The 5,000-part/4,900-wire synthetic fixture compares generating connection dots after a one-part immutable move, with the wire spatial index rebuilt versus reused from the unchanged immutable wire array. Both paths returned exactly the same dot membership and order. Across 31 measured runs after three warmups, rebuilding measured 6.282 ms median / 17.144 ms p95; reusing the index measured 5.029/5.460 ms. These are Node domain microbenchmark timings on this host, not end-to-end schematic interaction latency. The cache is keyed by wire-array identity and held in a WeakMap, so replacing wire geometry selects a fresh index and old arrays are collectible. TypeScript, all 38 unit groups, the focused Firefox connection-dot workflow, and the production build passed. The build measured 236.8 KiB startup JavaScript and 250.5 KiB combined JavaScript/CSS gzip against 237/251 KiB caps. No WASM rebuild or Pages workflow ran.

### Firefox large-schematic navigation recheck (2026-10-24)

The existing Firefox browser profile ran against 5,000 parts and 4,900 independent two-endpoint wires. It mounted 64 parts and 551 wires; initial editor readiness was 827.62 ms. Selection measured 8 ms median / 16 ms p95, select-all reached the next frame in 71 ms, zoom reached two frames in 32 ms median / 55 ms maximum across seven changed samples, pan reached two frames in 17 ms median / 17 ms maximum, and arrow navigation reached two frames in 19 ms median / 36 ms maximum. The test passed. This is a single local run: it identifies no new reproducible interaction hotspot and does not establish a cross-machine budget or an optimization gain. No WASM rebuild or Pages workflow ran.

### Reuse pin-to-wire membership after component edits (2026-10-24)

Connection-dot generation now memoizes whether an immutable pin location lies on the unchanged wire array. `PinLocation` records are reused for parts whose immutable part objects do not change; edited parts get new pin objects and are checked again. A new wire-array identity builds a fresh membership cache. On the 5,000-part/4,900-wire Node fixture, the 31-run/3-warmup cached-wire-index measurement was 4.227 ms median / 4.855 ms p95, compared with 5.057/6.013 ms in the preceding quick run (about 16%/19% lower in these sequential single-session samples). Both use the exact geometry predicates and produce identical dot membership and order; the focused Firefox T-junction/pin-join workflow passes. This is a same-host domain microbenchmark, not end-to-end latency or a cross-device guarantee. Production build passes at 236.9 KiB startup JS and 250.6 KiB combined JS/CSS gzip against 237/251 KiB caps. No WASM rebuild or Pages workflow ran.

### Quick domain benchmark repeat (2026-10-24)

A fresh version-14 `npm run benchmark:performance:quick` run on the same i7-12700F host measured the 5,000-part resistor chain at 38.984/44.334 ms connectivity and 52.353/56.560 ms netlisting (median/p95); the 5,000-part/4,900-wire fixture at 32.351/35.034 ms and 47.589/63.446 ms; and 5,000 repeated hierarchy instances at 77.689/92.721 ms and 122.430/136.540 ms. A 1,000-reference case against a 2,000-section library measured 230.155/245.977 ms including parsing and all dependency checks. The one-million-sample plot reduction measured 1.026/1.040 ms. These remain below existing domain budgets. Compared with earlier same-host figures, this is a repeat, not a controlled before/after optimization claim. The command skipped ngspice and transient benchmarks; no WASM rebuild or Pages workflow ran.

### Firefox 5,000-part editor benchmark repeat (2026-10-24)

The focused large-project benchmark passed in Firefox using 5,000 parts and 10,000 labels. It mounted 64 parts and 105 labels (921 SVG elements); editor readiness was 679.15 ms and first contentful paint was 435 ms. Select-all input-to-frame was 24 ms, full-selection drag input-to-frame was 26 ms, and zoom-to-two-frames measured 23 ms median / 24 ms maximum across six changed samples. The 100/500/1,000-part cases also completed, with editor readiness of 374.05/545.81/460.8 ms. This is a single same-host observation, not a performance budget, repeat distribution, or before/after gain; it revealed no reproducible interaction hotspot. No WASM rebuild or Pages workflow ran.

### Production startup bundle recheck (2026-10-24)

`npm run build` passed TypeScript, Vite, and the startup-budget guard. The entry's startup-critical gzip transfer was 234.2 KiB JavaScript and 14.2 KiB CSS, 248.4 KiB combined, against 239.1/15/254 KiB limits. This is 4.9 KiB below the combined JavaScript/CSS cap; it is a single build measurement, not a cross-build stability guarantee. The generated main chunk is 542.25 kB minified (151.64 KiB gzip); Vite emits its generic 500 kB minified-chunk advisory, while the project's gzip budget passes. No WASM rebuild or Pages workflow ran.

### Quick domain benchmark refresh (2026-10-24)

A fresh version-14 `npm run benchmark:performance:quick` run completed on the documented i7-12700F host. Seven-run medians / nearest-rank p95 were 39.244/47.165 ms for 5,000-part chain connectivity and 52.764/60.780 ms for netlisting; 31.479/34.436 ms and 47.033/51.158 ms for the 5,000-part/4,900-wire fixture; and 78.256/86.198 ms and 121.347/147.450 ms for 5,000 repeated hierarchy instances. The 2,000-section/1,000-reference library case measured 225.434/262.635 ms, below the 500 ms domain budget and lower than the previous 244.7/297.5 ms observation; sequential runs do not establish a before/after optimization. The one-million-sample plot reducer measured 1.018/1.037 ms. The run used `--skip-engine`, so it did not run ngspice, transient, browser, WASM-build, or Pages workflows. These are same-host local observations, not cross-device performance claims.

### Mixed-component animation frame refresh (2026-10-25)

Two focused Firefox runs and one Chromium run passed with the existing local WASM runtime on a 501-part transient containing 250 resistors, 225 inductors, and 25 transformers (1,102 result vectors). All 250 resistor glows, 225 inductor glows, and both primary and secondary glows on all 25 transformers changed when scrubbing to the final sample. Firefox viewport scrub actions measured 59.75–64.47 ms end to end; after fitting the full schematic, actions measured 463.93–627 ms. Chromium measured 38.52 ms in the viewport and 558.41 ms after fitting all parts. All full-canvas scrubs produced 638 DOM mutation records. The shared callback took 1.7–2 ms; second RAF callbacks arrived 16.6–19 ms after input. Firefox idle/playback RAF medians were 17.04–17.08 ms; Chromium medians were 16.7 ms, with one of 65 playback intervals at 33.4 ms. These headless observations include Playwright overhead, do not measure physical paint/presentation, and do not establish a cross-device performance budget. No WASM rebuild or Pages workflow ran.

### 40-trace waveform rendering refresh (2026-10-25)

The existing focused browser stress fixture solved 10,012 samples and rendered 40 selected traces in both supported engines. It retained the 902-point renderer bound (452 points maximum in this run). Result-ready times were 993 ms in Firefox and 673 ms in Chromium. Four individual visibility-toggle samples reached two animation frames in 27–35 ms and 32–34 ms respectively; synchronous event handlers rounded to 0–0.1 ms. The 1,335/1,331 ms aggregate covers disabling and re-enabling 40 traces while deliberately waiting one frame after each toggle, so it is not a single-toggle delay. These one-run measurements do not identify a new plot bottleneck or justify replacing the existing cached downsampling path. No WASM rebuild or Pages workflow ran.

### Version-15 quick domain benchmark refresh (2026-10-25)

`npm run benchmark:performance:quick` completed with two warmups and seven measured runs on the documented i7-12700F host. Median/nearest-rank p95 for connectivity and netlisting were 36.4/44.4 ms and 51.0/62.7 ms for the 5,000-part resistor chain; 31.1/46.9 ms and 47.1/65.0 ms for the 5,000-part/4,900-wire fixture; and 69.2/81.4 ms and 113.5/124.7 ms for 5,000 repeated hierarchy instances. Full circuit-check p95 was 53.3, 57.3, and 151.7 ms for those fixtures. The 2,000-section/1,000-reference imported-library case measured 169.7/175.2 ms. Cold reduction of one million plot samples measured 1.012/1.016 ms; cached lookup measured 0/0.001 ms. All remain within existing domain budgets. The quick command skipped solver, transient, browser, WASM-build, and Pages workflows; results are same-host local observations, not cross-device guarantees or a before/after optimization claim.

### Firefox UI profile refresh (2026-10-25)

The focused 5,000-part/4,900-wire Firefox workflow rendered 64 parts and 551 wires in 825.9 ms, with 38 ms median / 57 ms maximum zoom-to-two-frames, 73 ms select-all-to-frame, and 17 ms median pan-to-two-frames. The 501-part mixed-animation workflow changed every expected resistor, inductor, and transformer glow; its shared update callback measured 1 ms, the second RAF followed input by 19 ms, and idle/playback RAF medians were 17.08/17.04 ms. Its 397 ms full-canvas Playwright round trip includes repeated browser queries and assertions, so it is not an app-side frame measurement. The 256-trace visibility workflow measured 39 ms before and 43, 41, 54, 41, and 47 ms with a temporary per-polyline memoization experiment; the change was removed because the repeated result shows no improvement. All three focused Firefox workflows passed using the existing local runtime. No WASM rebuild or Pages workflow ran.

### Firefox animation profile refresh and inductor polarity correction (2026-10-25)

The 501-part Firefox resistor/inductor/transformer animation benchmark was rerun three times with `VITE_ELSIM_PROFILE=1` and the existing local ngspice runtime. The first run exposed missing current-polarity marks on inductors after the shared polarity-marker set was generalized; the inductor kind was restored and the same benchmark then passed on all three measured runs. Viewport scrub actions measured 52.14, 53.75, and 72.98 ms; full-canvas Playwright scrub actions measured 392.94, 457.96, and 466.09 ms. The instrumented shared callback measured 2, 2, and 3 ms; second-RAF arrival was 10/11/20 ms in the viewport and 26/19/20 ms with all parts visible. Every full-canvas run recorded 638 mutation records and changed all expected 250 resistor, 225 inductor, and 25 transformer-primary and transformer-secondary glows. Idle/playback RAF medians were 17.04/17.06, 17.06/17.08, and 17.08/17.08 ms; each pair recorded one interval above 1.5× its median. Relative to the preceding same-host run of this fixture (463.93–627 ms full-canvas actions, 638 mutation records, 1.7–2 ms callback, 16.6–19 ms second-RAF interval), the action ranges overlap at their boundary and the frame intervals differ; this is not a controlled before/after result and does not establish an end-to-end speedup. The fixture contains no newly shared switch, transistor, logic, LED, or current-source components, so it verifies the established shared path and catches the inductor regression rather than measuring the recent extension. No WASM rebuild or Pages workflow ran.

### Explicit saved vectors in Firefox million-sample transient (2026-10-25)

The result-control deck no longer saves every ngspice vector. ELSim now emits grouped `.save v(...)` cards for schematic node voltages and saves only exposed component-current vectors, while retaining targeted hierarchical saves. Basic RC probing, component differential-voltage probing, and a nested hierarchical-current probe all pass in Firefox against the existing ngspice WASM; all 40 unit-test groups, TypeScript, and the production startup-transfer guard pass. One eight-window/32-trace Firefox memory sample before the change measured 185,794,560 bytes (177.2 MiB) of WASM linear-memory capacity and 1,031.5 MiB process-tree PSS / 1,378.0 MiB RSS at solve peak. One matching sample after the change measured 154,796,032 bytes (147.6 MiB) and 1,050.9/1,395.6 MiB respectively. The WASM capacity fell by 29.6 MiB (16.7%) and the result contained four vectors instead of five; the process-tree peak did not fall in these single samples, so no Firefox total-memory improvement is claimed. Both runs solved 1,000,130 samples in about 9.7 s. These are same-host spot checks, not repeat distributions or portable limits; PSS/RSS include Firefox and descendants, not ELSim-only allocations. No WASM rebuild or Pages workflow ran.

### Firefox full-canvas result-animation recheck (2026-10-25)

Two focused Firefox runs of the existing 501-part resistor/inductor/transformer animation fixture passed with the existing local ngspice WASM. Viewport scrubs measured 56.75 and 64.96 ms end to end; after Fit all, the Playwright round trip was 498.71 and 409.45 ms. In both full-canvas runs, all 500 component glow nodes changed, producing 638 mutation records; the shared result-sampling callback took 2 ms, and the second animation-frame callback followed input by 19 ms. Idle/playback RAF medians were 17.06/17.08 and 17.08/17.06 ms. These figures repeat the existing observation that automated full-canvas scrub time is much larger than app callback time. They do not isolate SVG paint or physical frame presentation, so they do not justify a renderer rewrite or establish a cross-device performance limit. A future optimization should compare a controlled rendering prototype while checking every component glow value. No WASM rebuild or Pages workflow ran.

### Firefox full-canvas opacity-write reduction (2026-10-25)

The 501-part Firefox stress fixture passed after skipping SVG opacity writes whose values round to the same 8-bit raster alpha. Exact zero-to-nonzero changes remain explicit so faint glows are preserved. In one second of playback, opacity mutations were 311, compared with 9,066 in the preceding same-fixture run (about 96.6% fewer); all 250 resistor, 225 inductor, and 25 transformer primary and secondary glows still changed on a full-range scrub. The resistor glow remained nonzero at the faint end (`0.000939` before and `0.004672` after). Playback RAF median was 17.08 ms, but two of 62 intervals exceeded 1.5× the median, and the full-canvas Playwright scrub took 500.63 ms. These single runs show fewer redundant DOM writes, not a measured frame-rate or end-to-end latency improvement. No WASM rebuild or Pages workflow ran.

### Stable current-source direction during playback (2026-10-25)

A focused Firefox/ngspice regression observes a constant DC current source during 350 ms of result playback. Before the guard, the shared cursor listener rewrote its unchanged `data-current-direction` attribute on every sample; after the guard, the observer records zero such mutations. The same workflow changes current sign and verifies the source arrow reverses, preserving visible electrical direction. This is a direct mutation regression, not a frame-time benchmark. No WASM rebuild or Pages workflow ran.
