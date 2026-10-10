# LTspice export design

Status: pure exporter and browser preview/ZIP download are implemented for a tested subset. Export is generated from the current ELSim project model. Original imported `.asc` text is provenance only and is never replayed over edited project data. Native LTspice open/simulate verification is still a release gate; generated files have only been round-tripped through ELSim and ZIP integrity checked.

The format reference used here is Analog Devices' [LTspice schematic reference](https://analogdevicesinc.github.io/ltspice-reference/ai_ref/SCHEMATIC-REFERENCE.html). It documents the text records, symbol syntax, hierarchical pins, and hierarchy naming conventions. The reference describes an observed file format, so every emitted construct still needs fixture tests and a native LTspice open/simulate check before being called compatible.

## Export result

Export one portable ZIP containing the root schematic, child schematics, generated hierarchical symbols, required project-owned/imported symbol files, required model libraries, and a machine-readable loss report. Preserve relative paths and avoid absolute paths. The top-level `.asc` should open without depending on ELSim's working directory.

Proposed layout:

```text
<project-name>.asc
<child-sheet-name>.asc
<child-sheet-name>.asy
symbols/<user-symbol>.asy
models/<user-library>
elsim-export.json
loss-report.md
```

Only dependencies actually referenced by placed parts should be included. An export preview lists each included user file, its recorded license status, and SHA-256. Unknown-license user files require an explicit confirmation before ZIP creation; ELSim must never claim that the confirmation grants redistribution rights. Generated ELSim symbols are original project code/art and carry the repository's license notices.

## Canonical mapping

| ELSim data | LTspice output |
| --- | --- |
| Each wire polyline | One `WIRE` record for each adjacent point pair |
| Named net label | `FLAG x y name` at the current label coordinate |
| Built-in or imported part | `SYMBOL name x y orientation`, then safe `SYMATTR InstName` and `SYMATTR Value` records |
| Child sheet block | A no-prefix block `.asy` named after its child `.asc`; ordered `PIN` / `PINATTR PinName` / `PINATTR SpiceOrder` records derive from the child sheet's ports |
| Child sheet port | `IOPIN x y In/Out/BiDir` at the matching current label coordinate, with a same-coordinate `FLAG` |
| Analysis settings | Generated `TEXT` directives for supported `.tran`, `.op`, `.ac`, or `.dc` settings |
| Imported model dependency | Relative `.include` directive plus the original unchanged model text, if included and accepted by the user |
| Project name | Safe basename for output files; sanitized collisions are reported and disambiguated deterministically |

New coordinates snap to the LTspice grid before output. Existing imported coordinates are preserved if legal and within format bounds. The exporter must not silently alter topology when a point is off-grid: it reports the item and either emits exact supported coordinates or blocks export when LTspice would change the connection. `SHEET` bounds are derived from all emitted geometry with a margin. Emit only ASCII text and use `u` in generated numeric values; preserve user model text byte-for-byte rather than normalizing it.

Component geometry should use repository-authored `.asy` definitions for ELSim built-ins. Imported user symbols can be copied only as explicit dependencies and with their original pin order; otherwise generate a simple original block symbol and report the visual substitution. No LTspice-installed symbols or vendor artwork should be copied into the repository or silently bundled.

## Hierarchy

Emit every current project sheet, not the imported source copy. Sheet names become safe, unique basenames. For each child sheet, emit its `.asc` and generated `.asy`; order block pins exactly as `ProjectSheet.ports`. Block identity, node labels, and component references must remain valid when the project is opened from a different directory. Detect cycles, invalid or duplicate names, unmatched ports, unsupported nested dependencies, and output path collisions before writing any files.

Repeated block instances reference one child definition. Exported `.asy` pin names and order must match the child's `IOPIN` names and order. Port direction is descriptive metadata and does not change SPICE pin order. Global ground is emitted as `FLAG ... 0`; ordinary labels remain local to the sheet.

## Loss report and blocking rules

The preview and `loss-report.md` classify each item as **preserved**, **transformed**, **omitted**, or **blocking**. Every row identifies the source part/sheet or asset and explains the impact. `elsim-export.json` records exporter version, source project format/version, generated file hashes, included dependency hashes and filenames, and each loss row.

Potential losses that must be disclosed:

- ELSim-only animation metadata, charge/current visualizations, editor layout, selection state, plot windows, prior simulation traces, and onboarding state are omitted.
- Unsupported ELSim component families, source waveform/expression differences, directives, parameters, or model constructs are omitted or transformed only through an explicitly tested mapping.
- Imported source `.asc` comments, unknown records, and original layout are not merged into generated output; the current ELSim scene is authoritative.
- A custom ELSim symbol may be replaced by a generated generic symbol when the original `.asy` is unavailable or the user declines to include it.
- Model text is copied unchanged. A successful export does not establish that LTspice supports the model dialect or that the user may redistribute it.

Block export when a placed component or hierarchy reference cannot be mapped without changing circuit topology, when a required asset is missing, when output paths collide after sanitization, or when the generated file would reference an unsafe path. Warnings may be accepted only after the full loss report is visible. Never silently delete a device, model, directive, or hierarchy level.

## Verification gates

1. Unit fixtures assert deterministic output for each supported record and a precise loss row for each omitted feature.
2. Parse generated files back through ELSim and compare sheet count, ports, ordered pin maps, component references, values, labels, and electrical connectivity. Compare canonical topology rather than visual coordinates where a documented transform applies.
3. Build numeric parity circuits in pinned ngspice and compare them with the source ELSim netlist for OP, AC, and transient cases where the dialects overlap.
4. Open each supported fixture with LTspice and run it in a maintainer verification environment. Record app version, test date, warnings, and result; do not claim the CI parser alone proves LTspice compatibility.
5. Test ZIP path traversal, duplicate names, archive limits, unknown-license confirmation, omitted assets, and loss-report completeness.

## Implementation order

1. Add a pure exporter that returns an in-memory file tree and typed loss rows; no browser download behavior in the domain module.
2. Implement deterministic `.asc` serialization for passives, sources, labels, wires, directives, and generated symbols.
3. Implement recursive sheet/port serialization and relative model dependencies.
4. Add round-trip topology and pinned-WASM parity fixtures.
5. Add a loss-preview dialog and ZIP download only after the pure exporter and path/license gates pass.
6. Keep actual LTspice verification as a documented manual release gate unless a redistributable, licensed test runtime is established.
