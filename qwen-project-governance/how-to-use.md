<!-- File: qwen-project-governance/how-to-use.md | Purpose: operating checklist for the human operator and the agent -->

# How to Use This Qwen Project Pack

## Human Operator Flow

### A) For Plan Mode
Give the agent the path to these files and tell it to read them first:

1. `qwen-project-governance/qwen-system-instructions.md`
2. `qwen-project-governance/qwen-current-context.md`
3. `qwen-project-governance/qwen-task-queue.md`
4. `qwen-project-governance/qwen-operations-log.md`
5. `qwen-project-governance/qwen-definition-of-done.md`
6. `qwen-project-governance/how-to-use.md`

Expected result from Plan mode:
- a step-by-step plan
- stage checkpoints
- validation steps
- first build targets inside `qwen-*` folders
- identified blockers or uncertainty areas
- no code execution yet

### B) For Act Mode
After the plan looks correct, run Act mode.

Expected behavior in Act mode:
- work only inside new `qwen-*` folders for the new system unless a narrowly justified change to legacy code is truly required;
- use legacy project materials only as reference when helpful;
- update the qwen governance files after each meaningful stage;
- validate every stage;
- on failure, fix and re-validate instead of drifting forward;
- continue until the full pipeline reaches the definition of done.

## Agent File Duties

The agent must keep these files current:

### `qwen-current-context.md`
Use it for:
- current project state
- what exists already
- what was decided
- current bottleneck
- immediate next step

### `qwen-task-queue.md`
Use it for:
- staged tasks
- status per stage
- next tasks
- blockers
- deferred items

### `qwen-operations-log.md`
Use it for:
- dated execution notes
- what was changed
- what was tested
- what passed/failed
- what was learned

### `qwen-definition-of-done.md`
Use it for:
- final completion gates
- end-to-end success criteria
- release-readiness checks

## Important Do / Do Not

### Do
- keep the new work separated in `qwen-*`
- validate every stage
- write down blockers
- return to failed stages and fix them
- use 8-hour cache for Brave, GDELT, and Google from the beginning

### Do Not
- rename old project folders
- treat file creation as project completion
- leave important decisions only in chat
- expose internal/debug content in public article output
- keep retrying the same failed step without logging what changed

## Minimum Reading Rule for Any New Session

At minimum, read:
- `qwen-system-instructions.md`
- `qwen-current-context.md`
- `qwen-task-queue.md`
- `qwen-operations-log.md`
- `qwen-definition-of-done.md`

Then continue work.
