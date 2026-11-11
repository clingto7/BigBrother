# Example review

Request: "Review the change from `main` to `feature/import`."

Assume the diff changes `src/import.py` and `tests/test_import.py`. The new importer opens the output file in write mode before checking whether parsing succeeded; the test covers valid input only. The repository's `CONTRIBUTING.md` says imports must leave existing data intact when input is invalid.

Example response:

## Findings

### [High] Validate before replacing the destination — src/import.py:42

Type: Defect

Evidence: `import_file` opens the existing destination with write mode at line 42, then parses the input at line 47. Invalid input raises after the destination has been truncated. The invalid-input case is absent from `tests/test_import.py`. This also conflicts with `CONTRIBUTING.md`'s import-preservation rule.

Impact: Importing a malformed file destroys the previous output.

Suggested fix: Parse and validate before replacing the destination, then atomically replace it only after success; add a regression case with an existing destination.

## Coverage and limits

Reviewed range: merge base of `main` and `feature/import` through `feature/import`.

Inspected both changed files and the caller of `import_file`. No test was run; the conclusion follows from the order of file opening and parsing. Other import formats were not assessed.

## Clean-change example

For the same range with parsing completed before an atomic replacement and a passing invalid-input regression test:

"No supported findings. Reviewed both changed files, their caller, and the applicable import rule. Ran the focused import tests successfully. Other import formats were not assessed."

## Missing-context example

When the repository has no documented import rule, do not invent one. Report the data-loss defect from code evidence and state: "No repository-specific import policy was found; requirement compliance could not be assessed."
