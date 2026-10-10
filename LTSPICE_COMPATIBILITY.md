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
| Other component `SYMATTR` records | Retained under `part.extensions.ltspice.attributes` with bounded count/value lengths; not interpreted by the solver | `SpiceLine`, custom vendor attributes, archive round-trip, and export-loss cases are covered by importer/project/export tests |
| No-prefix hierarchy block plus matching basename `.asc` | Supported recursively when ordered symbol pins match child ports | Nested import and generated X netlist fixtures in `tests/ltspice-schematic.test.cjs` |
| `.tran`, `.op`, `.ac`, `.dc` in `TEXT` | Supported for the parsed scalar/sweep settings; `.tran ... uic` maps to skip-initial-operating-point, while `startup` source ramp behavior is not preserved and warns | AC, DC, transient, UIC, and startup-warning fixtures in `tests/ltspice-schematic.test.cjs` |
| `.include`, `.inc`, `.lib` | Dependency presence is checked by imported filename; directive itself is not emitted | Missing dependency warning; library content is supplied separately |
| `.param NAME=value` | Supported for conservative single-token scalar/expression defaults in the active sheet | Nested exported sheet parameters and `{NAME}` values round-trip in `tests/ltspice-export.test.cjs`; broader LTspice parameter syntax is unverified |
| Scalar voltage source values | Supported as constant DC sources | Import regression verifies DC source mode |
| Source `Value2 AC magnitude [phase]` | Supported for voltage/current sources | Per-source magnitude/phase netlist, import, and export round-trip tests; phase defaults to zero |
| Scalar `I` current sources | Supported as constant DC current sources; current probe uses ngspice `@i[current]` | Hand-written import/export fixture, importer diagnostic for unsupported current waveforms, and 1 mA into 1 kΩ WASM operating-point/current-vector fixture |
| Current-source `PULSE(low high delay rise fall width period)` | Supported for transient analysis; low/high values and timing are editable | Hand-written import/export round trip and `current-source-pulse.cir` WASM fixture verify 1 mA into 1 kΩ produces a 1 V pulse |
| Current-source `PWL(time current ...)` expressions | Not translated; original value remains visible and a warning asks for review | PWL-current import warning covered by `tests/ltspice-schematic.test.cjs`; current waveform values do not use the voltage PWL editor |
| Seven-argument `PULSE(low high delay rise fall width period)` voltage values | Supported for scalar levels and timing values | Pulse level/timing import and editable transient source behavior are tested |
| Scalar-pair `PWL(time voltage ...)` voltage values | Supported for 2–32 strictly increasing, nonnegative time points | Import, netlist, project archive, and LTspice export round-trip fixtures cover PWL points |
| `.save V(named_node)` and `.save I(placed_component)` | Supported as persisted plot-trace selections; selected vectors are not solver restrictions because ELSim manages result vectors itself | Named labels and placed current-bearing components are matched case-insensitively; unknown nodes/components and other `.save` expressions produce a warning |
| `.ic V(named_node)=scalar` and `.ic I(inductor)=scalar` | Supported for transient analysis | Labeled nodes and placed inductors are matched case-insensitively; unresolved targets, invalid units/values, duplicate settings, or non-transient analyses produce warnings |
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
| `V` | Voltage source | Scalar, seven-argument PULSE, and scalar-pair PWL values are supported; other waveform expressions remain unverified and prompt a warning |
| `I` | Independent current source | Scalar DC, seven-argument PULSE, and scalar-pair PWL waveforms |
| `S` | Switch | ELSim on/off educational switch semantics, not the full LTspice switch dialect |
| `E`, `G` | VCVS, VCCS | Linear four-terminal form |
| `F`, `H` | CCCS, CCVS | Linear two-terminal form; `Value` must name an existing voltage-source current sensor in the same sheet and `Value2` supplies the gain/transresistance. Behavioral `POLY` and other nonlinear forms are not translated. |
| `D` | Diode or LED | Device model must be supplied in a compatible imported library |
| `Q` | NPN or PNP | Device model must be supplied in a compatible imported library |
| `M` | NMOS or PMOS, selected by the matching imported `.MODEL` card or an explicit `nmos`/`pmos` symbol name | Four ordered terminals D-G-S-B. A compatible user-supplied `.MODEL` is used when present; otherwise the imported model name is retained with a warning and ELSim's educational Level 1 default runs. This fallback is not device-specific and must not be used to validate a real part. |
| `X` with imported `.SUBCKT` | Imported subcircuit instance | Pin names/order must match the model |
| No-prefix hierarchical symbol | Native ELSim child-sheet instance | Child basename and ordered IOPIN/FLAG ports must match |
| Other devices and symbol families | Unsupported | Instance is skipped with an import warning; source text remains available |

## Model dialect checks

The compatibility assistant currently detects selected LTspice constructs rather than claiming full dialect validation. Tested diagnostics include encrypted model files, `uplim`/`dnlim` handling through ngspice `lta` (including SPICE `+` continuation lines), unavailable `VSWITCH`, B-source `R=`/`P=`, behavioral Laplace options, and unsupported timestep/Laplace tuning options. The worker enables `lta` mode when a limit function appears anywhere in a logical deck record; imported model text is preserved unchanged.

## Provenance and licensing

The importer does not include LTspice binaries, vendor models, or vendor symbol artwork in ELSim source distributions. User-selected `.asc`, `.asy`, and model files remain project-local source material with unknown redistribution status. Importing a file does not grant rights to redistribute it. See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for project storage and export warnings.
