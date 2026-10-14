#!/usr/bin/env python3
"""Build failures/timeouts are never an assertion RED; own all temporary state."""
import json, os, pathlib, subprocess, sys, tempfile
cargo, rustc, suite = sys.argv[1:]
root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="kiokuko-guardrail-test-") as target:
    env = dict(os.environ, RUSTC=rustc, CARGO_TARGET_DIR=target, CARGO_HOME=target + "/cargo-home")
    args = [cargo, "test", "--manifest-path", str(root / "Cargo.toml"), "--offline", "--locked", "--no-run", "--message-format=json"]
    if suite != "all": args += ["--test", suite]
    try:
        build = subprocess.run(args, cwd=root, env=env, text=True, capture_output=True, timeout=180)
        print(build.stderr, end="")
        if build.returncode:
            print("BUILD_ERROR", build.stdout, flush=True); sys.exit(2)
        bins = []
        for line in build.stdout.splitlines():
            msg = json.loads(line)
            if msg.get("reason") == "compiler-artifact" and msg.get("profile", {}).get("test") and msg.get("executable"): bins.append(msg["executable"])
        if not bins: print("BUILD_ERROR: no test executable", flush=True); sys.exit(2)
        failed = False
        for binary in sorted(bins):
            run = subprocess.run([binary, "--nocapture"], cwd=root, env=env, timeout=120)
            if run.returncode not in (0, 101): print("EXECUTION_ERROR", run.returncode, flush=True); sys.exit(2)
            failed |= run.returncode != 0
        sys.exit(1 if failed else 0)
    except subprocess.TimeoutExpired:
        print("TIMEOUT", flush=True); sys.exit(4)
