# Duewatch — Zero-Cost Execution Policy v1.0 LOCKED

**Status:** LOCKED PROJECT CONSTRAINT

For the current Duewatch / DW Intelligence development program, automated work must not create, enable, or rely on any resource that can generate monetary charges or surprise metered usage.

## Default rule

> **If an execution step can create a bill, usage charge, paid resource, metered API call, or uncontrolled cloud consumption, do not execute it.**

This includes, unless explicitly changed by the founder in a later instruction:

- paid or metered LLM/API calls;
- Supabase paid branches/projects or paid add-ons;
- Vercel actions that can create metered/usage charges;
- production traffic/load tests;
- provider email sends used merely as development proof;
- recurring cloud jobs or polling that can accumulate cost;
- third-party services requiring billing activation;
- “small” paid experiments, even if the estimated amount is cents;
- any action whose billing behavior is unclear.

## Allowed development posture

Prefer:

- local Node execution;
- deterministic fixtures;
- sandbox/stub transports;
- static analysis;
- local files;
- zero-cost GitHub read operations;
- offline test harnesses;
- proof artifacts;
- existing non-metered resources only when their cost behavior is known and no new usage risk is introduced.

## Escalation rule

If a required next step cannot be completed without a possibly billable resource, stop at the boundary and record the blocker. Do not “try it once,” create a temporary paid branch, or assume the amount is negligible.

This policy is separate from DW Intelligence authority doctrine. It governs the development program's infrastructure spending behavior.
