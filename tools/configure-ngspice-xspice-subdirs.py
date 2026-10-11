#!/usr/bin/env python3
"""Disable unavailable or separately licensed XSPICE modules for WASM."""

from pathlib import Path
import re
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

icm_makefile = root_makefile.parent / "icm/GNUmakefile"
icm_text = icm_makefile.read_text()
cmdirs = re.findall(r"(?m)^CMDIRS\s*=\s*(.+)$", icm_text)
if len(cmdirs) != 1:
    raise SystemExit(f"Expected one generated XSPICE ICM CMDIRS line in {icm_makefile}")
directories = cmdirs[0].split()
if directories.count("table") != 1:
    raise SystemExit(f"Expected the GPL-licensed table code model exactly once in {icm_makefile}")
icm_text = re.sub(r"(?m)^CMDIRS\s*=\s*.+$", "CMDIRS = " + " ".join(item for item in directories if item != "table"), icm_text)
icm_makefile.write_text(icm_text)
