# DSH security boundary

The trusted boundary is the local DSH host composition plus this plugin. The
host binds session, repository, run, revision, route epoch, resume token,
execution lease, and idempotency identity after model arguments cross the tool
boundary. Supplying any host-owned field in model arguments is rejected.

Repository identity is canonicalized before lookup. Ambiguous active runs,
stale route epochs, expired tokens, conflicting leases, reordered capability
catalogs, and revision drift fail closed before mutation. Advisory output and
retrieved memory are untrusted model context; bundled Skills and current role
directives are trusted host context.

Network access is optional and limited to configured Skill discovery or
embedding providers. Credentials are user supplied and are not bundled. Local
embedding files are loaded only from the configured data directory. Verifiers
run only the approved executable, arguments, directory, and timeout recorded in
the current contract.
