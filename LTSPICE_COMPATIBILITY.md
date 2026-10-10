# LTspice compatibility matrix

This matrix describes the importer as implemented today. “Supported” means ELSim maps the record into its own project model; it does not promise byte-for-byte round trips or full behavioral equivalence with LTspice. Fixtures are hand-written in the repository and contain no vendor artwork or models.

## Schematic files (`.asc`)

| Syntax or behavior | Status | Evidence / diagnostic |
| --- | --- | --- |
| `Version`, `SHEET` | Ignored as presentation metadata | `tests/ltspice-schematic.test.cjs` ordinary import fixture |
| Two-endpoint `WIRE` | Supported | Preserves coordinates and connectivity; malformed coordinates reject import |
| `FLAG` labels | Supported for `0` and conservative SPICE node names | Unsupported names produce a warning |
| `IOPIN` with same-coordinate `FLAG` | Supported as ordered `input`, `output`, or `inout` child-sheet ports | Matched, unmatched, and duplicate cases in `tests/ltspice-schematic.test.cjs` |
| `SYMBOL` orientations `R0/R90/R180/R270`, `M0/M90/M180/M270` | Supported | Coordinates and pin locations are transformed into ELSim geometry |
| `SYMATTR InstName`, `Value`, `Value2` | `InstName` and selected value are mapped; `Value2` is retained when `Value` is also present | Missing or invalid instance names and `Value2` preservation are covered in `tests/ltspice-schematic.test.cjs` |
| Capacitor/inductor `SYMATTR SpiceLine IC=scalar` | Supported as element voltage/current initial conditions for transient analysis; the original `SpiceLine` remains preserved. Other `SpiceLine` options are retained but not translated and produce a warning. | Domain tests verify units, generated `IC=` netlist records, UIC, invalid-unit warnings, and attribute preservation; Chromium verifies an imported capacitor starts at 2 V in ngspice. |
| Other component `SYMATTR` records | Retained under `part.extensions.ltspice.attributes` with bounded count/value lengths; not interpreted by the solver | `SpiceLine`, custom vendor attributes, archive round-trip, and export-loss cases are covered by importer/project/export tests |
| No-prefix hierarchy block plus matching basename `.asc` | Supported recursively when ordered symbol pins match child ports | Nested import and generated X netlist fixtures in `tests/ltspice-schematic.test.cjs` |
| `.tran`, `.op`, `.ac`, `.dc` in `TEXT` | Supported for the parsed scalar/sweep settings; `.tran ... uic` maps to skip-initial-operating-point, while `startup` source ramp behavior is not preserved and warns | AC, DC, transient, UIC, and startup-warning fixtures in `tests/ltspice-schematic.test.cjs` |
| `.include`, `.inc`, `.lib` | Dependency presence is checked by imported filename; directive itself is not emitted | Missing dependency warning; library content is supplied separately |
| `.param NAME=value` | Supported for conservative single-token scalar/expression defaults in the active sheet | Nested exported sheet parameters and `{NAME}` values round-trip in `tests/ltspice-export.test.cjs`; broader LTspice parameter syntax is unverified |
| Scalar voltage source values | Supported as constant DC sources | Import regression verifies DC source mode |
| Source `Value2 AC magnitude [phase]` | Supported for voltage/current sources | Per-source magnitude/phase netlist, import, and export round-trip tests; phase defaults to zero |
| Scalar `I` current sources | Supported as constant DC current sources; current probe uses ngspice `@i[current]` | Hand-written import/export fixture, current waveform import/export fixtures, and 1 mA into 1 kΩ WASM operating-point/current-vector fixture |
| Current-source `PWL(time current ...)` expressions | Supported for 2–32 scalar time/current pairs; times must be nonnegative and strictly increasing | `tests/ltspice-schematic.test.cjs` verifies imported mode, point mapping, no warning, and generated PWL current-source netlist; current waveform values use their own editor fields |
| Voltage- and current-source `SFFM(VO VA FC MDI FS)` | Supported for transient analysis; LTspice carrier/modulating order is retained in project data and emitted using the shared five-parameter ngspice `SFFM(VO VA FC MDI FS)` form; frequencies must be positive and modulation index bounded | Import, editable fields, validation, ngspice transient solving, LTspice export round trip, and numeric voltage/current WASM transient checks |
| Voltage- and current-source `SINE(...)` | Supported for transient analysis; omitted optional fields default to zero and frequency must be positive | Import, editable quantity-specific parameter validation, netlist, LTspice export round trip, project archive, and numeric WASM transient fixtures cover voltage and current waveforms |
| Voltage- and current-source `EXP(V1 V2 TD1 TAU1 TD2 TAU2)` | Supported for transient analysis; time constants must be positive and fall delay must not precede rise delay | Import, editable quantity-specific fields, validation, netlist, LTspice round trip, and paired numeric WASM fixture cover voltage and current sources |
| Voltage- and current-source seven/eight-argument `PULSE(low high delay rise fall width period [cycleCount])` | Supported for transient analysis; low/high levels and timing are editable. A nonnegative whole cycle count stops after that many pulses; zero or omission repeats indefinitely. | Import, editable fields, LTspice round trip, and `pulse-cycle-count.cir` numeric WASM fixture verify finite voltage/current trains; the existing current-source fixture checks load voltage and direction |
| Scalar-pair `PWL(time voltage ...)` voltage values, `PWL REPEAT FOREVER (...) ENDREPEAT`, and bounded `PWL REPEAT FOR N (...) ENDREPEAT` | Supported for 2–32 strictly increasing, nonnegative base time points. Finite repeats expand to at most 32 ngspice points and require equal first/last voltage so the cycle boundary is continuous; forever repeat uses ngspice `r=0`. | Import, netlist expansion, numeric finite/forever WASM fixtures, LTspice export round-trip fixtures, and a Chromium inspector-to-simulation workflow cover supported forms. Unsupported counts, over-limit expansions, and discontinuous repeat boundaries are reported rather than silently translated. |
| Voltage/current source `PWL FILE=...` | Supported when the referenced plain-text table is included with the selected schematic: 2–32 tab-, comma-, or whitespace-separated time/value pairs, no header, nonnegative increasing times, and at most 1 MiB. Parsed points are stored in the ELSim project; LTspice export emits equivalent inline points. | Domain tests cover voltage/current tables and missing, ambiguous, and malformed files; Chromium verifies bundled-file import and ngspice simulation. Larger tables and repeat modifiers on file-backed tables are unsupported. |
| `.save V(named_node)` and `.save I(placed_component)` | Supported as persisted plot-trace selections; selected vectors are not solver restrictions because ELSim manages result vectors itself | Named labels and placed current-bearing components are matched case-insensitively; unknown nodes/components and other `.save` expressions produce a warning |
| `.ic V(named_node)=scalar`, `.ic V(node+,node-)=scalar` across a placed capacitor, and `.ic I(inductor)=scalar` | Supported for transient analysis | Labeled nodes, matching capacitor terminal pairs, and placed inductors are matched case-insensitively; reversed capacitor node order reverses the stored voltage sign; unresolved targets, invalid units/values, duplicate settings, or non-transient analyses produce warnings |
| `.meas tran` / `.measure tran` `NAME MAX|MIN|AVG|RMS V(named_node)|I(placed_component)` | Supported for scalar transient measurements | Names and targets are validated; `FROM`, `TO`, and other qualifiers are not translated and produce a warning |
| `.meas tran NAME TRIG vector VAL=value RISE|FALL|CROSS=1 TARG vector VAL=value RISE|FALL|CROSS=1` | Supported as an ELSim trigger-to-target delay measurement | Both vectors, scalar thresholds, and edge counts are validated; unsupported qualifiers or crossing counts produce a warning. Export emits the matching trigger/target directive; importer and exporter fixtures cover the mapping. |
| Other dot directives | Not translated | A warning names the directive |
| Unknown or unsupported record | Skipped with bounded source excerpt | Warning is covered by a test |
| `.asc` source preservation | Supported for root and supplied child files | Project validation and archive round-trip in `tests/project-archive.test.cjs` |

