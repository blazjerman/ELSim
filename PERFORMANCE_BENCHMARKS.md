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

### Browser large transient

`npm run benchmark:browser -- --grep "million-sample transient"` runs a 1 s RC transient with a 1 µs maximum step through the actual ngspice browser worker, app response handling, result plot, and time scrubber. It selects up to five available voltage/current traces and requires at least four plotted traces, then checks at least one million solved samples, cursor readout at the last sample, and no page errors. A 16 ms main-thread timer records its largest scheduling gap during the run. `resultReadyMs` covers Run click through the completion notice. These are single local observations, not thresholds.

| Browser | Solved samples | Plotted traces | Result ready (ms) | Final scrub (ms) | Largest main-thread timer gap (ms) | Renderer heap before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1,000,130 | 5 | 7,939.78 | 109.78 | 70 | 23.1 → 23.1 MB |
| Firefox | 1,000,130 | 5 | 20,054.67 | 343.97 | 69 | unavailable |

Chromium's `performance.memory` numbers cover the page renderer and remained unchanged at the reported resolution; they do not include the dedicated worker's WASM memory. Firefox does not expose that API in this run. The timer gaps indicate that the renderer remained responsive while the worker solved and parsed results, but do not provide a worker-memory measurement. Reliable per-worker peak memory remains unmeasured.

## Browser editor baseline (2026-10-10)

Playwright benchmark: `npm run benchmark:browser` (Chromium and Firefox). The generated project contains one resistor and two net labels per component. `editorReadyMs` measures reload through rendered component count; selection timings include the browser click and React update. These are local measurements, not CI thresholds.

| Browser | Parts | Editor ready (ms) | Selection median (ms) | Selection p95 (ms) | SVG elements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 100 | 296 | 102 | 113 | 1,610 |
| Chromium | 500 | 552 | 170 | 305 | 8,010 |
| Chromium | 1,000 | 789 | 352 | 458 | 16,010 |
| Firefox | 100 | 398 | 87 | 131 | 1,610 |
| Firefox | 500 | 596 | 173 | 240 | 8,010 |
| Firefox | 1,000 | 932 | 305 | 383 | 16,010 |

`CircuitPart` now memoizes its SVG subtree and uses stable event wrappers that dispatch to the latest schematic handlers. Earlier post-change runs measured 1,000-part selection medians at 324 ms in Chromium and 309 ms in Firefox; this run measured 352 and 305 ms respectively, showing some run-to-run variation. Selection still takes roughly 0.3 seconds, so it remains a profiling target; these figures are a baseline and should not be treated as release budgets. Heap readings from browser automation were inconsistent and are excluded from conclusions. SVG size grows linearly with parts and labels, so the next editor work should profile render cost and consider viewport culling or a canvas layer only if measured data supports it.

### Browser waveform transport check

The worker now shares one parsed axis across all traces and transfers unique axis/value buffers to the UI, avoiding per-trace axis copies and a structured-clone copy of result vectors. The UI validates shared typed vectors once per response. A Playwright `MessageChannel` check used six 100,000-sample traces (5.6 MB total including one shared axis); both clone and transfer preserved values and shared-axis identity, and transfer detached the sender buffers as expected.

| Browser | Clone round trip (ms) | Transfer round trip (ms) | Payload |
| --- | ---: | ---: | ---: |
| Chromium | 3.90 | 0.20 | 5.6 MB |
| Firefox | 2.00 | 3.00 | 5.6 MB |

These small-payload timings vary by browser and are not budgets. Transfer’s consistent benefit is avoiding the waveform buffer copy and reducing peak duplicate memory; large end-to-end engine-worker runs remain to be measured.
