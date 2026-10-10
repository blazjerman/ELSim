#!/usr/bin/env python3
"""Disable optional XSPICE Verilog/VHDL modules for static builds."""

from pathlib import Path
import sys


if len(sys.argv) != 2:
    raise SystemExit("usage: configure-ngspice-xspice-subdirs.py GENERATED_MAKEFILE")

makefile = Path(sys.argv[1])
text = makefile.read_text()
old = "SUBDIRS = mif cm enh evt idn cmpp icm verilog vhdl"
new = "SUBDIRS = mif cm enh evt idn cmpp icm"
if text.count(old) != 1:
    raise SystemExit(f"Unexpected generated XSPICE subdirectory list in {makefile}")
makefile.write_text(text.replace(old, new))
