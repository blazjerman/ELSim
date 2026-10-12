# Keyboard shortcuts

Letters are case-sensitive. In the browser, holding Shift changes `event.key`, so `n` and `N` are different shortcuts. With no schematic selection, component shortcuts arm placement; click or drag on the schematic to place the selected part. While an item is selected, component shortcuts do not switch the placement tool. Press `r` to rotate the selected part. Press Escape or click blank space to clear the selection before choosing another part by shortcut.

## Available components

| Key | Component |
| --- | --- |
| `r` | Resistor when nothing is selected; rotates the selected part otherwise |
| `c` | Capacitor |
| `L` | Inductor |
| `v` | Voltage source |
| `i` | Current source (ELSim addition) |
| `d` | Diode |
| `l` | LED |
| `s` | Manual on/off switch |
| `S` | Voltage-controlled switch |
| `e` | Lamp (ELSim addition) |
| `n` | NPN transistor |
| `p` | PNP transistor |
| `N` | N-channel MOSFET |
| `P` | P-channel MOSFET |
| `j` / `J` | N-channel / P-channel JFET |
| `g` | Ground |
| `E` / `G` / `F` / `H` | VCVS / VCCS / CCCS / CCVS (ELSim additions) |
| `b` | Behavioral source (ELSim addition) |

The `n` and `N` assignment follows the requested ELSim convention: lowercase `n` is NPN and uppercase `N` is N-channel MOSFET.

## Reserved for planned components

These keys are recognized and show a “reserved for a future component” message until that component is implemented. This avoids silently assigning the same key to an unrelated feature later.

| Key | Planned component |
| --- | --- |
| `R` | Relay |
| `C` | Polarized capacitor |
| `T` | Transformer |
| `V` | One-terminal voltage source |
| `a` / `A` | Operational amplifier orientations |
| `z` | Zener diode |
| `I` / `O` | Logic input / logic output |
| `1` | Inverter |
| `2` / `3` / `4` | AND / OR / XOR gates |
| `@` / `#` | NAND / NOR gates |

## Editor actions

| Key | Action |
| --- | --- |
| `m` | Select and move |
| `w` | Wire tool |
| `;` | Net-label tool |
| `?` | Probe tool |
| `=` | Toggle wire-crossing junction |
| `r` | Rotate selected component (takes precedence over resistor placement) |
| `y` | Flip selected component |
| `/` | Focus component search |
| `Ctrl/⌘+Enter` | Run simulation |
| `Ctrl/⌘+A` | Select all components, wires, and labels |
