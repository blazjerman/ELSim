# ELSim performance benchmarks

This is a reproducible baseline, not a claim that every circuit of the same size has the same cost. The first fixture is a chain of 100, 500, 1,000, or 5,000 resistors. Every adjacent pair shares a named net; a 5 V source drives the first node and the final node is ground. The generated project contains `N + 1` parts, `2N + 2` labels, and `N + 1` nets. The runner verifies every pin is connected and netlisting emits no error before recording timings.

Run `npm run benchmark:performance` from the repository root. It compiles the relevant TypeScript modules into a temporary directory, performs two warmups and seven measured runs for connectivity, netlisting, plot reduction, raw parsing, and structured cloning, reports median and nearest-rank p95, then removes the temporary build. The plot fixture runs the production extrema reducer over sinusoidal Float64 vectors with narrow injected peaks and enforces a maximum output of 902 points. If the ignored local ngspice WASM runtime exists under `public/engine`, it also runs one cold-worker operating-point solve at each of 100, 1,000, and 5,000 resistor sections, checks that node N0 remains 5 V, and records solver startup, solve, and round-trip observations. It does not require the optional runtime for the domain/plot measurements and does not modify project files.

## Baseline

Measured on 2026-10-10 with Node 18.20.4, Linux x64, and an Intel Core i7-12700F (20 logical CPUs). Values are milliseconds unless noted.

| Resistor sections | Parts | Labels | Connectivity p95 | Netlist p95 | Netlist bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 101 | 202 | 2.247 | 1.818 | 1,607 |
| 500 | 501 | 1,002 | 21.872 | 20.319 | 8,807 |
| 1,000 | 1,001 | 2,002 | 57.837 | 59.815 | 17,809 |
| 5,000 | 5,001 | 10,002 | 1,373.983 | 1,321.016 | 101,809 |

| Input samples | Input bytes (Float64) | Output points | Reducer p95 |
| ---: | ---: | ---: | ---: |
| 100,000 | 800,000 | 901 | 2.754 |
| 1,000,000 | 8,000,000 | 902 | 1.035 |

The optional local ngspice 47 WebAssembly build was available for this run. Solver timings below are a single cold-worker observation per circuit size; parser and Node structured-clone estimates use the repeated-run statistics described above.

| Resistor sections | Module load | OP solve | Worker round trip | Raw bytes | Vector bytes | Raw parse p95 | Clone estimate p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 38.962 | 3.784 | 74.158 | 4,461 | 816 | 0.176 | 0.096 |
| 1,000 | 36.207 | 13.041 | 80.696 | 44,064 | 8,016 | 2.689 | 0.818 |
| 5,000 | 35.185 | 36.922 | 104.775 | 228,064 | 40,016 | 4.202 | 6.822 |

These are one-point operating-point results; vector payload size is small compared with long transient traces. The clone observation uses Node `structuredClone`, not a browser `Worker.postMessage` transfer.

The timings show a scaling cliff between 1,000 and 5,000 sections in both connectivity and netlist generation. Plot reduction remains bounded in output size. These results are from one local host; compare repeated runs on the same environment and keep numeric/topology checks intact when optimizing.

## Initial local budgets

These are working engineering targets for this fixture, not heterogeneous-CI pass/fail thresholds.

- 1,000-section chain: connectivity p95 at or below 75 ms; netlist p95 at or below 75 ms.
- 5,000-section chain: connectivity and netlist p95 at or below 500 ms.
- One-million-sample plot reduction: p95 at or below 5 ms and at most 902 output points.
- With the local engine present: 5,000-section operating-point solve at or below 100 ms, cold worker round trip at or below 200 ms, raw parsing at or below 10 ms p95, and 40 kB vector clone estimate at or below 10 ms p95.
- All project sizes: preserve every pin-to-net assignment and produce a parseable netlist with no error diagnostics. Performance work must not merge electrical nodes, drop traces, or approximate solver values.

## Not yet measured

The browser editor benchmark below measures reload readiness and click-to-selection completion, but not pointer-to-paint latency, animation update cost, large transient trace parsing/transport, actual browser worker structured-clone/transfer behavior, or reliable peak browser memory. The one-point OP solve is not a large-trace simulator benchmark. Record hardware/runtime details before setting browser budgets. Add a wire-segment-heavy layout and a nested-sheet fixture before treating the resistor chain as representative of all schematics.
## Browser editor baseline (2026-10-10)

Playwright benchmark: `npm run benchmark:browser` (Chromium and Firefox). The generated project contains one resistor and two net labels per component. `editorReadyMs` measures reload through rendered component count; selection timings include the browser click and React update. These are local measurements, not CI thresholds.

| Browser | Parts | Editor ready (ms) | Selection median (ms) | Selection p95 (ms) | SVG elements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 100 | 296 | 102 | 107 | 1,610 |
| Chromium | 500 | 585 | 174 | 296 | 8,010 |
| Chromium | 1,000 | 933 | 324 | 482 | 16,010 |
| Firefox | 100 | 403 | 83 | 128 | 1,610 |
| Firefox | 500 | 624 | 192 | 209 | 8,010 |
| Firefox | 1,000 | 1,032 | 309 | 379 | 16,010 |

`CircuitPart` now memoizes its SVG subtree and uses stable event wrappers that dispatch to the latest schematic handlers. Against the earlier recorded run, 1,000-part selection median improved from 415 to 324 ms in Chromium and 387 to 309 ms in Firefox. Selection still takes roughly 0.3 seconds, so it remains a profiling target; these figures are a baseline and should not be treated as release budgets. Heap readings from browser automation were inconsistent and are excluded from conclusions. SVG size grows linearly with parts and labels, so the next editor work should profile render cost and consider viewport culling or a canvas layer only if measured data supports it.
