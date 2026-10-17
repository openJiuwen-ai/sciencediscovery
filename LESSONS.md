# Validated development lessons

This is a durable learning record, not a collection of agent guesses or an
alternative contribution policy. No historical lesson is asserted by this
initial scaffold. Existing CI invariants remain in [CONTRIBUTING](CONTRIBUTING.md)
and [the CI contract](.ci/README.md).

## Admission criteria

Add an entry only after a reviewer adjudicates a reproducible defect, regression
or successful repair. Include public source evidence and a regression test.
A CI badge alone, model-generated conclusion or unresolved review comment is
not an adjudicated lesson. Record infrastructure causes separately from code.

## Entry template

- ID and date:
- Affected subsystem and invariant:
- Failure scenario and exact source revision:
- Linked issue/PR, reproduction and reviewer decision:
- Root cause, distinguishing verified facts from remaining uncertainty:
- Repair and regression test command/result:
- Prevention rule and owning architecture/test document:
- Applicability, exceptions and superseding entry:

Do not paste logs containing secrets, personal data or private source material.
Do not silently turn a lesson into a new permission or merge gate. Update the
owning document through normal review if a policy change is actually needed.
