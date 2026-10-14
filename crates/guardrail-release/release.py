#!/usr/bin/env python3
"""Rebuild the frozen release with supplied, hash-pinned tools. Never downloads tools."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shlex
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE.parent / 'guardrail'
REPOSITORY = HERE.parent.parent
TARGETS = ('x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'x86_64-apple-darwin', 'aarch64-apple-darwin')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text())


def pinned_tool(path, expected, label):
    if path is None:
        raise ValueError(f'{label} path is required; install the recorded tool yourself')
    path = pathlib.Path(path).absolute()
    if not path.is_file() or sha(path.read_bytes()) != expected or not os.access(path, os.X_OK):
        raise ValueError(f'{label} executable identity mismatch: {path}')
    return path


def run(args, env, cwd, timeout=300):
    print('COMMAND ' + json.dumps([str(value) for value in args]), flush=True)
    return subprocess.run([str(value) for value in args], env=env, cwd=cwd, check=True, timeout=timeout, text=True, capture_output=True)


def release(args):
    source_manifest = load(HERE / 'source-manifest.json')
    actual = {}
    for file in sorted(SOURCE.rglob('*')):
        relative = file.relative_to(SOURCE)
        if any(part in {'target', '.git', 'dist', '__pycache__'} for part in relative.parts):
            continue
        if file.is_symlink():
            raise ValueError(f'Unexpected source symlink: {relative}')
        if file.is_file():
            actual[str(relative)] = sha(file.read_bytes())
    identity = sha(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode())
    if actual != source_manifest['files'] or identity != source_manifest['sourceSha256']:
        raise ValueError('Source differs from the frozen release; review and update release inputs before publishing new artifacts')
    provenance = load(HERE / 'release-provenance.json')
    build_inputs = load(HERE / 'build-inputs' / f'{args.target}.json')
    if provenance.get('source_sha256') != identity or build_inputs.get('target') != args.target:
        raise ValueError('Release input source/target identity mismatch')
    cargo = pinned_tool(args.cargo, build_inputs['cargo_sha256'], 'cargo')
    rustc = pinned_tool(args.rustc, build_inputs['rustc_sha256'], 'rustc')
    toolchains = provenance['toolchains']
    linker = None
    paths = [cargo.parent, rustc.parent]
    if args.target == 'x86_64-unknown-linux-musl':
        cc = pinned_tool(args.cc, toolchains['linux_x64']['cc_binary_sha256'], 'cc')
        ld = pinned_tool(args.ld, toolchains['linux_x64']['ld_binary_sha256'], 'ld')
        if cc.name != 'cc' or ld.name != 'ld':
            raise ValueError('The frozen x64 recipe requires compiler/linker entry points named cc and ld')
        linker = cc
        paths.extend([cc.parent, ld.parent])
    elif args.target == 'aarch64-unknown-linux-musl':
        linker = pinned_tool(args.rust_lld, toolchains['linux_arm64_linker_binary_sha256'], 'rust-lld')
    else:
        linker = pinned_tool(args.zig, toolchains['macos_zig_binary_sha256'], 'zig')
    output = pathlib.Path(args.output).resolve()
    if output == REPOSITORY or REPOSITORY in output.parents:
        raise ValueError('Release output must be outside the repository')
    command = [str(cargo), 'build', '--manifest-path', str(SOURCE / 'Cargo.toml'), '--locked', '--offline', '--release', '--target', args.target]
    target_key = 'CARGO_TARGET_' + args.target.upper().replace('-', '_') + '_LINKER'

    def recipe(temporary):
        flags = [f'--remap-path-prefix={SOURCE}=kiokuko-guardrail', f'--remap-path-prefix={temporary}=build']
        if args.target == 'aarch64-unknown-linux-musl':
            flags += ['-C', 'linker-flavor=ld.lld', '-C', 'link-self-contained=yes']
        selected = str(pathlib.Path(temporary) / 'mac-linker') if args.target.endswith('-apple-darwin') else str(linker)
        return {'compilerArguments': flags, 'encodedRustFlags': '\x1f'.join(flags), 'targetLinker': selected, 'targetLinkerKey': target_key,
                'driverLinkerBoundary': 'x64 ld is a hash-recorded environment input; compiler-driver search is not enforced'}

    if args.plan:
        print(json.dumps({'sourceSha256': identity, 'target': args.target, 'command': command, 'buildInputs': build_inputs, 'output': str(output), 'executed': False, **recipe('TEMP')}, indent=2))
        return
    if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise ValueError('This recorded reproducibility recipe uses a Linux x64 toolchain; native source development remains available through Cargo')
    copies = []
    for iteration in range(2):
        with tempfile.TemporaryDirectory(prefix='guardrail-rebuild-') as temporary:
            temp = pathlib.Path(temporary)
            (temp / 'home').mkdir()
            env = {
                'PATH': os.pathsep.join(dict.fromkeys([str(path) for path in paths] + ['/usr/bin', '/bin'])),
                'LANG': 'C.UTF-8', 'HOME': str(temp / 'home'), 'TMPDIR': str(temp),
                'RUSTC': str(rustc), 'LD_LIBRARY_PATH': str(rustc.parent.parent / 'lib'),
                'CARGO_HOME': str(temp / 'cargo-home'), 'CARGO_TARGET_DIR': str(temp / 'target'),
                'SOURCE_DATE_EPOCH': str(build_inputs['source_date_epoch']),
                'CARGO_ENCODED_RUSTFLAGS': recipe(temp)['encodedRustFlags'],
                target_key: recipe(temp)['targetLinker'],
            }
            if args.target.endswith('-apple-darwin'):
                zig_target = ('aarch64' if args.target.startswith('aarch64') else 'x86_64') + '-macos.13.0.0'
                wrapper = temp / 'mac-linker'
                wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(str(linker)) + ' cc -s -target ' + zig_target + ' "$@"\n')
                wrapper.chmod(0o755)
                env.update({target_key: str(wrapper), 'MACOSX_DEPLOYMENT_TARGET': '13.0', 'ZIG_GLOBAL_CACHE_DIR': str(temp / 'zig-global'), 'ZIG_LOCAL_CACHE_DIR': str(temp / 'zig-local')})
            result = run(command, env, SOURCE)
            print(result.stderr, end='')
            copies.append((temp / 'target' / args.target / 'release' / 'kiokuko-guardrail').read_bytes())
    if copies[0] != copies[1]:
        raise ValueError('Independent builds differed; no release artifact was written')
    recorded = next(record for record in provenance['availability']['linux'] + provenance['availability']['macos'] if record['target'] == args.target)
    if sha(copies[0]) != recorded['binary_sha256']:
        raise ValueError('Build is internally repeatable but differs from the recorded binary; inspect toolchain/system inputs')
    binary = output / args.target / 'kiokuko-guardrail'
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(copies[0]); binary.chmod(0o755)
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    packaged = run([sys.executable, SOURCE / 'scripts/package.py', '--binary', binary, '--target', args.target, '--output', output / 'packages', '--build-inputs', HERE / 'build-inputs' / f'{args.target}.json'], environment, SOURCE)
    result = json.loads(packaged.stdout)
    if result['sha256'] != recorded['package_sha256']:
        raise ValueError('Repacked archive differs from its recorded identity')
    native = 'not run'
    if args.target == 'x86_64-unknown-linux-musl':
        for arguments in [['--version'], ['validate', str(SOURCE / 'examples/coding-routine.lisp')]]:
            run([binary, *arguments], {'PATH': '', 'LANG': 'C.UTF-8'}, output, 10)
        native = 'passed'
    print(json.dumps({'target': args.target, 'sourceSha256': identity, 'binarySha256': sha(copies[0]), 'packageSha256': result['sha256'], 'independentBuildsEqual': True, 'nativeSmoke': native}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=TARGETS, required=True)
    parser.add_argument('--cargo', required=True)
    parser.add_argument('--rustc', required=True)
    parser.add_argument('--cc')
    parser.add_argument('--ld')
    parser.add_argument('--rust-lld')
    parser.add_argument('--zig')
    parser.add_argument('--output', required=True)
    parser.add_argument('--plan', action='store_true', help='Check source/tool identities and show the recipe without building or writing output')
    args = parser.parse_args()
    try:
        release(args)
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(2, f'release error: {error}\n')


if __name__ == '__main__':
    main()
