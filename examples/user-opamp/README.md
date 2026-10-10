# Imported five-pin op-amp example

Import `user-opamp.asc`, `user_opamp.asy`, and `user-opamp.lib` together with the LTspice import action. The hand-authored schematic contains its two voltage sources and output load; the `.asy` file declares the model's five pins in SPICE order. The browser workflow solves the imported design with ngspice and checks its feedback output near 1 V.

`user-opamp.lib` is an original ELSim educational macromodel under the repository MIT license. It uses an ideal dependent source with finite open-loop gain, 50 Ω output resistance, and diode rail clamps. It omits bandwidth, slew rate, input bias/offset currents, noise, and protection behavior. It is not a physical part model and must not be used to validate a real op amp or circuit safety margin.

All three files are original ELSim example assets. The model does not include vendor symbols or vendor model text. The `.asy` geometry is a simple original triangle and ordered pin list.
