#!/usr/bin/env python3
"""Package an already compiled engine. No download, compile, install, or state mutation."""
import argparse, gzip, hashlib, io, json, pathlib, struct, tarfile, tomllib
TARGETS = {
    "x86_64-unknown-linux-gnu": ("elf", 62),
    "aarch64-unknown-linux-gnu": ("elf", 183),
    "x86_64-unknown-linux-musl": ("elf", 62),
    "aarch64-unknown-linux-musl": ("elf", 183),
    "x86_64-apple-darwin": ("macho", 0x01000007),
    "aarch64-apple-darwin": ("macho", 0x0100000C),
}
def sha(data): return hashlib.sha256(data).hexdigest()
def package(binary, target, output, build_inputs):
    root = pathlib.Path(__file__).resolve().parent.parent
    version = tomllib.loads((root / "Cargo.toml").read_text())["package"]["version"]
    if target not in TARGETS: raise ValueError("unsupported release target")
    binary = pathlib.Path(binary)
    if binary.is_symlink() or not binary.is_file(): raise ValueError("binary must be a regular non-symlink file")
    data = binary.read_bytes()
    kind, arch = TARGETS[target]
    if kind == "elf":
        if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01" or struct.unpack_from("<H", data, 18)[0] != arch: raise ValueError("binary header does not match complete Linux ELF64 target")
        kind_id, _, version_id = struct.unpack_from("<HHI", data, 16)
        phoff = struct.unpack_from("<Q", data, 32)[0]
        ehsize, phentsize, phnum = struct.unpack_from("<HHH", data, 52)
        if kind_id not in (2, 3) or version_id != 1 or ehsize != 64 or phentsize != 56 or not phnum or phoff < 64 or phoff + phentsize * phnum > len(data): raise ValueError("truncated or unsupported ELF executable layout")
        executable = False
        for offset in range(phoff, phoff + phentsize * phnum, phentsize):
            ptype, flags, fileoff, _, _, filesz, memsz, _ = struct.unpack_from("<IIQQQQQQ", data, offset)
            if filesz and (fileoff > len(data) or filesz > len(data) - fileoff): raise ValueError("ELF segment exceeds artifact bytes")
            if ptype == 1 and filesz > memsz: raise ValueError("ELF load segment size is invalid")
            executable |= ptype == 1 and bool(flags & 1)
        if not executable: raise ValueError("ELF has no executable load segment")
    else:
        if len(data) < 32 or data[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack_from("<I", data, 4)[0] != arch: raise ValueError("binary header does not match complete macOS Mach-O64 target")
        filetype, ncmds, sizeofcmds = struct.unpack_from("<III", data, 12)
        if filetype != 2 or not ncmds or sizeofcmds > len(data) - 32: raise ValueError("truncated or non-executable Mach-O layout")
        cursor = 32
        for _ in range(ncmds):
            if cursor + 8 > 32 + sizeofcmds: raise ValueError("truncated Mach-O load command")
            cmd, size = struct.unpack_from("<II", data, cursor)
            if size < 8 or size % 8 or cursor + size > 32 + sizeofcmds: raise ValueError("invalid Mach-O load command size")
            if cmd == 0x19:
                if size < 72: raise ValueError("truncated Mach-O64 segment")
                fileoff, filesize = struct.unpack_from("<QQ", data, cursor + 40)
                if fileoff > len(data) or filesize > len(data) - fileoff: raise ValueError("Mach-O segment exceeds artifact bytes")
            cursor += size
        if cursor != 32 + sizeofcmds: raise ValueError("Mach-O load command total mismatch")
    build = json.loads(pathlib.Path(build_inputs).read_text())
    required = {"rustc_version", "rustc_sha256", "cargo_version", "cargo_sha256", "target", "command", "source_date_epoch"}
    if set(build) != required or build["target"] != target or not isinstance(build["command"], list) or not build["command"] or not all(isinstance(x, str) for x in build["command"]): raise ValueError("incomplete declared build inputs")
    if not isinstance(build["source_date_epoch"], int) or build["source_date_epoch"] < 0: raise ValueError("invalid SOURCE_DATE_EPOCH")
    for key in ["rustc_version", "cargo_version"]:
        if not isinstance(build[key], str) or not build[key].strip() or len(build[key]) > 1024: raise ValueError("compiler version identity must be nonempty bounded text")
    for key in ["rustc_sha256", "cargo_sha256"]:
        value = build[key]
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value): raise ValueError("invalid compiler digest")
    sources = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part in {"target", ".git", "dist", "__pycache__"} for part in rel.parts): continue
        if path.is_symlink(): raise ValueError("source symlinks are not allowed")
        if path.is_file(): sources[str(rel)] = sha(path.read_bytes())
    source_sha = sha(json.dumps(sources, sort_keys=True, separators=(",", ":")).encode())
    artifacts = {"bin/kiokuko-guardrail": data, "protocols/coding-routine.lisp": (root / "examples/coding-routine.lisp").read_bytes(), "README.md": (root / "README.md").read_bytes()}
    manifest = {"schema": 1, "package": "kiokuko-guardrail", "version": version, "target": target, "source_sha256": source_sha, "sources": sources, "build_inputs": build, "artifacts": {p: {"sha256": sha(b), "bytes": len(b)} for p, b in sorted(artifacts.items())}, "scope": "Declared source/compiler/build inputs and artifact identity. This is not a signature, sandbox, or a claim of deterministic model inference or identical binaries across target operating systems."}
    artifacts["manifest.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    output = pathlib.Path(output).resolve()
    if output == root or root in output.parents: raise ValueError("package output must be outside the source tree")
    output.mkdir(parents=True, exist_ok=True)
    name = f"kiokuko-guardrail-{version}-{target}.tar.gz"
    archive = output / name
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for path, contents in sorted(artifacts.items()):
                    info = tarfile.TarInfo(path)
                    info.size = len(contents); info.mode = 0o755 if path.startswith("bin/") else 0o644
                    info.uid = info.gid = 0; info.uname = info.gname = ""; info.mtime = 0
                    tar.addfile(info, io.BytesIO(contents))
    digest = sha(archive.read_bytes())
    (output / (name + ".sha256")).write_text(f"{digest}  {name}\n")
    (output / (name + ".manifest.json")).write_bytes(artifacts["manifest.json"])
    return {"archive": str(archive), "sha256": digest, "source_sha256": source_sha, "target": target}
if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--binary", required=True); p.add_argument("--target", required=True)
    p.add_argument("--output", required=True); p.add_argument("--build-inputs", required=True)
    a = p.parse_args()
    try: print(json.dumps(package(a.binary, a.target, a.output, a.build_inputs), sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError) as e: p.exit(2, f"package error: {e}\n")
