use kiokuko_guardrail::digest::sha256;
use kiokuko_guardrail::host::{EvidenceSnapshot, ExecutionOutcome, Provenance, Route};
use kiokuko_guardrail::{ErrorKind, Limits};

fn execution(id: &str, sequence: u64, route: &str, state: &str, outcome: &str) -> String {
    let h = sha256(b"fixture");
    format!(r#"(execution :id "{id}" :scope "scope-1" :parent "eval-1" :sequence {sequence}
      :route :{route} :kind :process :state :{state} :outcome :{outcome}
      :request "{h}" :runtime "{h}" :receipt "{h}" :worker-generation "worker-3"
      :protocol-generation 11 :lease-generation 19)"#)
}
fn artifact(name: &str, provenance: &str, supporting: &str, history: &str, outcome: &str) -> String {
    let h = sha256(b"fixture");
    let exit = if outcome == "assertion-failure" { 1 } else { 0 };
    format!(r#"({name} :id "artifact-{name}" :digest "{h}" :worker-generation "worker-3"
      :protocol-generation 11 :lease-generation 19 :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}"
      :outcome :{outcome} :exit {exit} :assertions 3 :status :observed
      :provenance :{provenance} :supporting ({supporting}) :history ({history}) :state-digest "{h}")"#)
}
fn snapshot(executions: &[String], artifacts: &[String]) -> String {
    let h = sha256(b"fixture");
    let count = executions.len();
    let executions = executions.join(" ");
    let artifacts = artifacts.join(" ");
    format!(r#"(evidence :schema 2 :authority "kiokuko-dsh" :issuer "kiokuko-dsh:owned-execution:v1"
      :task "task-1" :revision 2 :worker-generation "worker-3" :protocol-generation 11 :lease-generation 19
      :scope "scope-1" :collector (:version 1 :complete t :count {count} :unresolved 0 :digest "{h}")
      :executions ({executions}) :source "{h}" :tests "{h}" :command "{h}" :runtime "{h}"
      :model-provider "none" :model-name "none" :model-parameters "{h}" :transcript "{h}" :artifacts ({artifacts}))"#)
}
fn green() -> String {
    snapshot(
        &[execution("op-1", 1, "owned", "completed", "succeeded")],
        &[artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed")],
    )
}
fn accepts(input: &str) -> EvidenceSnapshot {
    EvidenceSnapshot::parse(input, Limits::default()).unwrap()
}
fn rejects(input: &str, reason: &str) {
    let e = EvidenceSnapshot::parse(input, Limits::default()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Host, "{e}");
    assert!(e.message.contains(reason), "wanted {reason:?}, got {e}");
}

#[test]
fn independent_generations_do_not_compare_to_revision() {
    let evidence = accepts(&green());
    assert_eq!(evidence.revision, 2);
    assert_eq!(evidence.worker_generation, "worker-3");
    assert_eq!(evidence.protocol_generation, 11);
    assert_eq!(evidence.lease_generation, 19);
    for (from, to) in [
        (":worker-generation \"worker-3\"", ":worker-generation \"worker-4\""),
        (":protocol-generation 11", ":protocol-generation 12"),
        (":lease-generation 19", ":lease-generation 20"),
    ] {
        rejects(&green().replacen(from, to, 1), "stale artifact generation");
        let e = execution("op-1", 1, "owned", "completed", "succeeded").replace(from, to);
        rejects(&snapshot(&[e], &[artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed")]), "not current completed evidence");
        let a = artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed").replace(from, to);
        rejects(&snapshot(&[execution("op-1", 1, "owned", "completed", "succeeded")], &[a]), "stale artifact generation");
    }
}

#[test]
fn red_failure_and_prior_history_are_not_success_evidence() {
    let old = execution("old", 1, "native", "completed", "failed")
        .replace("worker-3", "worker-old")
        .replace(":protocol-generation 11", ":protocol-generation 99")
        .replace(":lease-generation 19", ":lease-generation 1")
        .replace(&sha256(b"fixture"), &sha256(b"old-inputs"));
    let current = execution("current", 2, "owned", "completed", "succeeded");
    let a = artifact("test-spec", "execution-backed", r#""current""#, r#""old""#, "passed");
    let parsed = accepts(&snapshot(&[old.clone(), current.clone()], &[a.clone()]));
    assert_eq!(parsed.executions["old"].outcome, ExecutionOutcome::Failed);
    assert_eq!(parsed.executions["old"].route, Route::Native);
    assert_eq!(parsed.records["test-spec"].history, ["old"]);
    rejects(&snapshot(&[old, current], &[a.replace(":supporting (\"current\")", ":supporting (\"old\")")]), "not current completed evidence");
    let red = snapshot(&[execution("red", 1, "owned", "completed", "failed")], &[artifact("test-spec", "execution-backed", r#""red""#, "", "assertion-failure")]);
    accepts(&red);
    rejects(&red.replace(":outcome :failed", ":outcome :succeeded"), "outcome conflicts with supporting execution");
    rejects(&green().replace(":outcome :succeeded", ":outcome :failed"), "outcome conflicts with supporting execution");
}

#[test]
fn native_and_file_executions_cannot_replace_test_observations() {
    for (from, to) in [(":route :owned", ":route :native"), (":kind :process", ":kind :file")] {
        rejects(&green().replace(from, to), "requires an owned process execution");
        // Protocols may use another artifact binding name; it is no loophole.
        rejects(&green().replace("test-spec", "renamed-test").replace(from, to), "requires an owned process execution");
    }
    let mixed = snapshot(
        &[
            execution("native", 1, "native", "completed", "succeeded"),
            execution("owned", 2, "owned", "completed", "succeeded"),
            execution("file", 3, "owned", "completed", "succeeded").replace(":kind :process", ":kind :file"),
        ],
        &[artifact("result", "execution-backed", r#""native" "owned" "file""#, "", "produced")],
    );
    accepts(&mixed);
}

#[test]
fn state_derived_patch_needs_current_source_not_a_fake_process() {
    let patch = artifact("patch", "state-derived", "", "", "produced");
    let parsed = accepts(&snapshot(&[], &[patch.clone()]));
    assert_eq!(parsed.records["patch"].provenance, Provenance::StateDerived);
    rejects(&snapshot(&[], &[patch.replace(&format!(":state-digest \"{}\"", sha256(b"fixture")), &format!(":state-digest \"{}\"", sha256(b"other")))]), "requires current source state");
    rejects(&snapshot(&[execution("op-1", 1, "owned", "completed", "succeeded")], &[artifact("patch", "state-derived", r#""op-1""#, "", "produced")]), "requires current source state");
    rejects(&snapshot(&[], &[artifact("test-spec", "state-derived", "", "", "passed")]), "test evidence requires execution-backed");
}

#[test]
fn pure_evaluation_requires_host_complete_zero_scope() {
    let pure = artifact("result", "pure-evaluation", "", "", "produced");
    let good = snapshot(&[], &[pure.clone()]);
    accepts(&good);
    rejects(&good.replace(":complete t", ":complete nil"), "incomplete execution collector");
    rejects(&good.replace(":count 0", ":count 1"), "collector count differs");
    rejects(&good.replace(":unresolved 0", ":unresolved 1"), "collector count differs");
    rejects(&snapshot(&[execution("old", 1, "native", "completed", "failed")], &[pure]), "zero-execution snapshot");
    rejects(&snapshot(&[], &[artifact("test-spec", "pure-evaluation", "", "", "passed")]), "test evidence requires execution-backed");
}

#[test]
fn unresolved_operations_block_even_an_unrelated_success() {
    for state in ["unknown", "prepared", "dispatching", "running"] {
        let input = snapshot(
            &[execution("success", 1, "owned", "completed", "succeeded"), execution("pending", 2, "native", state, "none")],
            &[artifact("test-spec", "execution-backed", r#""success""#, "", "passed")],
        );
        rejects(&input, "collector count differs");
        rejects(&input.replace(":unresolved 0", ":unresolved 1"), "unresolved operations");
    }
    for state in ["denied", "cancelled-before-dispatch", "cancelled-confirmed"] {
        let resolved_history = snapshot(
            &[execution("history", 1, "native", state, "none"), execution("success", 2, "owned", "completed", "succeeded")],
            &[artifact("test-spec", "execution-backed", r#""success""#, r#""history""#, "passed")],
        );
        accepts(&resolved_history);
        rejects(&resolved_history.replace(":supporting (\"success\")", ":supporting (\"history\")"), "not current completed evidence");
    }
}

#[test]
fn execution_and_reference_identity_fail_closed() {
    let e = execution("op-1", 1, "owned", "completed", "succeeded");
    let a = artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed");
    rejects(&snapshot(&[e.clone(), e.clone().replace(":sequence 1", ":sequence 2")], &[a.clone()]), "duplicate execution id");
    rejects(&snapshot(&[e.clone(), e.clone().replace("op-1", "op-2")], &[a.clone()]), "sequence is duplicate");
    rejects(&snapshot(&[e.clone().replace(":sequence 1", ":sequence 2")], &[a.clone()]), "sequence is duplicate or incomplete");
    rejects(&snapshot(&[e.clone().replace("scope-1", "scope-other")], &[a.clone()]), "scope differs");
    rejects(&snapshot(&[e.clone()], &[a.clone().replace("op-1", "missing")]), "unresolved artifact execution reference");
    rejects(&snapshot(&[e.clone()], &[a.clone().replace(":history ()", ":history (\"missing\")")]), "unresolved artifact execution reference");
    rejects(&snapshot(&[e.clone()], &[a.clone().replace(":supporting (\"op-1\")", ":supporting (\"op-1\" \"op-1\")")]), "duplicate execution reference");
    rejects(&snapshot(&[e.clone()], &[a.clone().replace(":history ()", ":history (\"op-1\" \"op-1\")")]), "duplicate execution reference");
    rejects(&snapshot(&[e.clone()], &[a.replace(":supporting (\"op-1\")", ":supporting ()")]), "requires supporting executions");
    let a = artifact("result", "execution-backed", r#""op-1""#, "", "produced");
    rejects(&snapshot(&[e], &[a.clone(), a.replace("(result ", "(another ")]), "duplicate artifact name or opaque handle");
}

#[test]
fn nested_schemas_reject_missing_unknown_and_duplicate_fields() {
    for (from, to) in [
        (":schema 2", ":schema 1"),
        (":schema 2", ":schema 2 :extra t"),
        (":schema 2", ":schema 2 :schema 2"),
        (":version 1", ":version 1 :version 1"),
        (":version 1", ":version 1 :unknown t"),
        (":version 1", ":version 2"),
        (":complete t", ":complete 1"),
        (":route :owned", ":route :owned :route :native"),
        (":route :owned", ":route :owned :extra nil"),
        (":route :owned", ""),
        (":provenance :execution-backed", ":provenance :execution-backed :extra nil"),
        (":provenance :execution-backed", ":provenance :execution-backed :provenance :pure-evaluation"),
        (":supporting (\"op-1\")", ""),
    ] {
        assert!(EvidenceSnapshot::parse(&green().replace(from, to), Limits::default()).is_err(), "{from} => {to}");
    }
    // Same-sized duplicate replacements exercise duplicate checking, not just field counts.
    for (from, to) in [
        (":lease-generation 19", ":protocol-generation 19"),
        (":unresolved 0", ":count 0"),
        (":kind :process", ":route :owned"),
        (":status :observed", ":provenance :execution-backed"),
    ] {
        rejects(&green().replace(from, to), "unknown or duplicate snapshot field");
    }
}

#[test]
fn enum_digest_and_scalar_boundaries_are_checked_at_every_layer() {
    for (from, to, reason) in [
        (":route :owned", ":route :model", "unknown execution route"),
        (":kind :process", ":kind :socket", "unknown execution kind"),
        (":state :completed", ":state :accepted", "unknown execution state"),
        (":outcome :succeeded", ":outcome :maybe", "unknown execution outcome"),
        (":outcome :succeeded", ":outcome :none", "state conflicts with outcome"),
        (":state :completed", ":state :denied", "state conflicts with outcome"),
        (":provenance :execution-backed", ":provenance :claimed", "unknown artifact provenance"),
        (":outcome :passed", ":outcome :ok", "unknown evidence outcome"),
        (":status :observed", ":status :trusted", "unknown artifact status"),
        (":sequence 1", ":sequence 0", "positive integer"),
        (":count 1", ":count -1", "nonnegative integer"),
        (":unresolved 0", ":unresolved -1", "nonnegative integer"),
        (":worker-generation \"worker-3\"", ":worker-generation 3", "bounded nonempty text"),
        (":scope \"scope-1\"", ":scope \"\"", "bounded nonempty text"),
        (":parent \"eval-1\"", ":parent nil", "bounded nonempty text"),
        (":exit 0", ":exit 256", "invalid assertion count or exit code"),
        (":assertions 3", ":assertions -1", "invalid assertion count or exit code"),
    ] {
        rejects(&green().replace(from, to), reason);
    }
    for key in ["digest", "request", "runtime", "receipt", "state-digest", "source", "tests", "command", "model-parameters", "transcript"] {
        for invalid in ["0".repeat(63), "A".repeat(64), "g".repeat(64)] {
            rejects(&green().replace(&format!(":{key} \"{}\"", sha256(b"fixture")), &format!(":{key} \"{invalid}\"")), "lowercase SHA-256");
        }
    }
    let e = execution("op-1", 1, "owned", "completed", "succeeded")
        .replace(&format!(":runtime \"{}\"", sha256(b"fixture")), &format!(":runtime \"{}\"", sha256(b"changed")));
    rejects(&snapshot(&[e], &[artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed")]), "not current completed evidence");
}

#[test]
fn execution_and_reference_counts_have_hard_limits() {
    let executions: Vec<_> = (1..=513).map(|n| execution(&format!("op-{n}"), n, "owned", "completed", "succeeded")).collect();
    let limits = Limits { input_bytes: 1_048_576, nodes: 65_536, ..Limits::default() };
    EvidenceSnapshot::parse(&snapshot(&executions[..512], &[]), limits).unwrap();
    let error = EvidenceSnapshot::parse(&snapshot(&executions, &[]), limits).unwrap_err();
    assert_eq!(error.kind, ErrorKind::ResourceLimit);
    assert_eq!(error.message, "execution count limit");
    let refs = (1..=513).map(|n| format!("\"op-{n}\"")).collect::<Vec<_>>().join(" ");
    let error = EvidenceSnapshot::parse(&snapshot(&[], &[artifact("result", "execution-backed", &refs, "", "produced")]), limits).unwrap_err();
    assert_eq!(error.kind, ErrorKind::ResourceLimit);
    assert_eq!(error.message, "execution reference count limit");
    let refs = (1..=512).map(|n| format!("\"op-{n}\"")).collect::<Vec<_>>().join(" ");
    EvidenceSnapshot::parse(&snapshot(&executions[..512], &[artifact("result", "execution-backed", &refs, "", "produced")]), limits).unwrap();
    let artifacts: Vec<_> = (1..=513).map(|n| artifact(&format!("patch-{n}"), "state-derived", "", "", "produced")).collect();
    EvidenceSnapshot::parse(&snapshot(&[], &artifacts[..512]), limits).unwrap();
    let error = EvidenceSnapshot::parse(&snapshot(&[], &artifacts), limits).unwrap_err();
    assert_eq!(error.kind, ErrorKind::ResourceLimit);
    assert_eq!(error.message, "artifact count limit");
}

#[test]
fn current_artifact_inputs_and_identifier_bounds_are_independent() {
    for key in ["source", "tests", "command", "runtime"] {
        let a = artifact("test-spec", "execution-backed", r#""op-1""#, "", "passed")
            .replace(&format!(":{key} \"{}\"", sha256(b"fixture")), &format!(":{key} \"{}\"", sha256(b"other")));
        rejects(&snapshot(&[execution("op-1", 1, "owned", "completed", "succeeded")], &[a]), "artifact input binding differs");
    }
    let long = "w".repeat(1024);
    accepts(&green().replace("worker-3", &long));
    rejects(&green().replace("worker-3", &(long + "w")), "bounded nonempty text");
}
