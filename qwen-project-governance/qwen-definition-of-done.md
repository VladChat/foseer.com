<!-- File: qwen-project-governance/qwen-definition-of-done.md | Purpose: hard completion gates for the qwen-built editorial system -->

# Qwen Definition of Done

The project is complete only when **all** required gates below are satisfied.

## A) Structure Gate
- Separate `qwen-*` folders exist for the new system
- New qwen work is clearly distinguishable from legacy project content
- Required governance files are present and updated

## B) Planning / Memory Gate
- `qwen-current-context.md` reflects the latest real state
- `qwen-task-queue.md` reflects actual stage status
- `qwen-operations-log.md` contains stage-by-stage execution notes
- no critical project knowledge is left only in chat

## C) Cache Gate
- Brave requests go through a 8-hour cache
- GDELT requests go through a 8-hour cache
- Google requests go through a 8-hour cache
- repeated request behavior is bounded and observable

## D) Discovery Gate
- the system can find topic candidates or signals
- noisy / stale / low-value candidates are rejected
- a usable event brief can be produced

## E) Publishability Gate
- at least one topic can pass source sufficiency checks
- weak evidence prevents drafting
- source pack is inspectable

## F) Drafting Gate
- at least one article draft is generated
- article structure is editorial, readable, and user-facing
- meaningful factual claims are tied to evidence or appropriately narrowed

## G) Clean Output Gate
- no debug/service metadata is exposed in public-facing article output
- no preview-only artifacts are presented as published user content
- article presentation looks like normal editorial content

## H) Image Gate
- article supports a relevant image when valid media path exists
- alt text is present
- image output is not random filler

## I) Local Visibility Gate
- localhost is reachable
- article URL is reachable
- article is visible on the local site, not only written to a file
- listing or homepage visibility is confirmed where applicable

## J) End-to-End Gate
- one topic can move through the full intended path:
  - discovery
  - event brief
  - selection
  - source pack
  - claim map
  - draft
  - hardening
  - image support
  - local visibility verification
- final pass is recorded in `qwen-operations-log.md`

## K) Failure Discipline Gate
- failed stages were logged
- retries were bounded
- blockers were recorded instead of silently ignored

If any gate above is not satisfied, the project is **not done**.
