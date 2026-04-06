// File: qwen-scripts/utils/pipeline-mode.js
// Purpose: Normalize pipeline run mode flags for strict vs relaxed editorial gating.

export function resolvePipelineMode(options = {}) {
  const explicitMode = String(options?.pipelineMode || process.env.QWEN_PIPELINE_MODE || '').trim().toLowerCase();
  if (explicitMode === 'strict') return 'strict';
  if (explicitMode === 'relaxed') return 'relaxed';
  return 'relaxed';
}

export function isRelaxedPipelineMode(options = {}) {
  return resolvePipelineMode(options) === 'relaxed';
}

export function isStrictPipelineMode(options = {}) {
  return resolvePipelineMode(options) === 'strict';
}
