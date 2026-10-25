/** Original ELSim teaching model shared by the import example and its source fixture. */
export const educationalOpampOpenLoopGain = 100_000
export const educationalOpampOutputResistanceOhms = 50

export const educationalOpampLibrary = `* ELSim-authored educational macromodel; not a physical op-amp model.
* Five SPICE pins are ordered INP INM VPOS VNEG OUT.
* Models finite open-loop gain and output resistance with ideal rail clamps.
* It omits bandwidth, slew rate, bias/offset currents, and device protection.
.SUBCKT ELSIM_EDU_OPAMP INP INM VPOS VNEG OUT
EGAIN NDRIVE 0 INP INM ${educationalOpampOpenLoopGain}
ROUT NDRIVE OUT ${educationalOpampOutputResistanceOhms}
DHI OUT VPOS DCLAMP
DLO VNEG OUT DCLAMP
.MODEL DCLAMP D(Is=1e-14 N=1)
.ENDS ELSIM_EDU_OPAMP
`

export const educationalOpampSymbol = `Version 4
SYMATTR Prefix X
LINE Normal -30 -30 30 0
LINE Normal 30 0 -30 30
LINE Normal -30 30 -30 -30
LINE Normal -80 -20 -30 -20
LINE Normal -80 20 -30 20
LINE Normal 0 -60 0 -30
LINE Normal 0 30 0 60
LINE Normal 30 0 80 0
TEXT 0 -38 Center 2 EDUCATIONAL OP-AMP
PIN -80 -20 R
PINATTR PinName INP
PINATTR SpiceOrder 1
PIN -80 20 R
PINATTR PinName INM
PINATTR SpiceOrder 2
PIN 0 -60 U
PINATTR PinName VPOS
PINATTR SpiceOrder 3
PIN 0 60 D
PINATTR PinName VNEG
PINATTR SpiceOrder 4
PIN 80 0 L
PINATTR PinName OUT
PINATTR SpiceOrder 5
`
