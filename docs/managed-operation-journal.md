# Managed operation journal coverage

This is a host audit, not a sandbox or an OS-wide side-effect tracer.

## Boundaries

- LispManager wraps each worker request in a collection scope, including zero-operation evaluations. The bridge journals development-mode `run`/`start-job`, effectful `tool-call`, and `ci-verify` admission before existing authority checks and dispatch. Pure calculations and reads do not invent an external operation.
- OwnedExecutionService journals direct `kioku_exec`, `kioku_write`, `kioku_edit`, and `kioku_remove` calls. Existing task/plan/approval/protocol checks remain responsible for authorization. Existing owned receipts remain the original effect records.
- Protected LispWorker's supervised process launches use an audit callback installed by LispManager. Existing beforeJob authorization remains mandatory. Worker jobs enter the cancellation registry immediately after launch, including when subsequent journal persistence fails.
- For an owned call nested inside Lisp, the bridge attempt and the owned original have explicit reference linkage: the child scope's parentId is the bridge operationId; only the child carries originalRef. These are not two subprocesses. Count canonical owned effects by unique originalRef, not by counting all journal rows. Child observations update the parent reference independently of Lisp's final value.
- Each owned child collection seals before bounded protocol receipt issuance. The enclosing Lisp evaluation scope stays open until its worker request ends. Protocol binding uses actual captured task leases and separate worker, protocol and lease generations.

## Out of scope

Direct DSH-native tools not passing these plugin adapters, arbitrary SBCL file I/O/FFI, and external actions hidden inside unrelated tools are not intercepted. The journal does not prove sandbox isolation or semantic consumption of Lisp values. `delivery` concerns the host adapter return only, not model understanding or a transport-level acknowledgement from SBCL.

## Failure behavior

Journal preparation and dispatch claim must persist before the effect callback is invoked. An uncertain result does not trigger retry. Native unknown results block further managed effects for that session until host reconciliation; ordinary reads and pure Lisp evaluation remain available. An explicit denial before dispatch is distinct from an unknown outcome. Timeout alone does not prove process termination. Owned original IDs retain existing durable replay protection; replay does not issue another external operation.

Snapshots are immutable projections. A late owned result reconciles its linked original and parent reference; it does not rewrite a prior snapshot. Existing protocol evidence requires its own structured Node test observation in addition to the journal, never just exit zero.
