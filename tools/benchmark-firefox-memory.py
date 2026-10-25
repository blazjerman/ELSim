#!/usr/bin/env python3
"""Sample Firefox process-tree PSS/RSS during the million-sample browser benchmark.

Linux-only diagnostic. This measures browser process memory, not ELSim-only
allocation. The worker-profile log marks the end of the ngspice solve/result
transfer; later samples include result validation and plot/cursor interaction.
Use --repeats to collect a bounded same-host range and median for each phase.
"""

import argparse
import json
import os
import queue
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_PROFILE_PREFIX = "[ELSim worker profile] "
MEMORY_PHASE_PREFIX = "[ELSim memory phase] "


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


def firefox_process_role(comm, arguments, is_root=False):
    """Classify Firefox's browser and auxiliary processes from their launch args."""
    comm = comm.lower()
    arguments = arguments.lower()
    if "web content" in comm:
        return "content"
    if "webextensions" in comm:
        return "extensions"
    if "socket process" in comm:
        return "socket"
    if "rdd process" in comm:
        return "remote-data-decoder"
    if "utility process" in comm:
        return "utility"
    if "gpu process" in comm:
        return "gpu"
    if comm == "forkserver":
        return "playwright-helper"
    if comm != "firefox" and "firefox" not in arguments.split(" ", 1)[0]:
        return "other"
    if "-contentproc" in arguments or "--contentproc" in arguments:
        return "content"
    if "-gpu" in arguments or "--gpu-process" in arguments:
        return "gpu"
    if "-rdd" in arguments or "--rdd-process" in arguments:
        return "remote-data-decoder"
    if "-socket" in arguments or "--socket-process" in arguments:
        return "socket"
    if "-utility" in arguments or "--utility-process" in arguments:
        return "utility"
    return "browser-main" if is_root else "firefox-child"


