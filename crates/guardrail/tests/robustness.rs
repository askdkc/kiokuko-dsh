use kiokuko_guardrail::eval::*;
use kiokuko_guardrail::{read, ErrorKind, Expr, Limits};
#[test]
fn cumulative_host_string_bytes_are_bounded() {
    let mut env = Env::new();
    env.insert("x".into(), Value::Str("x".repeat(40)));
    let expr = read("(list x x)", Limits::default()).unwrap().remove(0);
    assert_eq!(
        eval(
            &expr,
            &env,
            &NoHost,
            Limits {
                input_bytes: 64,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .kind,
        ErrorKind::ResourceLimit
    );
}
#[test]
fn numeric_looking_host_symbols_cannot_serialize_as_numbers() {
    for s in ["-1", "+42"] {
        let mut env = Env::new();
        env.insert("x".into(), Value::Symbol(s.into()));
        assert_eq!(
            eval(&Expr::Symbol("x".into()), &env, &NoHost, Limits::default())
                .unwrap_err()
                .kind,
            ErrorKind::Host
        );
    }
}
#[test]
fn numeric_keywords_match_reader_policy() {
    let expr = read("(list :0 :-1)", Limits::default()).unwrap().remove(0);
    assert_eq!(
        eval(&expr, &Env::new(), &NoHost, Limits::default()).unwrap(),
        Value::List(vec![
            Value::Keyword("0".into()),
            Value::Keyword("-1".into())
        ])
    );
}
#[test]
fn manually_constructed_ast_aggregate_bytes_bounded() {
    let expr = Expr::Quote(Box::new(Expr::List(vec![
        Expr::Str("x".repeat(40)),
        Expr::Str("y".repeat(40)),
    ])));
    assert_eq!(
        eval(
            &expr,
            &Env::new(),
            &NoHost,
            Limits {
                input_bytes: 64,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .kind,
        ErrorKind::ResourceLimit
    );
}
