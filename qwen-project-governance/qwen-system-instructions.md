<!-- File: qwen-project-governance/qwen-system-instructions.md | Purpose: master operating guide for the qwen-built editorial system inside foseer.com -->

# Qwen System Instructions

## 1) Scope

You are building a **separate agent-made system** inside the existing `foseer.com` project.

All new work for this system must live inside **new `qwen-*` folders** so the result is clearly separated from the legacy project structure.

Examples:
- `qwen-project-governance/`
- `qwen-scripts/`
- `qwen-src/`
- `qwen-data/`
- `qwen-cache/`

Do **not** rename or overwrite legacy folders just to match the new structure.

## 2) Relationship to the Existing Project

The existing project may be used as **reference only**.

You may inspect existing:
- scripts
- docs
- governance files
- provider routing
- pipeline logic
- article data
- local site verification logic
- image/media logic

You are **not required** to reuse any legacy implementation.

You may reuse ideas, patterns, or selected pieces only when they are clearly useful and save time without creating confusion.

The new qwen-built system must remain understandable as its own implementation.

## 3) Product Goal

This site is a **modern news + analysis editorial product**.

It is not a content farm and not a debug-heavy internal tool exposed to users.

The system should:
1. find fresh, interesting, publishable topics;
2. verify source sufficiency early;
3. turn one selected event into a clean editorial article;
4. attach relevant imagery when the media path supports it;
5. publish only user-facing output that is clean and readable;
6. verify that the article is actually visible on the local site.

## 4) Mandatory Operating Files

These files are mandatory and must be maintained throughout the project:

- `qwen-project-governance/qwen-system-instructions.md`
- `qwen-project-governance/how-to-use.md`
- `qwen-project-governance/qwen-current-context.md`
- `qwen-project-governance/qwen-task-queue.md`
- `qwen-project-governance/qwen-operations-log.md`
- `qwen-project-governance/qwen-definition-of-done.md`

## 5) Required Read Order at the Start of Every New Session

Before planning or coding, read these files in this exact order:

1. `qwen-project-governance/qwen-system-instructions.md`
2. `qwen-project-governance/qwen-current-context.md`
3. `qwen-project-governance/qwen-task-queue.md`
4. `qwen-project-governance/qwen-operations-log.md`
5. `qwen-project-governance/qwen-definition-of-done.md`
6. `qwen-project-governance/how-to-use.md`

Do not start a new round of work until these files have been reviewed.

## 6) Required Update Rules

After **every meaningful stage**, update at minimum:

- `qwen-current-context.md`
- `qwen-task-queue.md`
- `qwen-operations-log.md`

When completion criteria change or are clarified, update:
- `qwen-definition-of-done.md`

Never leave the project state only in transient chat output.

## 7) Core Pipeline Contract

The system should support this end-to-end editorial flow:

1. **Signal discovery**
   - find fresh signals, breaking-news candidates, or clearly newsworthy developments;
   - reject noise, duplicate topics, stale items, or low-value candidates.

2. **Event brief normalization**
   - convert raw discovery into a structured event brief;
   - clarify what happened, who is involved, when it happened, and why it matters.

3. **Topic selection**
   - choose one best publishable topic;
   - prefer freshness, user value, and evidence readiness over cheap volume.

4. **Source pack assembly**
   - gather enough source support early;
   - apply publishability checks before drafting;
   - stop weak topics before expensive generation.

5. **Claim map creation**
   - every meaningful factual statement must be tied to evidence;
   - no unsupported factual drift.

6. **Drafting**
   - produce a clear editorial article for normal readers;
   - structure should cover:
     - what happened
     - why it matters
     - relevant context
     - what could happen next / implications

7. **Hardening**
   - remove unsupported claims;
   - remove internal debug or workflow artifacts;
   - keep output publication-ready.

8. **Media support**
   - include a relevant image when the media path exists and is valid;
   - add alt text;
   - do not attach random filler media.

9. **Local visibility verification**
   - success means the article is visible on localhost;
   - article URL must work;
   - article should be visible on homepage or article listing where applicable.

## 8) API / Provider Rules

Use the project's available providers intelligently.

### OpenAI API
Use for:
- event brief shaping
- claim map creation
- drafting
- rewriting
- review and quality hardening

### Brave Search API
Use for:
- fresh discovery
- headline clustering
- urgency scoring

### GDELT API
Use for:
- event signal detection
- trend assistance
- discovery support

### Google Search / Custom Search API
Use for:
- source expansion
- independent-domain checking
- publishability verification

### Supabase
Use for:
- structured editorial data or storage paths when they are actually needed

### Google Search Console API
Use for:
- post-publish analysis
- indexing/performance feedback loops

### YouTube Data API v3
Use only when it materially improves:
- context
- media enrichment
- audience-interest support

### Pexels API
Use for:
- relevant article imagery
- cover/hero image support

## 9) Mandatory Cache Rule

From the **very first pass**, apply a **8-hour cache TTL** to:

- Brave Search
- GDELT
- Google Search / Custom Search

This is mandatory.

Purpose:
- reduce repeated requests
- control token / API spend
- avoid request spam
- avoid rate limits or bans
- keep iteration safe

Do not leave this as a later optimization.

## 10) Stage-by-Stage Execution Rule

Work in stages.

For each stage:
1. define the stage goal;
2. make the smallest necessary change;
3. run validation;
4. record pass/fail;
5. if fail: diagnose, fix, validate again;
6. move forward only after a pass or after clearly logging a blocker and a justified next-best step.

## 11) Validation Requirements

Every stage must have an explicit validation step.

Each validation entry should answer:
- what was tested
- how it was tested
- what passed
- what failed
- what the next action is

Avoid vague status notes like "seems okay".

## 12) Bounded Retry Policy

Do not loop forever.

Default retry policy for a stage blocker:
- attempt 1: fix the obvious issue
- attempt 2: refine the approach based on evidence
- attempt 3: choose the next best bounded alternative or log the blocker explicitly

After repeated failure:
- record the blocker in `qwen-operations-log.md`
- update `qwen-task-queue.md`
- adjust the plan instead of silently repeating the same attempt

## 13) Change Control

Do not keep changing architecture casually mid-run.

Before a structural change, record:
- what is wrong with the current approach
- why the change is needed
- which files are affected
- how success will be validated

## 14) Local Success Standard

The work is **not complete** because files were written.

The work is complete only when the system reaches the criteria in:
- `qwen-project-governance/qwen-definition-of-done.md`

## 15) Reader-Facing Cleanliness Rules

Never expose these to public readers:
- debug notes
- run IDs
- service metadata
- internal manifests
- preview-only warnings
- research-pack blocks
- raw evidence dumps
- internal operational comments

The public site should look editorial and clean.

## 16) General Working Style

Prefer:
- minimum necessary changes
- explicit checkpoints
- evidence-based decisions
- readable structure
- clear logs
- stable progress over churn

Do not claim completion early.
