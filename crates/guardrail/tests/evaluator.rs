use kiokuko_guardrail::eval::*;
use kiokuko_guardrail::{read, Error, ErrorKind, Expr, Limits};
use std::cell::Cell;
fn expression(s: &str) -> Expr {
    read(s, Limits::default()).unwrap().remove(0)
}
fn ev(s: &str) -> Value {
    eval(&expression(s), &Env::new(), &NoHost, Limits::default()).unwrap()
}
struct Host {
    calls: Cell<usize>,
}
impl HostQuery for Host {
    fn queries(&self) -> Vec<QuerySpec> {
        vec![
            QuerySpec {
                name: "probe".into(),
                min_args: 1,
                max_args: 1,
            },
            QuerySpec {
                name: "explode".into(),
                min_args: 0,
                max_args: 0,
            },
        ]
    }
    fn call(&self, name: &str, args: &[Value]) -> Result<Value, Error> {
        self.calls.set(self.calls.get() + 1);
        if name == "explode" {
            Err(Error::new(ErrorKind::Host, "called forbidden branch"))
        } else {
            Ok(args[0].clone())
        }
    }
}
#[test]
fn scalar_literals_and_truth() {
    assert_eq!(ev("0"), Value::Int(0));
    assert_eq!(ev("\"\""), Value::Str("".into()));
    assert!(truthy(&ev("0")));
    assert!(truthy(&ev("\"\"")));
    assert_eq!(ev("t"), Value::Symbol("t".into()));
}
#[test]
fn quote_preserves_symbols() {
    assert_eq!(ev("'Failed"), Value::Symbol("failed".into()));
    assert_eq!(ev("(quote Failed)"), ev("'failed"));
    assert_eq!(
        ev("''x"),
        Value::List(vec![
            Value::Symbol("quote".into()),
            Value::Symbol("x".into())
        ])
    );
}
#[test]
fn nil_equivalence() {
    for s in [
        "nil",
        "()",
        "'()",
        "(list)",
        "(cdr '(a))",
        "(car nil)",
        "(cdr nil)",
    ] {
        assert_eq!(ev(s), Value::Nil, "{s}");
        assert_eq!(ev(&format!("(null {s})")), Value::Symbol("t".into()));
    }
}
#[test]
fn normalize_host_false_empty_recursively() {
    let h = Host {
        calls: Cell::new(0),
    };
    let mut env = Env::new();
    env.insert(
        "x".into(),
        Value::List(vec![
            Value::Bool(false),
            Value::List(vec![]),
            Value::Bool(true),
        ]),
    );
    assert_eq!(
        eval(&expression("(probe x)"), &env, &h, Limits::default()).unwrap(),
        Value::List(vec![Value::Nil, Value::Nil, Value::Symbol("t".into())])
    );
    env.insert("x".into(), Value::Bool(false));
    assert_eq!(
        eval(&expression("(probe x)"), &env, &h, Limits::default()).unwrap(),
        Value::Nil
    );
}
#[test]
fn and_or_return_values() {
    assert_eq!(ev("(and)"), Value::Symbol("t".into()));
    assert_eq!(ev("(or)"), Value::Nil);
    assert_eq!(ev("(and 1 \"yes\")"), Value::Str("yes".into()));
    assert_eq!(ev("(or nil 0 :no)"), Value::Int(0));
}
#[test]
fn host_short_circuit() {
    let h = Host {
        calls: Cell::new(0),
    };
    for s in [
        "(and nil (explode))",
        "(or :yes (explode))",
        "(if t :yes (explode))",
        "(when nil (explode))",
        "(unless t (explode))",
    ] {
        eval(&expression(s), &Env::new(), &h, Limits::default()).unwrap();
    }
    assert_eq!(h.calls.get(), 0);
}
#[test]
fn when_unless_sequence() {
    assert_eq!(ev("(when t 1 2 3)"), Value::Int(3));
    assert_eq!(ev("(unless nil :yes :last)"), Value::Keyword("last".into()));
    assert_eq!(ev("(when t)"), Value::Nil);
    assert_eq!(ev("(unless t 1)"), Value::Nil);
}
#[test]
fn numeric_comparisons() {
    for s in ["(= 2 2)", "(< -1 0)", "(> 3 2)", "(<= 2 2)", "(>= 2 2)"] {
        assert!(truthy(&ev(s)));
    }
    assert_eq!(ev("(< 2 1)"), Value::Nil);
}
#[test]
fn equality_policy() {
    assert!(truthy(&ev("(eq 'x 'X)")));
    assert!(truthy(&ev("(eq :ok :OK)")));
    assert_eq!(ev("(eq 'x :x)"), Value::Nil);
    assert!(truthy(&ev("(equal '(a (b)) '(A (B)))")));
    assert_eq!(ev("(eq '(a) '(a))"), Value::Nil);
}
#[test]
fn list_primitives() {
    assert_eq!(ev("(car '(a b))"), Value::Symbol("a".into()));
    assert_eq!(
        ev("(cdr '(a b))"),
        Value::List(vec![Value::Symbol("b".into())])
    );
    assert_eq!(
        ev("(cons 1 (list 2 3))"),
        Value::List(vec![Value::Int(1), Value::Int(2), Value::Int(3)])
    );
}
#[test]
fn bad_types() {
    for s in ["(< :x 1)", "(car 1)", "(cdr :a)", "(cons 1 2)"] {
        assert_eq!(
            eval(&expression(s), &Env::new(), &NoHost, Limits::default())
                .unwrap_err()
                .kind,
            ErrorKind::Type,
            "{s}"
        );
    }
}
#[test]
fn every_banned_form_and_unknown_is_rejected() {
    for form in [
        "defun",
        "defmacro",
        "lambda",
        "setq",
        "setf",
        "let",
        "let*",
        "loop",
        "dolist",
        "dotimes",
        "eval",
        "read",
        "load",
        "format",
        "print",
        "write",
        "open",
        "delete-file",
        "unknown",
    ] {
        let s = format!("({form})");
        assert_eq!(
            eval(&expression(&s), &Env::new(), &NoHost, Limits::default())
                .unwrap_err()
                .kind,
            ErrorKind::UnsupportedForm,
            "{form}"
        );
    }
}
#[test]
fn unsupported_dead_branches_still_rejected() {
    assert_eq!(
        eval(
            &expression("(if t :yes (load \"x\"))"),
            &Env::new(),
            &NoHost,
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::UnsupportedForm
    );
    assert_eq!(
        ev("'(load \"x\")"),
        Value::List(vec![Value::Symbol("load".into()), Value::Str("x".into())])
    );
}
#[test]
fn no_dynamic_operator() {
    assert_eq!(
        eval(
            &expression("((quote not) nil)"),
            &Env::new(),
            &NoHost,
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::UnsupportedForm
    );
}
#[test]
fn wrong_arities_fail_before_host_call() {
    let h = Host {
        calls: Cell::new(0),
    };
    for s in [
        "(not)",
        "(not nil nil)",
        "(if t 1)",
        "(quote)",
        "(car nil nil)",
        "(probe)",
        "(probe 1 2)",
        "(when)",
        "(= 1)",
    ] {
        assert_eq!(
            eval(&expression(s), &Env::new(), &h, Limits::default())
                .unwrap_err()
                .kind,
            ErrorKind::Arity,
            "{s}"
        );
    }
    assert_eq!(h.calls.get(), 0);
}
#[test]
fn unbound_is_distinct() {
    assert_eq!(
        eval(
            &expression("missing"),
            &Env::new(),
            &NoHost,
            Limits::default()
        )
        .unwrap_err()
        .kind,
        ErrorKind::Unbound
    );
}
#[test]
fn opaque_host_handles() {
    let h = Host {
        calls: Cell::new(0),
    };
    let mut env = Env::new();
    let v = Value::Host(HostValue {
        id: "evidence-17".into(),
    });
    env.insert("x".into(), v.clone());
    assert_eq!(
        eval(&expression("(probe x)"), &env, &h, Limits::default()).unwrap(),
        v
    );
    assert_eq!(
        eval(&expression("(car x)"), &env, &h, Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Type
    );
}
#[test]
fn host_errors_preserved() {
    let h = Host {
        calls: Cell::new(0),
    };
    assert_eq!(
        eval(&expression("(explode)"), &Env::new(), &h, Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::Host
    );
}
#[test]
fn steps_and_calls_bounded() {
    let h = Host {
        calls: Cell::new(0),
    };
    assert_eq!(
        eval(
            &expression("(list 1 2 3)"),
            &Env::new(),
            &h,
            Limits {
                steps: 2,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .kind,
        ErrorKind::ResourceLimit
    );
    assert_eq!(
        eval(
            &expression("(probe 1)"),
            &Env::new(),
            &h,
            Limits {
                host_calls: 0,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .kind,
        ErrorKind::ResourceLimit
    );
    assert_eq!(h.calls.get(), 0);
}
#[test]
fn value_budget() {
    let mut e = Env::new();
    e.insert("x".into(), Value::List(vec![Value::Int(1); 30]));
    assert_eq!(
        eval(
            &expression("x"),
            &e,
            &NoHost,
            Limits {
                value_nodes: 8,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .kind,
        ErrorKind::ResourceLimit
    );
}
#[test]
fn malicious_host_schema_rejected() {
    struct Bad;
    impl HostQuery for Bad {
        fn queries(&self) -> Vec<QuerySpec> {
            vec![QuerySpec {
                name: "load".into(),
                min_args: 0,
                max_args: 9,
            }]
        }
        fn call(&self, _: &str, _: &[Value]) -> Result<Value, Error> {
            panic!("must never run")
        }
    }
    assert_eq!(
        eval(&expression("(load)"), &Env::new(), &Bad, Limits::default())
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedForm
    );
}
#[test]
fn validation_has_no_host_calls() {
    let h = Host {
        calls: Cell::new(0),
    };
    validate(&expression("(probe :yes)"), &h, Limits::default()).unwrap();
    assert_eq!(h.calls.get(), 0);
}
#[test]
fn rendering_is_unambiguous() {
    assert_eq!(render(&ev("'(a :b nil \"x\\n\")")), "(a :b nil \"x\\n\")");
    assert_eq!(render(&Value::Bool(false)), "nil");
    assert_eq!(render(&Value::List(vec![])), "nil");
}
#[test] fn empty_list_truth_is_false_at_host_boundary(){assert!(!truthy(&Value::List(vec![])));assert!(!truthy(&Value::Bool(false)));assert!(truthy(&Value::Int(0)));}
