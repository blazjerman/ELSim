# ELSim symbol format v1

An `.elsym` file is a UTF-8 JSON document for a project-owned or user-created component symbol. It is data only: the importer does not execute scripts, read external files, or accept SVG markup. Symbols can be imported from the component library and paired with a user model whose subcircuit has the same number of pins. `spiceOrder` maps each symbol pin to the corresponding `.SUBCKT` pin; the displayed pin names may differ.

Coordinates are in the symbol's local coordinate system, with the component origin at `(0, 0)`. Use `orientation` to describe the wire direction from a pin: `R`, `L`, `U`, or `D`. Pin orders must be unique and contiguous starting at 1. The symbol renderer draws each pin and its label; the listed primitives draw the body and internal marks.

```json
{
  "format": "elsim-symbol",
  "version": 1,
  "name": "Example amplifier",
  "pins": [
    { "name": "IN+", "spiceOrder": 1, "x": -60, "y": -20, "orientation": "R" },
    { "name": "IN-", "spiceOrder": 2, "x": -60, "y": 20, "orientation": "R" },
    { "name": "VCC", "spiceOrder": 3, "x": 0, "y": -60, "orientation": "D" },
    { "name": "VEE", "spiceOrder": 4, "x": 0, "y": 60, "orientation": "U" },
    { "name": "OUT", "spiceOrder": 5, "x": 60, "y": 0, "orientation": "L" }
  ],
  "primitives": [
    { "kind": "path", "d": "M-30 -40L35 0L-30 40Z" },
    { "kind": "text", "x": -5, "y": 5, "text": "+", "size": 3 }
  ]
}
```

Supported primitives are `line`, `polyline`, `rectangle`, `circle`, `text`, and a bounded SVG path using standard move/line/curve/arc/close commands. Files are limited to 1 MiB, 64 pins, 2,000 primitives, 256 points per polyline, and 4,096 characters per path. The matching runtime validator is `parseElsimSymbol`; [elsim-symbol-v1.schema.json](../schemas/elsim-symbol-v1.schema.json) describes the interchange shape. Projects store the original `.elsym` text and its content hash, so opening a project preserves the symbol source.
