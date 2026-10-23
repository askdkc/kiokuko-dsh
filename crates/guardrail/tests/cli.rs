use kiokuko_guardrail::digest::sha256;
use kiokuko_guardrail::{read, Limits};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "kiokuko-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn file(&self, n: &str, s: &str) -> String {
        let p = self.0.join(n);
        fs::write(&p, s).unwrap();
        p.to_str().unwrap().to_owned()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_kiokuko-guardrail"))
        .args(args)
        .output()
        .unwrap()
}
fn text(o: &Output) -> String {
    String::from_utf8(o.stdout.clone()).unwrap()
}
const PROTOCOL:&str="(defprotocol coding (:phase tests :produces test-spec :next red) (:phase red :requires test-spec :guard (and (fails-p test-spec) (not (syntax-error-p test-spec)) (not (timeout-p test-spec))) :next implement :on-violation tests) (:phase implement :requires test-spec :produces patch :next green) (:phase green :requires test-spec patch :guard (and (passes-p test-spec patch) (eq (status patch) :applied)) :next :done :on-violation implement))";
fn evidence(outcome: &str, exit: i32, assertions: usize) -> String {
    let h = sha256(b"fixture");
    let operation_outcome = if matches!(outcome, "passed" | "produced" | "skipped" | "not-run") { "succeeded" } else { "failed" };
    format!(r#"(evidence :schema 2 :authority "kiokuko-dsh" :issuer "kiokuko-dsh:owned-execution:v1" :task "task-1" :revision 7
      :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19 :scope "scope-1"
      :collector (:version 1 :complete t :count 1 :unresolved 0 :digest "{h}")
      :executions ((execution :id "op-1" :scope "scope-1" :parent "eval-1" :sequence 1 :route :owned :kind :process :state :completed :outcome :{operation_outcome} :request "{h}" :runtime "{h}" :receipt "{h}" :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19))
      :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}" :model-provider "none" :model-name "none" :model-parameters "{h}" :transcript "{h}"
      :artifacts ((test-spec :id "receipt-1" :digest "{h}" :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19 :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}" :outcome :{outcome} :exit {exit} :assertions {assertions} :status :observed :provenance :execution-backed :supporting ("op-1") :history () :state-digest "{h}")
      (patch :id "patch-1" :digest "{h}" :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19 :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}" :outcome :produced :exit 0 :assertions 0 :status :applied :provenance :state-derived :supporting () :history () :state-digest "{h}")))"#)
}

#[test]
fn cli_version_from_package_metadata() {
    let o = run(&["--version"]);
    assert!(o.status.success());
    assert_eq!(
        text(&o).trim(),
        format!("kiokuko-guardrail {}", env!("CARGO_PKG_VERSION"))
    );
}
#[test]
fn cli_eval_is_pure_and_bounded() {
    let o = run(&["eval", "(and (= 1 1) 'good)"]);
    assert!(o.status.success(), "{:?}", o);
    assert_eq!(text(&o).trim(), "good");
    let o = run(&["eval", "(load \"untrusted\")"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8(o.stderr)
        .unwrap()
        .contains("UnsupportedForm"));
}
#[test]
fn cli_validate_and_read() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let o = run(&["validate", &p]);
    assert!(o.status.success(), "{:?}", o);
    assert!(text(&o).contains(":protocol-sha256"));
    assert!(read(&text(&o), Limits::default()).is_ok());
    let o = run(&["read", &p]);
    assert!(o.status.success());
    assert!(text(&o).contains("defprotocol"));
}
#[test]
fn real_assertion_receipt_allows_red() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", &evidence("assertion-failure", 1, 3));
    let before = fs::read(&e).unwrap();
    let o = run(&["check", &p, "red", &e]);
    assert_eq!(o.status.code(), Some(0), "{:?}", o);
    let s = text(&o);
    assert!(s.contains(":allow t"));
    assert!(s.contains(":authority-revision 7"));
    assert!(s.contains(":issuer \"kiokuko-dsh:owned-execution:v1\""));
    assert!(s.contains(":engine-sha256"));
    assert!(read(&s, Limits::default()).is_ok());
    assert_eq!(before, fs::read(&e).unwrap());
}
#[test]
fn syntax_timeout_setup_signaled_and_skipped_never_red() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    for (outcome, exit) in [
        ("syntax-error", 1),
        ("timeout", 124),
        ("setup-error", 127),
        ("signaled", 9),
        ("skipped", 0),
        ("not-run", 0),
        ("passed", 0),
    ] {
        let e = d.file("evidence.lisp", &evidence(outcome, exit, 1));
        let o = run(&["check", &p, "red", &e]);
        assert_eq!(o.status.code(), Some(3), "{outcome}: {o:?}");
        assert!(text(&o).contains(":allow nil"));
    }
}
#[test]
fn claimed_failure_without_assertions_cannot_unlock_red() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", &evidence("assertion-failure", 1, 0));
    assert_eq!(run(&["check", &p, "red", &e]).status.code(), Some(3));
}
#[test]
fn green_requires_actual_pass_receipt_and_applied_patch() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", &evidence("passed", 0, 4));
    assert_eq!(run(&["check", &p, "green", &e]).status.code(), Some(0));
    let e = d.file(
        "evidence.lisp",
        &evidence("passed", 0, 4).replace(":status :applied", ":status :pending"),
    );
    assert_eq!(run(&["check", &p, "green", &e]).status.code(), Some(3));
}
#[test]
fn stale_generation_and_snapshot_bindings_fail_closed() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let good = evidence("assertion-failure", 1, 3);
    for bad in [
        good.replacen(":protocol-generation 11", ":protocol-generation 12", 1),
        good.replacen(":lease-generation 19", ":lease-generation 20", 1),
        good.replacen(
            &format!(":source \"{}\"", sha256(b"fixture")),
            &format!(":source \"{}\"", sha256(b"changed")),
            1,
        ),
    ] {
        let e = d.file("evidence.lisp", &bad);
        let o = run(&["check", &p, "red", &e]);
        assert_eq!(o.status.code(), Some(2), "{o:?}");
    }
}
#[test]
fn evidence_schema_rejects_duplicates_unknowns_and_fake_status() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let good = evidence("assertion-failure", 1, 3);
    for bad in [
        good.replace(":schema 2", ":schema 2 :schema 2"),
        good.replace(":schema 2", ":schema 2 :extra t"),
        good.replace(":schema 2", ":schema 1"),
        good.replace(":assertion-failure", ":model-said-failed"),
        good.replace(":exit 1", ":exit 0"),
        good.replace(":authority \"kiokuko-dsh\"", ":authority \"model\""),
        good.replace(":protocol-generation 11", ":protocol-generation 0"),
    ] {
        let e = d.file("evidence.lisp", &bad);
        assert_eq!(run(&["check", &p, "red", &e]).status.code(), Some(2));
    }
}
#[test]
fn bytes_and_syntax_errors_have_distinct_codes() {
    let d = Temp::new();
    let p = d.file("bad.lisp", "(");
    assert_eq!(run(&["validate", &p]).status.code(), Some(2));
    let p = d.file("big.lisp", &"x".repeat(262145));
    assert_eq!(run(&["read", &p]).status.code(), Some(4));
}
#[test]
fn decision_reproducible_for_captured_inputs_across_processes() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", &evidence("assertion-failure", 1, 3));
    let a = run(&["check", &p, "red", &e]);
    let b = run(&["check", &p, "red", &e]);
    assert!(a.status.success());
    assert_eq!(a.stdout, b.stdout);
}
#[test]
fn metadata_changes_change_evidence_identity() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", &evidence("assertion-failure", 1, 3));
    let a = run(&["check", &p, "red", &e]);
    let e = d.file(
        "evidence.lisp",
        &evidence("assertion-failure", 1, 3)
            .replace(":model-name \"none\"", ":model-name \"captured-model-v1\""),
    );
    let b = run(&["check", &p, "red", &e]);
    assert!(a.status.success() && b.status.success());
    assert_ne!(a.stdout, b.stdout);
}
#[test]
fn packaging_script_and_portable_protocol_are_deliverable() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    assert!(
        root.join("scripts/package.py").is_file(),
        "release packaging script missing"
    );
    assert!(root.join("examples/coding-routine.lisp").is_file());
    assert!(root.join("README.md").is_file());
}

