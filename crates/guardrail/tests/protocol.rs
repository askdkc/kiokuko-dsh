use kiokuko_guardrail::digest::sha256;
use kiokuko_guardrail::eval::*;
use kiokuko_guardrail::protocol::*;
use kiokuko_guardrail::{read, Error, ErrorKind, Limits};
use std::cell::Cell;
const FLOW:&str="(defprotocol flow (:phase request :produces request-context :next plan) (:phase plan :requires request-context :produces change-plan :next tests) (:phase tests :requires change-plan :produces test-spec :next red) (:phase red :requires test-spec :guard (and (fails-p test-spec) (not (syntax-error-p test-spec)) (not (timeout-p test-spec))) :next implement :on-violation tests) (:phase implement :requires change-plan test-spec :produces patch :next green) (:phase green :requires patch test-spec :guard (and (passes-p test-spec patch) (eq (status patch) :applied)) :next report :on-violation implement) (:phase report :requires patch test-spec :next :done))";
struct Evidence {
    calls: Cell<usize>,
}
impl HostQuery for Evidence {
    fn queries(&self) -> Vec<QuerySpec> {
        [
            "fails-p",
            "syntax-error-p",
            "timeout-p",
            "status",
            "passes-p",
        ]
        .iter()
        .map(|s| QuerySpec {
            name: s.to_string(),
            min_args: 1,
            max_args: if *s == "passes-p" { 2 } else { 1 },
        })
        .collect()
    }
    fn call(&self, name: &str, args: &[Value]) -> Result<Value, Error> {
        self.calls.set(self.calls.get() + 1);
        let id = match &args[0] {
            Value::Host(h) => h.id.as_str(),
            _ => return Err(Error::new(ErrorKind::Host, "need opaque evidence")),
        };
        Ok(match name {
            "fails-p" => Value::Bool(id == "assertion-failure"),
            "syntax-error-p" => Value::Bool(id == "syntax-error"),
            "timeout-p" => Value::Bool(id == "timeout"),
            "passes-p" => Value::Bool(true),
            "status" => Value::Keyword("applied".into()),
            _ => unreachable!(),
        })
    }
}
fn host() -> Evidence {
    Evidence {
        calls: Cell::new(0),
    }
}
fn protocol(s: &str) -> Protocol {
    compile(
        &read(s, Limits::default()).unwrap(),
        &host(),
        Limits::default(),
    )
    .unwrap()
}
fn out(s: &RunState, name: &str, id: &str) -> Output {
    Output {
        name: name.into(),
        value: Value::Host(HostValue { id: id.into() }),
        digest: sha256(id.as_bytes()),
        entry: s.entry,
    }
}
fn advance_one(p: &Protocol, s: &RunState, name: &str, id: &str) -> RunState {
    advance(p, s, &[out(s, name, id)], &host(), Limits::default())
        .unwrap()
        .state
}
fn at_red(p: &Protocol, id: &str) -> RunState {
    let s = start(p).unwrap();
    let s = advance_one(p, &s, "request-context", "request");
    let s = advance_one(p, &s, "change-plan", "plan");
    advance_one(p, &s, "test-spec", id)
}
#[test]
fn compile_declaration_and_validate_without_queries() {
    let h = host();
    let p = compile(
        &read(FLOW, Limits::default()).unwrap(),
        &h,
        Limits::default(),
    )
    .unwrap();
    assert_eq!(p.name, "flow");
    assert_eq!(p.phases.len(), 7);
    assert_eq!(h.calls.get(), 0);
    assert_eq!(p.phases[4].requires, vec!["change-plan", "test-spec"]);
}
#[test]
fn full_pure_lifecycle() {
    let p = protocol(FLOW);
    let s = at_red(&p, "assertion-failure");
    let original = s.clone();
    let t = advance(&p, &s, &[], &host(), Limits::default()).unwrap();
    assert_eq!(s, original);
    assert_eq!(t.state.phase, "implement");
    let s = advance_one(&p, &t.state, "patch", "patch");
    let s = advance(&p, &s, &[], &host(), Limits::default())
        .unwrap()
        .state;
    let t = advance(&p, &s, &[], &host(), Limits::default()).unwrap();
    assert_eq!(t.decision, Decision::Done);
    assert!(t.state.done);
    assert_eq!(
        advance(&p, &t.state, &[], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn red_rejects_syntax_timeout_and_missing_assertion() {
    let p = protocol(FLOW);
    for id in ["syntax-error", "timeout", "setup-error", "success"] {
        let s = at_red(&p, id);
        let t = advance(&p, &s, &[], &host(), Limits::default()).unwrap();
        assert_eq!(t.decision, Decision::Rejected, "{id}");
        assert_eq!(t.state.phase, "tests");
        assert!(!t.state.artifacts.contains_key("test-spec"));
    }
}
#[test]
fn stale_output_entry_rejected_after_revisit() {
    let p = protocol(FLOW);
    let s = at_red(&p, "timeout");
    let t = advance(&p, &s, &[], &host(), Limits::default()).unwrap();
    let mut old = out(&t.state, "test-spec", "assertion-failure");
    old.entry = 3;
    assert_eq!(
        advance(&p, &t.state, &[old], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn requires_and_produces_enforced() {
    let p = protocol(FLOW);
    let s = start(&p).unwrap();
    assert_eq!(
        advance(&p, &s, &[], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
    assert_eq!(
        advance(&p, &s, &[out(&s, "patch", "x")], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
    let mut s = at_red(&p, "assertion-failure");
    s.artifacts.remove("test-spec");
    assert_eq!(
        advance(&p, &s, &[], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn transitive_artifact_invalidation_on_repeated_phase() {
    let text="(defprotocol loop-test (:phase a :produces x :next b) (:phase b :requires x :produces y :next c) (:phase c :requires y :produces z :next d) (:phase d :requires z :guard nil :next :done :on-violation a))";
    let p = protocol(text);
    let s = start(&p).unwrap();
    let s = advance_one(&p, &s, "x", "x1");
    let s = advance_one(&p, &s, "y", "y1");
    let s = advance_one(&p, &s, "z", "z1");
    assert_eq!(s.artifacts.len(), 3);
    let t = advance(&p, &s, &[], &host(), Limits::default()).unwrap();
    assert_eq!(t.state.phase, "a");
    assert!(t.state.artifacts.is_empty());
    let s = advance_one(&p, &t.state, "x", "x1");
    assert!(s.artifacts["x"].generation > 3);
}
#[test]
fn stale_dependency_generation_rejected() {
    let p = protocol(FLOW);
    let mut s = at_red(&p, "assertion-failure");
    s.artifacts.get_mut("change-plan").unwrap().generation = 99;
    assert_eq!(
        advance(&p, &s, &[], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn protocol_replacement_rejected() {
    let p = protocol(FLOW);
    let s = start(&p).unwrap();
    let q = protocol(&FLOW.replace(":next plan", ":next report"));
    assert_eq!(
        advance(
            &q,
            &s,
            &[out(&s, "request-context", "x")],
            &host(),
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::Violation
    );
}
#[test]
fn duplicate_phase_artifact_or_property_rejected() {
    for s in [
        "(defprotocol p (:phase a :next :done) (:phase a :next :done))",
        "(defprotocol p (:phase a :produces x :next b) (:phase b :produces x :next :done))",
        "(defprotocol p (:phase a :next :done :next :done))",
        "(defprotocol p (:phase a :produces x x :next :done))",
    ] {
        assert_eq!(
            compile(
                &read(s, Limits::default()).unwrap(),
                &host(),
                Limits::default()
            )
            .unwrap_err()
            .kind,
            ErrorKind::Protocol,
            "{s}"
        );
    }
}
#[test]
fn bad_links_unknown_fields_and_external_forms_rejected() {
    for s in [
        "(defprotocol p (:phase a :next nowhere))",
        "(defprotocol p (:phase a :requires missing :next :done))",
        "(defprotocol p (:phase a :foo x :next :done))",
        "(defprotocol p (:phase a))",
        "(defprotocol p)",
        "(load \"x\")",
        "(defprotocol p (:phase a :next :done)) (defprotocol q (:phase b :next :done))",
    ] {
        assert_eq!(
            compile(
                &read(s, Limits::default()).unwrap(),
                &host(),
                Limits::default()
            )
            .unwrap_err()
            .kind,
            ErrorKind::Protocol,
            "{s}"
        );
    }
}
#[test]
fn forbidden_guard_rejected_even_unreachable() {
    let s = "(defprotocol p (:phase a :guard (if t :yes (load \"x\")) :next :done))";
    assert_eq!(
        compile(
            &read(s, Limits::default()).unwrap(),
            &host(),
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::UnsupportedForm
    );
}
#[test]
fn direct_check_is_read_only_and_requires_bindings() {
    let p = protocol(FLOW);
    let h = host();
    let mut env = Env::new();
    env.insert(
        "test-spec".into(),
        Value::Host(HostValue {
            id: "assertion-failure".into(),
        }),
    );
    assert!(check_phase(&p, "red", &env, &h, Limits::default()).unwrap());
    assert!(!env.contains_key("patch"));
    assert_eq!(
        check_phase(&p, "report", &env, &h, Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn invalid_artifact_digest_rejected() {
    let p = protocol(FLOW);
    let s = start(&p).unwrap();
    let mut output = out(&s, "request-context", "request");
    output.digest = "user-said-pass".into();
    assert_eq!(
        advance(&p, &s, &[output], &host(), Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Violation
    );
}
#[test]
fn violation_without_route_keeps_phase_and_discards_outputs() {
    let p = protocol("(defprotocol p (:phase a :produces x :guard nil :next :done))");
    let s = start(&p).unwrap();
    let t = advance(&p, &s, &[out(&s, "x", "x")], &host(), Limits::default()).unwrap();
    assert_eq!(t.decision, Decision::Rejected);
    assert_eq!(t.state, s);
}
