#!/usr/bin/env python3
"""Disable unavailable or separately licensed XSPICE modules for WASM."""

from pathlib import Path
import sys


if len(sys.argv) != 2:
    raise SystemExit("usage: configure-ngspice-xspice-subdirs.py GENERATED_XSPICE_MAKEFILE")

root_makefile = Path(sys.argv[1])
parent_text = root_makefile.read_text()
parent_old = "SUBDIRS = mif cm enh evt idn cmpp icm verilog vhdl"
parent_new = "SUBDIRS = mif cm enh evt idn cmpp"
if parent_text.count(parent_old) != 1:
    raise SystemExit(f"Unexpected generated XSPICE subdirectory list in {root_makefile}")
root_makefile.write_text(parent_text.replace(parent_old, parent_new))

icm_makefile = root_makefile.parent / "icm/Makefile"
icm_text = icm_makefile.read_text()
icm_old = "SUBDIRS = analog table tlines"
icm_new = "SUBDIRS = analog tlines"
if icm_text.count(icm_old) != 1:
    raise SystemExit(f"Unexpected generated XSPICE ICM subdirectory list in {icm_makefile}")
icm_makefile.write_text(icm_text.replace(icm_old, icm_new))
