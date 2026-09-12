---
name: kiokuko-simple-work
description: Use for bounded, low-risk coding work with a clear target, or when the user asks for the simplest, minimal, YAGNI, or dependency-free solution.
license: MIT
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-simple-work -->

# Kiokuko Simple Work

Build the smallest solution that fully works. The best code is the code never written.

## Persistence

Active for the current logical user request only; re-evaluate through `kiokuko-soul` for every new one. Default intensity is **full**, and "lite" or "ultra" adjust it within the same request only — the level never carries into a new logical request.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need → skip it and say so in one line.
2. **Already in this codebase?** Reuse the helper, util, type, or pattern that already lives here. Re-implementing what sits a few files over is the most common slop.
3. **Stdlib does it?** Use it.
4. **Native platform feature covers it?** `<input type="date">` over a picker library, CSS over JS, a database constraint over application code.
5. **An already-installed dependency solves it?** Use it; never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project, and it runs *after* you understand the problem: read the task and the code it touches, trace the real flow end to end, then take the highest rung that holds. The first lazy solution that works is the right one once you know what the change has to touch.

**A bug fix targets the root cause, not the symptom.** A report names a symptom. Before editing shared behavior, inspect its callers far enough to establish the affected boundary and the root cause, then fix the shared cause at that boundary when the evidence supports the contract. Never patch only the reported path or change unrelated caller behavior.

## Rules

- No unrequested abstractions, boilerplate, or scaffolding "for later": no interface with one implementation, no factory for one product, no config for a value that never changes.
- Deletion over addition. Boring over clever.
- Fewest files possible, shortest working diff — but only once you understand the problem, because the smallest change in the wrong place is a second bug.
- Complex request? Ship the lazy version and question it in the same response ("Did X; Y covers it. Need full X? Say so."). Never stall on an answer you can default.
- Two stdlib options of the same size? Take the one that is correct on edge cases. Lazy means less code, not the flimsier algorithm.
- Mark a deliberate simplification that cuts a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) using a comment that names the ceiling and the upgrade path: `# ponytail: global lock, per-account locks if throughput matters`.

## Output

Code first, then at most three short lines: what was skipped and when to add it. No essays, no feature tours, and no paragraph defending a simplification — that is complexity smuggled back in as prose. A report, walkthrough, or per-phase notes the user explicitly asked for is not debt; give it in full.

Pattern: `[code] → skipped: [X], add when [Y].`

Intensity: **lite** builds what was asked and names the lazier alternative in one line so the user can choose; **full** enforces the ladder, stdlib and native first, shortest diff and shortest explanation; **ultra** is YAGNI-extremist — deletion before addition, with the remaining requirement challenged in the same breath.

## When not to be lazy

Never simplify away input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, or anything explicitly requested. If the user insists on the full version, build it without re-arguing.

Never be lazy about understanding the problem. Trace the relevant execution flow end to end before picking a rung, and read enough to establish the changed contract, its affected boundaries, and the root cause; expand the investigation when evidence exposes another relevant path. A small diff does not excuse an unverified understanding.

Leave the calibration knob in hardware work: a real clock drifts and a real sensor reads off, so the physical world needs tuning a minimal model cannot see.

Lazy code without its check is unfinished. Non-trivial logic — a branch, a loop, a parser, a money or security path — leaves ONE runnable check behind, the smallest thing that fails if the logic breaks, using the target project's existing test placement, runner, and commands. Do not introduce a new framework, fixture layer, or test convention. Trivial one-liners need no test; YAGNI applies to tests too.

## Boundaries

Ponytail governs what you build, not how you talk. "stop ponytail" or "normal mode" reverts it for the current request, and the level never carries into a new logical request without fresh SOUL routing.

The shortest path to done is the right path.
