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
| `.tran`, `.op`, `.ac`, `.dc` in `TEXT` | Supported for the parsed scalar/sweep settings | AC, DC, and transient fixture coverage in `tests/ltspice-schematic.test.cjs` |
| `.include`, `.inc`, `.lib` | Dependency presence is checked by imported filename; directive itself is not emitted | Missing dependency warning; library content is supplied separately |
| `.param NAME=value` | Supported for conservative single-token scalar/expression defaults in the active sheet | Nested exported sheet parameters and `{NAME}` values round-trip in `tests/ltspice-export.test.cjs`; broader LTspice parameter syntax is unverified |
| Scalar voltage source values | Supported as constant DC sources | Import regression verifies DC source mode |
| Scalar `I` current sources | Supported as constant DC current sources; current probe uses ngspice `@i[current]` | Hand-written import/export fixture, importer diagnostic for unsupported current waveforms, and 1 mA into 1 kΩ WASM operating-point/current-vector fixture |
| Current-source PULSE/PWL expressions | Not translated; scalar current remains visible and a warning asks for review | The current-source waveform warning is covered by importer behavior; animation and waveform-specific current settings are not modeled yet |
| Seven-argument `PULSE(low high delay rise fall width period)` voltage values | Supported for scalar levels and timing values | Pulse level/timing import and editable transient source behavior are tested |
| Scalar-pair `PWL(time voltage ...)` voltage values | Supported for 2–32 strictly increasing, nonnegative time points | Import, netlist, project archive, and LTspice export round-trip fixtures cover PWL points |
| Other dot directives | Not translated | A warning names the directive; `.save` is covered by a test |
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
| `I` | Independent current source | Scalar DC current; current-source transient waveforms are not yet modeled |
| `S` | Switch | ELSim on/off educational switch semantics, not the full LTspice switch dialect |
| `E`, `G` | VCVS, VCCS | Linear four-terminal form |
| `D` | Diode or LED | Device model must be supplied in a compatible imported library |
| `Q` | NPN or PNP | Device model must be supplied in a compatible imported library |
| `X` with imported `.SUBCKT` | Imported subcircuit instance | Pin names/order must match the model |
| No-prefix hierarchical symbol | Native ELSim child-sheet instance | Child basename and ordered IOPIN/FLAG ports must match |
| Other devices and symbol families | Unsupported | Instance is skipped with an import warning; source text remains available |

## Model dialect checks

The compatibility assistant currently detects selected LTspice constructs rather than claiming full dialect validation. Tested diagnostics include encrypted model files, `uplim`/`dnlim` handling through ngspice `lta`, unavailable `VSWITCH`, B-source `R=`/`P=`, behavioral Laplace options, and unsupported timestep/Laplace tuning options. Transformations remain explicit and limited to tested paths; imported model text is preserved unchanged.

## Provenance and licensing

The importer does not include LTspice binaries, vendor models, or vendor symbol artwork in ELSim source distributions. User-selected `.asc`, `.asy`, and model files remain project-local source material with unknown redistribution status. Importing a file does not grant rights to redistribute it. See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for project storage and export warnings.
