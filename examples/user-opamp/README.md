# Imported five-pin op-amp example

Open the **Imported op-amp IC** lesson from Examples to inspect and simulate the five-pin model in a closed-loop amplifier. To exercise file import, select `user-opamp.asc`, `user_opamp.asy`, and `user-opamp.lib` together with the import action. The hand-authored schematic and `.asy` file declare the model's pins in SPICE order. The browser workflow solves the imported design with ngspice and checks its follower output near 1 V.

`user-opamp.lib` is an original ELSim educational macromodel under the repository MIT license. It uses an ideal dependent source with finite open-loop gain, 50 Ω output resistance, and diode rail clamps. It omits bandwidth, slew rate, input bias/offset currents, noise, and protection behavior. It is not a physical part model and must not be used to validate a real op amp or circuit safety margin.

All three files are original ELSim example assets. The model does not include vendor symbols or vendor model text. The `.asy` geometry is a simple original triangle and ordered pin list.
