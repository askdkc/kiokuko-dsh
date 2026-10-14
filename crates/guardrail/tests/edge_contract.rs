use kiokuko_guardrail::eval::NoHost;
use kiokuko_guardrail::protocol::compile;
use kiokuko_guardrail::{read, ErrorKind, Limits};
use std::process::Command;
#[test]
fn fifo_and_symlink_inputs_fail_promptly() {
    let script = r#"
import os, pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix='guardrail-input-edge-') as d:
 p=pathlib.Path(d); fifo=p/'fifo'; os.mkfifo(fifo)
 try: result=subprocess.run([os.environ['ENGINE'],'read',str(fifo)],capture_output=True,timeout=1)
 except subprocess.TimeoutExpired: raise AssertionError('FIFO input blocks instead of being rejected')
 assert result.returncode==2,result
 regular=p/'source'; regular.write_text('nil'); link=p/'link'; link.symlink_to(regular)
 result=subprocess.run([os.environ['ENGINE'],'read',str(link)],capture_output=True,timeout=1)
 assert result.returncode==2,'symlink input must fail closed'
"#;
    let out = Command::new("python3")
        .args(["-c", script])
        .env("ENGINE", env!("CARGO_BIN_EXE_kiokuko-guardrail"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn undeclared_guard_dependency_rejected() {
    let text="(defprotocol p (:phase a :produces x :next b) (:phase b :guard (equal x 'ok) :produces y :next a))";
    assert_eq!(
        compile(
            &read(text, Limits::default()).unwrap(),
            &NoHost,
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::Protocol
    );
}
#[test]
fn quoted_guard_symbols_are_inert_and_do_not_require_artifacts() {
    let text = "(defprotocol p (:phase a :guard (and t (equal 'x 'x)) :next :done))";
    assert!(compile(
        &read(text, Limits::default()).unwrap(),
        &NoHost,
        Limits::default()
    )
    .is_ok());
}
#[test]
fn declared_guard_dependency_accepted() {
    let text="(defprotocol p (:phase a :produces x :next b) (:phase b :requires x :guard (equal x 'ok) :produces y :next a))";
    assert!(compile(
        &read(text, Limits::default()).unwrap(),
        &NoHost,
        Limits::default()
    )
    .is_ok());
}
#[test]
fn necessarily_truncated_elf_and_macho_never_packaged() {
    let script = r#"
import json,os,pathlib,subprocess,tempfile
with tempfile.TemporaryDirectory(prefix='guardrail-truncated-') as d:
 p=pathlib.Path(d)
 for target,data in [('x86_64-unknown-linux-gnu',b'\x7fELF\x02\x01'+b'\0'*12+(62).to_bytes(2,'little')),('aarch64-apple-darwin',b'\xcf\xfa\xed\xfe'+(0x0100000c).to_bytes(4,'little'))]:
  binary=p/'binary';binary.write_bytes(data);meta=p/'inputs.json'
  meta.write_text(json.dumps(dict(rustc_version='fixture',rustc_sha256='0'*64,cargo_version='fixture',cargo_sha256='0'*64,target=target,command=['cargo','build'],source_date_epoch=0)))
  result=subprocess.run(['python3',os.environ['PACKAGER'],'--binary',str(binary),'--target',target,'--output',str(p/'out'),'--build-inputs',str(meta)],capture_output=True,timeout=5)
  assert result.returncode==2,(target,result)
"#;
    let out = Command::new("python3")
        .args(["-c", script])
        .env(
            "PACKAGER",
            format!("{}/scripts/package.py", env!("CARGO_MANIFEST_DIR")),
        )
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
