# ELSim performance benchmarks

This is a reproducible baseline, not a claim that every circuit of the same size has the same cost. The labeled fixture is a chain of 100, 500, 1,000, or 5,000 resistors. Every adjacent pair shares a named net; a 5 V source drives the first node and the final node is ground. The generated project contains `N + 1` parts, `2N + 2` labels, and `N + 1` nets. The runner verifies every pin is connected and netlisting emits no error before recording timings. A second fixture places resistors in 50-column rows and connects adjacent parts with independent two-endpoint wire segments; it checks all pin assignments, endpoint counts, and netlist diagnostics.

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

A repeat on 2026-10-12 with the offset-based ASCII raw parser decoded the same 1,034,006-sample, 55,759,475-byte result in 483.156 ms, about 57% below the earlier 1,127.562 ms observation on the same host and benchmark. Solve/write measured 2,976.959 ms in this run; timing varies between runs. After the parser change, the four-window browser benchmark completed in 19.048 s in Firefox and 6.973 s in Chromium, with 16 rendered traces. Immediately preceding runs were 19.030 s / 7.972 s, so Firefox end-to-end time is unchanged and the Chromium difference is a single-run observation rather than a stable gain. Scrub updates were 28.60–35.63 ms in Chromium and 39.93–76.27 ms in Firefox. Main-thread timer gaps peaked at 117.8 ms and 93 ms respectively. Raw parsing is faster, but the Firefox end-to-end solve remains dominated by work outside the UI parser.

The hierarchy generator repeatedly resolved sheet IDs with linear array searches. Replacing those searches with a per-netlist `Map` preserves the same child definitions, ports, diagnostics, and netlist format while avoiding repeated scans. A subsequent run measured the 5,000-instance hierarchy netlist at 298.878 ms p95 versus 430.732 ms immediately before the change; connectivity was 184.198 ms. The netlist observation is about 31% lower, but timings vary between runs (an earlier run measured 217.649 ms), so the benchmark is evidence of a likely improvement rather than a stable guarantee.

### Browser large transient

`npm run benchmark:browser -- --grep "million-sample transient"` runs a 1 s RC transient with a 1 µs maximum step through the actual ngspice browser worker, app response handling, result plot, and time scrubber. It selects up to five available voltage/current traces and requires at least four plotted traces, then checks at least one million solved samples, cursor readout at the last sample, and no page errors. A 16 ms main-thread timer records its largest scheduling gap during the run. `resultReadyMs` covers Run click through the completion notice. Repeated scrub measurements include End → Home → End. The first scrub may include trace setup; later cursor updates reuse memoized SVG trace geometry and do not rescan the sample vectors. These are single local observations, not thresholds.

| Browser | Solved samples | Plotted traces | Result ready (ms) | Scrubs End/Home/End (ms) | Largest main-thread timer gap (ms) | Renderer heap before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1,000,130 | 5 | 7,999.36 | 240.51 / 37.18 / 22.34 | 108 | 26.0 → 26.0 MB |
| Firefox | 1,000,130 | 5 | 20,059.97 | 45.49 / 27.78 / 28.81 | 48 | unavailable |

Cursor-only updates now avoid rebuilding sampled polyline strings; changing traces, visible time range, or value scale still rebuilds affected geometry. Chromium's `performance.memory` numbers cover the page renderer and remained unchanged at the reported resolution; they do not include the dedicated worker's WASM memory. Firefox does not expose that API in this run. The timer gaps indicate that the renderer remained responsive while the worker solved and parsed results, but do not provide a worker-memory measurement. Reliable per-worker peak memory remains unmeasured. To print worker-stage timings for this benchmark, run `VITE_ELSIM_PROFILE=1 npm run benchmark:browser -- --grep "million-sample transient" --project=firefox`; the flag only enables diagnostic console output in Vite development mode. A 2026-10-12 Firefox profile measured 78 ms module load, 16,177 ms inside ngspice `callMain`, 1,649 ms for raw file reading/parsing and trace preparation, and 17,906 ms total worker time. About 90% of worker time was in the solver, not ELSim UI code. The runtime was built with `-O2`; an `-O3` A/B build is still needed. The pinned source and current runtime are present locally, but `emcc` is not installed in the current environment.

The maximum-window Firefox profile opens eight waveform windows with four traces each (32 rendered traces), all backed by the same 1,000,130-sample transient. Result-ready time was 19,067.54 ms; End/Home/End scrubs measured 70.52 / 52.23 / 46.91 ms, and the largest 16 ms timer gap was 48 ms. The prior four-window/16-trace profile on this host measured 20,059.97 ms result-ready and scrub times of 45.49 / 27.78 / 28.81 ms. In this single-run comparison, result-ready time was similar while scrub latency rose from 28–45 ms to 47–71 ms as rendered traces doubled; the largest timer gap remained 48 ms. It demonstrates the app renders and navigates eight windows, but does not establish performance budgets or worker-memory usage. The test uses the existing local runtime and does not compile it.

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


### Large-schematic zoom latency (2026-10-12)

Firefox on the documented i7-12700F host measured pointer-wheel zoom on a 5,000-part / 10,000-label schematic through two animation frames. Before viewport-state isolation, median/p95 were 148/175 ms. Live zoom and pan state now updates inside the schematic; the view is committed to the project after 200 ms of inactivity, and its pending value is included in project export and autosave. One same-host run after the change measured 17/40 ms median/p95, an 88% median and 77% p95 reduction. The focused Firefox regression checks wheel zoom and middle-button pan, waits for persistence, reloads, and verifies the restored viewBox. Typecheck and the focused browser regression pass. This is one before/after pair, not a release budget; a full build or WASM rebuild was not run.

### Visible-wire current sampling (2026-10-12)

The wire-flow sampler now resolves a stable visible-wire set to its wire objects and connected graph components once, then reuses that selection on subsequent cursor samples. Current injections and branch flow magnitudes are still recalculated per sample. This removes a scan of every project wire from each playback frame on large sheets. The focused wire-flow suite verifies both cached-set reuse and updated values as current changes; TypeScript checking passes. A per-frame browser timing comparison has not yet been recorded, so no numeric speedup is claimed.
