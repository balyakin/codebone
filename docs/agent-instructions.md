# Agent instructions for using codebone

When working in this repository, use codebone before broad grep/read exploration.

Recommended order:

1. `codebone_map` for repository overview.
2. `codebone_skeleton` for target files/directories.
3. `codebone_symbols` to find exact functions/classes/types.
4. `codebone_read` for exact symbol bodies.
5. `codebone_context` to assemble a task-focused context pack.
6. `codebone_impact` before editing to understand likely affected files/tests.

Rules:

- Prefer symbol reads over full-file reads.
- Do not request more than the needed budget.
- Treat warnings and truncation flags as important.
- If codebone returns low confidence, fall back to normal file inspection.
