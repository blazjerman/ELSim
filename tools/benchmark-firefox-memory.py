#!/usr/bin/env python3
"""Sample Firefox process-tree PSS/RSS during the million-sample browser benchmark.

Linux-only diagnostic. This measures browser process memory, not ELSim-only
allocation. The worker-profile log marks the end of the ngspice solve/result
transfer; later samples include result validation and plot/cursor interaction.
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_PROFILE_PREFIX = "[ELSim worker profile] "


def process_table():
    parents = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
            fields = stat[stat.rfind(")") + 2 :].split()
            parents[int(entry.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            continue
    return parents


def descendants(parent, parents):
    children = {}
    for pid, ppid in parents.items():
        children.setdefault(ppid, []).append(pid)
    found, pending = set(), [parent]
    while pending:
        current = pending.pop()
        for child in children.get(current, ()):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def firefox_memory(root_pid):
    parents = process_table()
    task_processes = descendants(root_pid, parents)
    firefox_roots = set()
    for pid in task_processes:
        base = Path("/proc") / str(pid)
        try:
            comm = (base / "comm").read_text().strip().lower()
            argv0 = (base / "cmdline").read_bytes().split(b"\0", 1)[0].decode(errors="ignore").lower()
            if comm == "firefox" or "firefox" in argv0:
                firefox_roots.add(pid)
        except OSError:
            continue

    browser_processes = set()
    for pid in firefox_roots:
        browser_processes.add(pid)
        browser_processes.update(descendants(pid, parents))

    pss_kib = rss_kib = 0
    for pid in browser_processes:
        try:
            rollup = (Path("/proc") / str(pid) / "smaps_rollup").read_text()
        except OSError:
            continue
        for line in rollup.splitlines():
            if line.startswith("Pss:"):
                pss_kib += int(line.split()[1])
            elif line.startswith("Rss:"):
                rss_kib += int(line.split()[1])
    return {
        "pssMiB": round(pss_kib / 1024, 1),
        "rssMiB": round(rss_kib / 1024, 1),
        "processCount": len(browser_processes),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plot-windows", type=int, default=8, choices=range(1, 9))
    parser.add_argument("--interval-ms", type=int, default=100)
    args = parser.parse_args()
    if not Path("/proc/self/smaps_rollup").exists():
        parser.error("this sampler requires Linux /proc with smaps_rollup support")
    if args.interval_ms < 20:
        parser.error("--interval-ms must be at least 20 to limit sampler overhead")

    env = os.environ.copy()
    env["VITE_ELSIM_PROFILE"] = "1"
    env["ELSIM_PERF_PLOT_WINDOWS"] = str(args.plot_windows)
    env["ELSIM_PERF_HOLD_MS"] = "2000"
    command = [
        "npx", "playwright", "test", "--config", "playwright.performance.config.ts",
        "--project=firefox", "--grep",
        "measure a million-sample transient through the browser ngspice worker and plot UI",
    ]
    process = subprocess.Popen(
        command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    lines = queue.Queue()

    def read_output():
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    phase = "beforeWorkerProfile"
    peaks = {phase: {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0}}
    overall = {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0}
    wasm_bytes = None
    output_closed = False
    interval = args.interval_ms / 1000

    while process.poll() is None or not output_closed:
        try:
            while True:
                line = lines.get_nowait()
                if line is None:
                    output_closed = True
                    break
                print(line, end="", flush=True)
                if WORKER_PROFILE_PREFIX in line:
                    try:
                        profile_text = line.split(WORKER_PROFILE_PREFIX, 1)[1]
                        wasm_bytes = json.loads(profile_text).get("wasmLinearMemoryBytes")
                    except (ValueError, TypeError):
                        pass
                    phase = "afterWorkerProfile"
                    peaks.setdefault(phase, {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0})
        except queue.Empty:
            pass

        memory = firefox_memory(process.pid)
        bucket = peaks.setdefault(phase, {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0})
        bucket["samples"] += 1
        overall["samples"] += 1
        for key in ("pssMiB", "rssMiB"):
            bucket[key] = max(bucket[key], memory[key])
            overall[key] = max(overall[key], memory[key])
        time.sleep(interval)

    return_code = process.wait()
    print(json.dumps({
        "benchmark": "firefox-million-sample-process-memory-v1",
        "plotWindows": args.plot_windows,
        "tracesPerWindow": 4,
        "sampleIntervalMs": args.interval_ms,
        "wasmLinearMemoryBytes": wasm_bytes,
        "phasePeaks": peaks,
        "overallPeak": overall,
        "limitations": [
            "PSS/RSS sum Firefox and its descendants, not ELSim-only allocations.",
            "beforeWorkerProfile includes page startup, solve, and result transfer.",
            "afterWorkerProfile includes result validation, plotting, and cursor checks.",
            "WASM linear-memory capacity is not the same as peak process memory.",
            "This local run does not provide a second-hardware baseline.",
        ],
        "exitCode": return_code,
    }, indent=2))
    return return_code


if __name__ == "__main__":
    sys.exit(main())