## Symbol files (`.asy`)

| Syntax or behavior | Status | Evidence / diagnostic |
| --- | --- | --- |
| `LINE`, `RECTANGLE`, `CIRCLE`, `ARC` | Parsed as bounded drawing primitives | Geometry and invalid arc fixtures in `tests/ltspice-symbol.test.cjs` |
| `PIN`, `PINATTR PinName`, `PINATTR SpiceOrder` | Supported; pins are sorted by contiguous `SpiceOrder` | Sorting, duplicate, missing, gap, and coordinate-limit tests |
| `SYMATTR Prefix`, `Value`, `Description`, `ModelFile`; `SYMBOLTYPE` | Parsed as metadata | ModelFile preservation and schematic dependency warning tests |
| Unknown non-executable symbol record | Skipped with warning | Covered by `tests/ltspice-symbol.test.cjs` |
| Encrypted or binary symbol data | Not interpreted | Import accepts bounded UTF-8 text only |

## Mapped component families

| LTspice prefix / symbol family | ELSim mapping | Limits |
| --- | --- | --- |
| `R`, `C`, `L` | Resistor, capacitor, inductor | Scalar values only |
| `V` | Voltage source | Scalar, SINE, EXP, SFFM, seven/eight-argument PULSE, scalar-pair PWL, and forever-repeating PWL values are supported; other waveform expressions remain unverified and prompt a warning |
| `I` | Independent current source | Scalar DC, SINE, EXP, SFFM, seven/eight-argument PULSE, and scalar-pair PWL waveforms; repeating PWL current is warned and runs once because the pinned ngspice manual documents r/td only for voltage sources |
| `S` | Switch | ELSim on/off educational switch semantics, not the full LTspice switch dialect |
| `E`, `G` | VCVS, VCCS | Linear four-terminal form |
| `F`, `H` | CCCS, CCVS | Linear two-terminal form; `Value` must name an existing voltage-source current sensor in the same sheet and `Value2` supplies the gain/transresistance. Behavioral `POLY` and other nonlinear forms are not translated. |
| `D` | Diode or LED | Device model must be supplied in a compatible imported library |
| `Q` | NPN or PNP | Device model must be supplied in a compatible imported library |
| `J` | N-channel or P-channel JFET, selected by the matching imported `.MODEL NJF/PJF` card or an explicit `njfet`/`pjfet` symbol name | Three ordered terminals D-G-S. Compatible user `.MODEL` cards are used when present. Without one, ELSim uses an original approximate teaching model and warns; this does not identify or validate a real device. Project-original WASM fixtures verify NJF and PJF operating points/current vectors and a transient zero-bias-conduction/negative-gate-cutoff example (`tests/netlist.test.cjs`, `engine/wasm/fixtures/jfet-model-op.cir`, `engine/wasm/fixtures/pjfet-model-op.cir`, `engine/wasm/fixtures/jfet-switch.cir`). |
| `M` | NMOS or PMOS, selected by the matching imported `.MODEL` card or an explicit `nmos`/`pmos` symbol name | Four ordered terminals D-G-S-B. A compatible user-supplied `.MODEL` is used when present; otherwise the imported model name is retained with a warning and ELSim's educational Level 1 default runs. A project-original NMOS model fixture verifies the selected card affects solved drain voltage and current in WASM (`tests/netlist.test.cjs`, `engine/wasm/fixtures/imported-mosfet-model-op.cir`). This fallback is not device-specific and must not be used to validate a real part. |
| `X` with imported `.SUBCKT` | Imported subcircuit instance | Pin names/order must match the model |
| No-prefix hierarchical symbol | Native ELSim child-sheet instance | Child basename and ordered IOPIN/FLAG ports must match |
| Other devices and symbol families | Unsupported | Instance is skipped with an import warning; source text remains available |

