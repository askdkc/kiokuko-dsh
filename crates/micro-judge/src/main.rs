//! Bounded finite-domain propagation and MRV search. No I/O callbacks or authority.
mod digest;
use std::io::{self, BufRead, Read, Write};
use std::time::Instant;
const VERSION: &str = "kiokuko-fd-v1";
#[derive(Clone, Copy, PartialEq)] enum Kind { Bool, Int }
#[derive(Clone)] enum Expr { Var(usize), Const(i64), Op(String, Vec<Expr>) }
#[derive(Clone)] struct Constraint { expr: Expr, vars: Vec<usize> }
struct Model { domains: Vec<Vec<i64>>, constraints: Vec<Constraint>, query: Expr, limit: u64 }
#[derive(Default)] struct Answer { solutions: u64, truth: u64, nodes: u64, work: u64, exhausted: bool }
impl Answer {
    fn tick(&mut self, limit: u64) -> bool { self.work += 1; if self.work > limit { self.exhausted=true; false } else { true } }
}
fn token<'a>(ts: &mut std::str::SplitWhitespace<'a>) -> Result<&'a str, &'static str> { ts.next().ok_or("truncated") }
fn number(ts: &mut std::str::SplitWhitespace<'_>, max: usize) -> Result<usize, &'static str> {
    let n=token(ts)?.parse::<usize>().map_err(|_|"integer")?; if n>max { Err("bound") } else { Ok(n) }
}
fn expression(ts: &mut std::str::SplitWhitespace<'_>, kinds: &[Kind], depth: usize, nodes: &mut usize) -> Result<(Expr,Kind), &'static str> {
    *nodes+=1; if depth>32 || *nodes>2048 { return Err("expression_bound") }
    let t=token(ts)?;
    if let Some(s)=t.strip_prefix('@') { let i=s.parse::<usize>().map_err(|_|"variable")?; return Ok((Expr::Var(i),*kinds.get(i).ok_or("variable_bound")?)) }
    if t=="true" || t=="false" { return Ok((Expr::Const((t=="true") as i64),Kind::Bool)) }
    if let Ok(n)=t.parse::<i64>() { return if (-1_000_000_000..=1_000_000_000).contains(&n) { Ok((Expr::Const(n),Kind::Int)) } else { Err("value_bound") } }
    let arity=match t { "eq"|"ne"|"lt"|"and"|"or"|"implies"=>2,"diag"=>3,_=>return Err("operator") };
    let mut xs=Vec::new(); let mut ks=Vec::new();
    for _ in 0..arity { let (x,k)=expression(ts,kinds,depth+1,nodes)?; xs.push(x); ks.push(k); }
    let valid=match t { "eq"|"ne"=>ks[0]==ks[1],"lt"|"diag"=>ks.iter().all(|k|*k==Kind::Int),_=>ks.iter().all(|k|*k==Kind::Bool) };
    if !valid { return Err("type") } Ok((Expr::Op(t.into(),xs),Kind::Bool))
}
fn eval(e: &Expr, values: &[i64]) -> i64 { match e {
    Expr::Var(i)=>values[*i], Expr::Const(v)=>*v, Expr::Op(op,x)=> {
        let a=eval(&x[0],values); let b=eval(&x[1],values);
        match op.as_str() { "eq"=>(a==b) as i64,"ne"=>(a!=b) as i64,"lt"=>(a<b) as i64,
            "and"=>(a==1 && b==1) as i64,"or"=>(a==1 || b==1) as i64,"implies"=>(a==0 || b==1) as i64,
            "diag"=>((a-b).abs()!=eval(&x[2],values)) as i64,_=>unreachable!() }
    }
} }
fn variables(e: &Expr, vs: &mut Vec<usize>) { match e { Expr::Var(i)=>{if !vs.contains(i){vs.push(*i)}},Expr::Op(_,xs)=>for x in xs{variables(x,vs)},_=>() } }
fn parse(payload: &str) -> Result<Model,&'static str> {
    let mut ts=payload.split_whitespace(); let limit=number(&mut ts,2_000_000)? as u64;
    if limit==0 { return Err("budget") } let n=number(&mut ts,128)?;let nc=number(&mut ts,256)?;
    let mut kinds=Vec::new();let mut domains=Vec::new();
    for _ in 0..n { let kind=match token(&mut ts)? {"b"=>Kind::Bool,"i"=>Kind::Int,_=>return Err("kind")};let len=number(&mut ts,32)?;
        if len==0{return Err("empty_domain")} let mut ds=Vec::new();
        for _ in 0..len { let v=token(&mut ts)?.parse::<i64>().map_err(|_|"integer")?;
            if !(-1_000_000_000..=1_000_000_000).contains(&v) || kind==Kind::Bool && v!=0 && v!=1 {return Err("value_bound")} ds.push(v); }
        ds.sort();ds.dedup();kinds.push(kind);domains.push(ds);
    }
    let mut nodes=0;let mut constraints=Vec::new();
    for _ in 0..nc { let (expr,kind)=expression(&mut ts,&kinds,0,&mut nodes)?; if kind!=Kind::Bool{return Err("constraint_type")}
        let mut vars=Vec::new();variables(&expr,&mut vars);if vars.len()>3{return Err("constraint_arity")}constraints.push(Constraint{expr,vars}); }
    let (query,kind)=expression(&mut ts,&kinds,0,&mut nodes)?;if kind!=Kind::Bool || ts.next().is_some(){return Err("query")}
    Ok(Model{domains,constraints,query,limit})
}
fn supported(c: &Constraint, ds: &[Vec<i64>], at: usize, values: &mut [i64], answer: &mut Answer, limit: u64) -> bool {
    if !answer.tick(limit){return false} if at==c.vars.len(){return eval(&c.expr,values)==1}
    let i=c.vars[at];for v in &ds[i] {values[i]=*v;if supported(c,ds,at+1,values,answer,limit){return true}if answer.exhausted{return false}}false
}
fn propagate(m: &Model, ds: &mut Vec<Vec<i64>>, a: &mut Answer) -> bool {
    loop {let mut changed=false;
        for c in &m.constraints { if c.vars.is_empty(){if !a.tick(m.limit) || eval(&c.expr,&[])!=1{return false}continue}
            for i in &c.vars {let old=ds[*i].clone();let mut kept=Vec::new();
                for v in &old {ds[*i]=vec![*v];if supported(c,ds,0,&mut vec![0;ds.len()],a,m.limit){kept.push(*v)}if a.exhausted{return false}}
                changed|=kept!=old;ds[*i]=kept;if ds[*i].is_empty(){return false}
            }
        }
        if !changed{return true}
    }
}
fn search(m: &Model, mut ds: Vec<Vec<i64>>, a: &mut Answer) {
    a.nodes+=1;if !a.tick(m.limit){return}if !propagate(m,&mut ds,a){return}
    if let Some((i,_))=ds.iter().enumerate().filter(|(_,d)|d.len()>1).min_by_key(|(_,d)|d.len()) {
        for v in ds[i].clone(){let mut next=ds.clone();next[i]=vec![v];search(m,next,a);if a.exhausted{return}}
    }else{a.solutions+=1;a.truth+=(eval(&m.query,&ds.iter().map(|d|d[0]).collect::<Vec<_>>())==1) as u64;
        if a.solutions>=100_000{a.exhausted=true}}
}
fn hex(s: &str) -> bool {s.len()==64 && s.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b))}
fn run(line: &str) -> Result<String,&'static str> {
    let mut fields=line.trim_end_matches(['\r','\n']).splitn(4,'\t');
    if fields.next()!=Some(VERSION){return Err("version")}
    let id=fields.next().ok_or("id")?;let hash=fields.next().ok_or("digest")?;let payload=fields.next().ok_or("payload")?;
    if !hex(id) || !hex(hash) || digest::sha256(payload.as_bytes())!=hash{return Err("identity")}
    let m=parse(payload)?;let started=Instant::now();let mut a=Answer::default();search(&m,m.domains.clone(),&mut a);
    let status=if a.exhausted{"resource_limit"}else if a.solutions==0{"inconsistent"}else if a.truth==0{"refuted"}else if a.truth==a.solutions{"entailed"}else{"undetermined"};
    Ok(format!("{{\"version\":\"{VERSION}\",\"inputId\":\"{id}\",\"inputDigest\":\"{hash}\",\"complete\":{},\"status\":\"{status}\",\"solutions\":{},\"truth\":{},\"nodes\":{},\"work\":{},\"elapsedMicros\":{},\"peakRssBytes\":null}}",!a.exhausted,a.solutions,a.truth,a.nodes,a.work,started.elapsed().as_micros()))
}
fn main(){
    if std::env::args().len()>1 {
        if std::env::args().nth(1).as_deref()==Some("--version") && std::env::args().len()==2 { println!("kiokuko-micro-judge 0.1.0 {VERSION}");return }
        eprintln!("unsupported argument");std::process::exit(2);
    }
    let stdin=io::stdin();let mut input=stdin.lock();let mut out=io::stdout().lock();let mut bytes=Vec::new();
    loop {bytes.clear();match input.by_ref().take(131073).read_until(b'\n',&mut bytes){Ok(0)=>break,Ok(_)=>(),Err(_)=>break}
        if bytes.len()>131072{let _=writeln!(out,"{{\"error\":\"input_bound\"}}");break}
        let result=std::str::from_utf8(&bytes).map_err(|_|"utf8").and_then(run);
        match result{Ok(json)=>{let _=writeln!(out,"{json}");},Err(code)=>{let _=writeln!(out,"{{\"error\":\"{code}\"}}");}}let _=out.flush();
    }
}
