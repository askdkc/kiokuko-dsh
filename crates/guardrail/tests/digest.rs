use kiokuko_guardrail::digest::sha256;
#[test] fn nist_empty(){assert_eq!(sha256(b""),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");}
#[test] fn nist_abc(){assert_eq!(sha256(b"abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");}
#[test] fn nist_multiblock(){assert_eq!(sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");}
#[test] fn nist_million_a(){assert_eq!(sha256(&vec![b'a';1_000_000]),"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");}
#[test] fn changes_affect_identity(){assert_ne!(sha256(b"model=a;temperature=0"),sha256(b"model=b;temperature=0"));}