def firefox_memory(root_pid):
    parents = process_table()
    task_processes = descendants(root_pid, parents)
    firefox_candidates = set()
    for pid in task_processes:
        base = Path("/proc") / str(pid)
        try:
            comm = (base / "comm").read_text().strip().lower()
            argv0 = (base / "cmdline").read_bytes().split(b"\0", 1)[0].decode(errors="ignore").lower()
            if comm == "firefox" or "firefox" in argv0:
                firefox_candidates.add(pid)
        except OSError:
            continue

    firefox_roots = {
        pid for pid in firefox_candidates
        if parents.get(pid) not in firefox_candidates
    }
    browser_processes = set()
    for pid in firefox_roots:
        browser_processes.add(pid)
        browser_processes.update(descendants(pid, parents))

    pss_kib = rss_kib = 0
    roles = {}
    largest_processes = []
    for pid in browser_processes:
        base = Path("/proc") / str(pid)
        try:
            comm = (base / "comm").read_text().strip()
            arguments = (base / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore").strip()
            rollup = (base / "smaps_rollup").read_text()
        except OSError:
            continue
        process_pss_kib = process_rss_kib = 0
        for line in rollup.splitlines():
            if line.startswith("Pss:"):
                process_pss_kib = int(line.split()[1])
            elif line.startswith("Rss:"):
                process_rss_kib = int(line.split()[1])
        pss_kib += process_pss_kib
        rss_kib += process_rss_kib
        role = firefox_process_role(comm, arguments, is_root=pid in firefox_roots)
        group = roles.setdefault(role, {"pssKiB": 0, "rssKiB": 0, "processCount": 0})
        group["pssKiB"] += process_pss_kib
        group["rssKiB"] += process_rss_kib
        group["processCount"] += 1
        largest_processes.append({
            "pid": pid,
            "role": role,
            "comm": comm,
            "pssKiB": process_pss_kib,
            "rssKiB": process_rss_kib,
        })
    largest_processes.sort(key=lambda process: process["pssKiB"], reverse=True)
    return {
        "pssMiB": round(pss_kib / 1024, 1),
        "rssMiB": round(rss_kib / 1024, 1),
        "processCount": len(browser_processes),
        "processRoles": {
            role: {
                "pssMiB": round(group["pssKiB"] / 1024, 1),
                "rssMiB": round(group["rssKiB"] / 1024, 1),
                "processCount": group["processCount"],
            }
            for role, group in roles.items()
        },
        "largestProcesses": [
            {**process, "pssMiB": round(process["pssKiB"] / 1024, 1), "rssMiB": round(process["rssKiB"] / 1024, 1)}
            for process in largest_processes[:5]
        ],
    }


def run_once(plot_windows, interval_ms):
    env = os.environ.copy()
    env["VITE_ELSIM_PROFILE"] = "1"
    env["ELSIM_PERF_MEMORY_PHASES"] = "1"
    env["ELSIM_PERF_PLOT_WINDOWS"] = str(plot_windows)
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
    phase = "startup"
    observed_markers = set()
    peaks = {phase: {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0}}
    overall = {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0}
    wasm_bytes = None
    output_closed = False
    interval = interval_ms / 1000

    def record_memory_sample(sample_phase):
        memory = firefox_memory(process.pid)
        bucket = peaks.setdefault(sample_phase, {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0})
        bucket["samples"] += 1
        overall["samples"] += 1
        for key in ("pssMiB", "rssMiB"):
            bucket[key] = max(bucket[key], memory[key])
            overall[key] = max(overall[key], memory[key])
        role_peaks = bucket.setdefault("processRolePeaks", {})
        for role, role_memory in memory["processRoles"].items():
            peak = role_peaks.setdefault(role, {"pssMiB": 0.0, "rssMiB": 0.0, "processCount": 0})
            for key in ("pssMiB", "rssMiB"):
                peak[key] = max(peak[key], role_memory[key])
            peak["processCount"] = max(peak["processCount"], role_memory["processCount"])
        largest_peaks = bucket.setdefault("largestProcessPeaks", {})
        for process_memory in memory["largestProcesses"]:
            process_key = f"{process_memory['role']}:{process_memory['comm']}"
            current = largest_peaks.get(process_key)
            if current is None or process_memory["pssMiB"] > current["pssMiB"]:
                largest_peaks[process_key] = process_memory

    while process.poll() is None or not output_closed:
        try:
            while True:
                line = lines.get_nowait()
                if line is None:
                    output_closed = True
                    break
                print(line, end="", flush=True)
                if WORKER_PROFILE_PREFIX in line:
                    # Sample the phase that just ended before changing its
                    # bucket. Marker lines can arrive together between polling
                    # intervals, leaving a phase with no periodic sample.
                    record_memory_sample(phase)
                    try:
                        profile_text = line.split(WORKER_PROFILE_PREFIX, 1)[1]
                        wasm_bytes = json.loads(profile_text).get("wasmLinearMemoryBytes")
                    except (ValueError, TypeError):
                        pass
                    phase = "resultValidationAndTransfer"
                    observed_markers.add("workerProfile")
                    peaks.setdefault(phase, {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0})
                elif MEMORY_PHASE_PREFIX in line:
                    phase_name = line.split(MEMORY_PHASE_PREFIX, 1)[1].strip()
                    observed_markers.add(phase_name)
                    record_memory_sample(phase)
                    phase = {
                        "beforeRun": "solverAndResultTransfer",
                        "resultReady": "plotValidationAndInteraction",
                    }.get(phase_name, phase)
                    peaks.setdefault(phase, {"pssMiB": 0.0, "rssMiB": 0.0, "samples": 0})
        except queue.Empty:
            pass

        record_memory_sample(phase)
        time.sleep(interval)

    return_code = process.wait()
    missing_markers = {"beforeRun", "workerProfile", "resultReady"} - observed_markers
    report = {
        "benchmark": "firefox-million-sample-process-memory-v2",
        "plotWindows": plot_windows,
        "tracesPerWindow": 4,
        "sampleIntervalMs": interval_ms,
        "wasmLinearMemoryBytes": wasm_bytes,
        "phasePeaks": peaks,
        "overallPeak": overall,
        "observedPhaseMarkers": sorted(observed_markers),
        "missingPhaseMarkers": sorted(missing_markers),
        "limitations": [
            "Process roles are inferred from Firefox launch arguments and may vary by Firefox version.",
            "PSS/RSS are Firefox-process measurements, not ELSim-only allocations; worker threads may share a content process.",
            "startup ends when the benchmark page is ready immediately before simulation.",
            "solverAndResultTransfer ends at the worker's post-solve profile marker.",
            "resultValidationAndTransfer starts at that marker and ends when the result reaches the page.",
            "plotValidationAndInteraction starts when results are ready and includes plotting and cursor checks.",
            "WASM linear-memory capacity is not the same as peak process memory.",
            "This local run does not provide a second-hardware baseline.",
        ],
        "exitCode": return_code or (3 if missing_markers else 0),
    }
    print(json.dumps(report, indent=2))
    return report


def summarize_peak(reports, phase, key):
    values = [report["phasePeaks"][phase][key] for report in reports]
    return {
        "median": round(statistics.median(values), 1),
        "min": min(values),
        "max": max(values),
        "runs": len(values),
    }


def summarize_process_role_peak(reports, phase, role, key):
    values = [
        report["phasePeaks"][phase].get("processRolePeaks", {}).get(role, {}).get(key, 0.0)
        for report in reports
    ]
    return {
        "median": round(statistics.median(values), 1),
        "min": min(values),
        "max": max(values),
        "runs": len(values),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plot-windows", type=int, default=8, choices=range(1, 9))
    parser.add_argument("--interval-ms", type=int, default=100)
    parser.add_argument("--repeats", type=int, default=1, choices=range(1, 6), help="run the focused Firefox profile 1–5 times and summarize phase peaks")
    args = parser.parse_args()
    if not Path("/proc/self/smaps_rollup").exists():
        parser.error("this sampler requires Linux /proc with smaps_rollup support")
    if args.interval_ms < 20:
        parser.error("--interval-ms must be at least 20 to limit sampler overhead")

    reports = []
    for run_index in range(args.repeats):
        if args.repeats > 1:
            print(f"Firefox memory profile {run_index + 1}/{args.repeats}", flush=True)
        report = run_once(args.plot_windows, args.interval_ms)
        reports.append(report)
        if report["exitCode"]:
            return report["exitCode"]

    if args.repeats > 1:
        phases = ["startup", "solverAndResultTransfer", "resultValidationAndTransfer", "plotValidationAndInteraction"]
        roles = sorted({
            role
            for report in reports
            for phase in phases
            for role in report["phasePeaks"][phase].get("processRolePeaks", {})
        })
        summary = {
            "benchmark": "firefox-million-sample-process-memory-repeat-v1",
            "plotWindows": args.plot_windows,
            "tracesPerWindow": 4,
            "repeatCount": len(reports),
            "sampleIntervalMs": args.interval_ms,
            "wasmLinearMemoryBytes": sorted(report["wasmLinearMemoryBytes"] for report in reports),
            "phasePeakMiB": {
                phase: {key: summarize_peak(reports, phase, key) for key in ("pssMiB", "rssMiB")}
                for phase in phases
            },
            "phaseProcessRolePeakMiB": {
                phase: {
                    role: {key: summarize_process_role_peak(reports, phase, role, key) for key in ("pssMiB", "rssMiB")}
                    for role in roles
                }
                for phase in phases
            },
            "overallPeakMiB": {
                key: {
                    "median": round(statistics.median(report["overallPeak"][key] for report in reports), 1),
                    "min": min(report["overallPeak"][key] for report in reports),
                    "max": max(report["overallPeak"][key] for report in reports),
                    "runs": len(reports),
                }
                for key in ("pssMiB", "rssMiB")
            },
            "allPhaseMarkersObserved": all(not report["missingPhaseMarkers"] for report in reports),
            "limitations": [
                "Each run starts a fresh Playwright/Firefox process tree but shares the same host and runtime.",
                "Process roles are inferred from Firefox launch arguments and may vary by Firefox version.",
                "PSS/RSS are Firefox-process measurements, not ELSim-only allocations; worker threads may share a content process.",
                "WASM linear-memory capacity is not the same as peak process memory.",
                "Same-host repeats do not provide a second-hardware baseline.",
            ],
        }
        print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
