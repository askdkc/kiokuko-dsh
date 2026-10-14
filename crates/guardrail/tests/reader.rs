use kiokuko_guardrail::{read, Expr, ErrorKind, Limits};
fn parse(s:&str)->Vec<Expr>{ read(s,Limits::default()).unwrap() }
#[test] fn empty_input_and_comments(){ assert_eq!(parse(" ; comment\n ; 日本語"),vec![]); }
#[test] fn integers_strings_keywords(){ assert_eq!(parse("-42 +7 0 :FAILED \"日本語\\n\\\"x\\\\\""),vec![Expr::Int(-42),Expr::Int(7),Expr::Int(0),Expr::Keyword("failed".into()),Expr::Str("日本語\n\"x\\".into())]); }
#[test] fn nil_empty_and_case(){ assert_eq!(parse("NIL nil () (() NiL)"),vec![Expr::Nil,Expr::Nil,Expr::Nil,Expr::List(vec![Expr::Nil,Expr::Nil])]); }
#[test] fn symbols_ascii_fold(){ assert_eq!(parse("FAILS-P Foo-BAR test_1"),vec![Expr::Symbol("fails-p".into()),Expr::Symbol("foo-bar".into()),Expr::Symbol("test_1".into())]); }
#[test] fn comments_and_nested_forms(){ assert_eq!(parse("(and ; skip )\n (< 1 2) :ok)"),vec![Expr::List(vec![Expr::Symbol("and".into()),Expr::List(vec![Expr::Symbol("<".into()),Expr::Int(1),Expr::Int(2)]),Expr::Keyword("ok".into())])]); }
#[test] fn quote_retains_symbol_data(){ assert_eq!(parse("'Failed '(a nil) ''x"),vec![Expr::Quote(Box::new(Expr::Symbol("failed".into()))),Expr::Quote(Box::new(Expr::List(vec![Expr::Symbol("a".into()),Expr::Nil]))),Expr::Quote(Box::new(Expr::Quote(Box::new(Expr::Symbol("x".into())))))]); }
#[test] fn delimiters_fail(){ for text in ["(",")","(a))","'","(a ')"] { let e=read(text,Limits::default()).unwrap_err(); assert_eq!(e.kind,ErrorKind::Syntax,"{text}"); assert!(e.offset.is_some()); } }
#[test] fn strings_fail(){ for text in ["\"","\"abc\\","\"\\q\"","\"a\u{0}b\""] { assert_eq!(read(text,Limits::default()).unwrap_err().kind,ErrorKind::Syntax,"{text}"); } }
#[test] fn reader_macros_and_dotted_lists_rejected(){ for text in ["#.(load \"x\")","#|block|#","(a . b)","`x",",x","|x|","a:b",":","λ","a\\b"] { assert_eq!(read(text,Limits::default()).unwrap_err().kind,ErrorKind::Syntax,"{text}"); } }
#[test] fn overflow_and_malformed_integer(){ for text in ["9223372036854775808","-9223372036854775809","12x","1.2"] { assert_eq!(read(text,Limits::default()).unwrap_err().kind,ErrorKind::Syntax,"{text}"); } assert_eq!(parse("-9223372036854775808"),vec![Expr::Int(i64::MIN)]); }
#[test] fn bytes_bound(){ assert_eq!(read("123",Limits{input_bytes:2,..Limits::default()}).unwrap_err().kind,ErrorKind::ResourceLimit); }
#[test] fn depth_bound(){ assert_eq!(read("((((1))))",Limits{depth:2,..Limits::default()}).unwrap_err().kind,ErrorKind::ResourceLimit); }
#[test] fn node_bound(){ assert_eq!(read("(1 2 3)",Limits{nodes:3,..Limits::default()}).unwrap_err().kind,ErrorKind::ResourceLimit); }
#[test] fn hard_ceiling_even_if_caller_raises_limit(){ let s="(".repeat(1000)+"0"+&")".repeat(1000); assert_eq!(read(&s,Limits{depth:usize::MAX,..Limits::default()}).unwrap_err().kind,ErrorKind::ResourceLimit); }
#[test] fn deterministic_and_pure(){ let s="(and (= 1 1) '(x y))"; for _ in 0..100 { assert_eq!(read(s,Limits::default()),read(s,Limits::default())); } }
