# ELSim performance benchmarks

This is a reproducible baseline, not a claim that every circuit of the same size has the same cost. The labeled fixture is a chain of 100, 500, 1,000, or 5,000 resistors. Every adjacent pair shares a named net; a 5 V source drives the first node and the final node is ground. The generated project contains `N + 1` parts, `2N + 2` labels, and `N + 1` nets. The runner verifies every pin is connected and netlisting emits no error before recording timings. A second fixture places resistors in 50-column rows and connects adjacent parts with seven-segment routed wires; it checks all pin assignments, exact segment counts, and netlist diagnostics.

Run `npm run benchmark:performance` from the repository root. It compiles the relevant TypeScript modules into a temporary directory, performs two warmups and seven measured runs for connectivity, netlisting, hierarchy, plot reduction, raw parsing, and structured cloning, reports median and nearest-rank p95, then removes the temporary build. The plot fixture runs the production extrema reducer over sinusoidal Float64 vectors with narrow injected peaks and enforces a maximum output of 902 points. If the ignored local ngspice WASM runtime exists under `public/engine`, it also runs one cold-worker operating-point solve at each of 100, 1,000, and 5,000 resistor sections, checks that node N0 remains 5 V, and records solver startup, solve, and round-trip observations. It also runs 100k- and 1M-sample transient circuits in fresh workers, parses the raw output with ELSim's production parser, and records raw/vector bytes and 10 ms sampled process RSS. RSS is process-wide and the increase is an estimate relative to the pre-run process baseline; it is not a browser heap or exact per-worker allocation measurement. It does not require the optional runtime for domain/plot measurements and does not modify project files.

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

The hierarchy generator repeatedly resolved sheet IDs with linear array searches. Replacing those searches with a per-netlist `Map` preserves the same child definitions, ports, diagnostics, and netlist format while avoiding repeated scans. A subsequent run measured the 5,000-instance hierarchy netlist at 298.878 ms p95 versus 430.732 ms immediately before the change; connectivity was 184.198 ms. The netlist observation is about 31% lower, but timings vary between runs (an earlier run measured 217.649 ms), so the benchmark is evidence of a likely improvement rather than a stable guarantee.

### Browser large transient

`npm run benchmark:browser -- --grep "million-sample transient"` runs a 1 s RC transient with a 1 µs maximum step through the actual ngspice browser worker, app response handling, result plot, and time scrubber. It selects up to five available voltage/current traces and requires at least four plotted traces, then checks at least one million solved samples, cursor readout at the last sample, and no page errors. A 16 ms main-thread timer records its largest scheduling gap during the run. `resultReadyMs` covers Run click through the completion notice. These are single local observations, not thresholds.

| Browser | Solved samples | Plotted traces | Result ready (ms) | Final scrub (ms) | Largest main-thread timer gap (ms) | Renderer heap before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1,000,130 | 5 | 7,939.78 | 109.78 | 70 | 23.1 → 23.1 MB |
| Firefox | 1,000,130 | 5 | 20,054.67 | 343.97 | 69 | unavailable |

Chromium's `performance.memory` numbers cover the page renderer and remained unchanged at the reported resolution; they do not include the dedicated worker's WASM memory. Firefox does not expose that API in this run. The timer gaps indicate that the renderer remained responsive while the worker solved and parsed results, but do not provide a worker-memory measurement. Reliable per-worker peak memory remains unmeasured.

### Browser multi-trace transient

The performance Playwright suite builds a 24-resistor DC chain, runs a 10 ms transient through the browser ngspice worker, and uses the returned 49 vectors (24 currents and 25 node voltages) to render 40 traces in the waveform plot. The test requires at least 9,000 solved samples, selects one trace per animation frame so React commits each selection, checks that rendered SVG polylines match the selected traces, and enforces the 902-point maximum per plotted trace. It uses only actual solver output.

| Browser | Solved samples | Available vectors | Plotted traces | Max rendered points/trace | Result ready (ms) | Select/render (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 10,012 | 49 | 40 | 452 | 988.61 | 701.90 |
| Firefox | 10,012 | 49 | 40 | 452 | 2,032.61 | 1,023.00 |

These are single local observations, not release budgets. They verify the combined high-trace/high-sample browser workload at this size. Larger simultaneous sample/trace counts and reliable browser/worker peak-memory measurement remain open.

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