## Model dialect checks

The compatibility assistant currently detects selected LTspice constructs rather than claiming full dialect validation. Tested diagnostics include encrypted model files, `uplim`/`dnlim` handling through ngspice `lta` (including SPICE `+` continuation lines), LTspice `limit()` clamp semantics (the pinned WASM build returns 0 V for `limit(4,0,3)` instead of 3 V, including in `lta` mode), unavailable `VSWITCH`, unverified XSPICE `A` devices, B-source `R=`/`P=`, behavioral Laplace options, LTspice `table()`, `idt()`, and `if()` expressions (which the pinned browser ngspice engine rejects as unknown functions), and unsupported timestep/Laplace tuning options. Additional B-source checks warn for the verified unavailable LTspice functions `absdelay`, `delay`, `buf`, `hypot`, `inv`, `int`, `round`, `square`, `white`, `random`, `rand`, and `xor`. They also flag `^` because LTspice defines it as boolean XOR in B-source expressions while this ngspice build evaluates it as exponentiation; the numeric fixture verifies `V(IN)^2` and `pow(V(IN),2)` both produce 9 V at `V(IN)=3`. Use explicit `pow(a,b)` when exponentiation is intended. These differences are based on the [LTspice B-source reference](https://ltspicehelpmanual.azurewebsites.net/barbitrarybehavioralvoltageorcur.htm) and direct tests of the pinned WASM engine. The diagnostic suggests `min(max(x,low),high)` for ordered clamp bounds; ELSim preserves the imported source and does not rewrite it. The pinned WASM engine numerically verifies ngspice B-source `min()`, `max()`, and `uramp()` on an input-driven operating-point fixture; this records engine behavior, not full LTspice semantic equivalence. The worker enables `lta` mode when an `uplim`/`dnlim` function appears anywhere in a logical deck record; imported model text is preserved unchanged. XSPICE is enabled in the build, but external `.cm` modules are not packaged or validated, so the new diagnostic is intentionally a warning rather than a claim that every A-device fails.

## Provenance and licensing

The importer does not include LTspice binaries, vendor models, or vendor symbol artwork in ELSim source distributions. User-selected `.asc`, `.asy`, and model files remain project-local source material with unknown redistribution status. Importing a file does not grant rights to redistribute it. See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for project storage and export warnings.