#[test]
fn missing_or_untrusted_issuer_is_rejected() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    for bad in [
        evidence("assertion-failure", 1, 3)
            .replace(":issuer \"kiokuko-dsh:owned-execution:v1\" ", ""),
        evidence("assertion-failure", 1, 3)
            .replace("kiokuko-dsh:owned-execution:v1", "model:claim"),
    ] {
        let e = d.file("evidence.lisp", &bad);
        assert_eq!(run(&["check", &p, "red", &e]).status.code(), Some(2));
    }
}

#[test]
fn legacy_schema1_evidence_requires_rebind() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let h = sha256(b"fixture");
    let legacy = format!(r#"(evidence :schema 1 :authority "kiokuko-dsh" :issuer "kiokuko-dsh:owned-execution:v1"
      :task "task-1" :revision 2 :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}"
      :model-provider "none" :model-name "none" :model-parameters "{h}" :transcript "{h}"
      :artifacts ((test-spec :id "receipt-1" :digest "{h}" :generation 1 :expected-generation 1
      :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}" :outcome :assertion-failure :exit 1 :assertions 3 :status :observed)))"#);
    let e = d.file("legacy.lisp", &legacy);
    assert_eq!(run(&["check", &p, "red", &e]).status.code(), Some(2));
}

#[test]
fn shared_schema2_green_fixture_passes_real_cli() {
    let d = Temp::new();
    let p = d.file("protocol.lisp", PROTOCOL);
    let e = d.file("evidence.lisp", include_str!("fixtures/schema2-green.lisp"));
    let output = run(&["check", &p, "green", &e]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(text(&output).contains(":allow t"));
}
