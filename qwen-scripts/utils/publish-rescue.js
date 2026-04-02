// File: qwen-scripts/utils/publish-rescue.js
// Purpose: Shared rescue helpers for pre-publish validation (image re-selection and soft tag precheck handling).

import { generateImagePackage } from '../nodes/image-node.js';

const SOFT_TAG_CLAUSE_PATTERNS = [
  /^fewer than \d+ canonical tags$/i,
  /^canonical tag set is missing required non-topic evidence tag$/i,
  /^primary topic tag unsupported by article evidence:/i,
  /^canonical tag unsupported by article evidence:/i,
  /^primary topic_id unsupported by article evidence:/i,
];

function isSoftTagClause(clause = '') {
  const normalized = String(clause || '').trim();
  if (!normalized) return false;
  return SOFT_TAG_CLAUSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isCanonicalTagValidationMessage(message = '') {
  return String(message || '').trim().toLowerCase().startsWith('canonical tags invalid:');
}

function extractCanonicalTagClauses(message = '') {
  const raw = String(message || '');
  const parts = raw.split(':');
  if (parts.length < 2) return [];
  const payload = parts.slice(1).join(':');
  return payload
    .split(';')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function splitPreWriteGraphErrors(errors = []) {
  const blocking = [];
  const rescued = [];
  const warnings = [];

  for (const raw of Array.isArray(errors) ? errors : []) {
    const message = String(raw || '').trim();
    const normalized = message.toLowerCase();
    if (!message) continue;

    if (isCanonicalTagValidationMessage(message)) {
      const clauses = extractCanonicalTagClauses(message);
      if (clauses.length > 0 && clauses.every((clause) => isSoftTagClause(clause))) {
        rescued.push(message);
        warnings.push(`tag_rescue_applied:${clauses.join(' | ')}`);
        continue;
      }
    }

    if (
      normalized.includes('primary topic tag unsupported by article evidence')
      || normalized.includes('canonical tag unsupported by article evidence')
      || normalized.includes('primary topic_id unsupported by article evidence')
    ) {
      rescued.push(message);
      warnings.push(`tag_rescue_applied:${message}`);
      continue;
    }

    blocking.push(message);
  }

  return {
    blocking,
    rescued,
    warnings: Array.from(new Set(warnings)),
  };
}

export function hasImageTopicMismatchError(errors = []) {
  return (Array.isArray(errors) ? errors : []).some((message) =>
    String(message || '').toLowerCase().includes('image query reinforces unsupported topic context')
  );
}

function buildTopiclessRescueSelection(candidate = {}) {
  const draftClassification = candidate?.draft?.metadata?.classification || {};
  return {
    ...candidate,
    draft: {
      ...(candidate?.draft || {}),
      topic_id: null,
      topic: null,
      metadata: {
        ...(candidate?.draft?.metadata || {}),
        classification: {
          ...draftClassification,
          topic_id: null,
          topic: null,
        },
      },
    },
    brief: {
      ...(candidate?.brief || {}),
      topic_id: null,
      subsection: null,
      topics: [],
    },
    placement: {
      ...(candidate?.placement || {}),
      topic_id: null,
      topic_label: null,
      subsection: null,
    },
  };
}

function resolveRescueSlug(candidate = {}) {
  const base = String(
    candidate?.publishIdentity?.slug
    || candidate?.articleSlug
    || candidate?.publishResult?.canonicalSlug
    || candidate?.publishResult?.slug
    || ''
  ).trim();
  return base || 'rescue-image';
}

export async function attemptImageRescuePass({
  candidate = {},
  providerApiKeys = {},
  validateGraph = null,
  logPrefix = 'pipeline',
} = {}) {
  const attempts = [
    { label: 'strict', disablePixabay: true },
    { label: 'relaxed', disablePixabay: false },
  ];
  const diagnostics = [];
  let applied = false;
  let finalValidation = null;

  for (const attempt of attempts) {
    const rescueSelection = buildTopiclessRescueSelection(candidate);
    const rescueProviderKeys = {
      ...(providerApiKeys || {}),
      pixabayApiKey: attempt.disablePixabay ? null : providerApiKeys?.pixabayApiKey,
    };
    const rescueSlug = resolveRescueSlug(candidate);

    try {
      const priorProvider = candidate?.image?.provider || null;
      const priorQuery = candidate?.image?.metadata?.queryUsed || null;
      const image = await generateImagePackage(rescueSelection, rescueSlug, rescueProviderKeys);
      applied = true;
      candidate.image = {
        ...image,
        metadata: {
          ...(image?.metadata || {}),
          rescue_applied: true,
          rescue_label: attempt.label,
          rescue_scope: attempt.disablePixabay ? 'pexels_unsplash' : 'pexels_unsplash_pixabay',
          previous_provider: priorProvider,
          previous_query_used: priorQuery,
        },
      };

      let validation = null;
      if (typeof validateGraph === 'function') {
        validation = validateGraph(candidate);
        finalValidation = validation;
      }

      diagnostics.push({
        attempt: attempt.label,
        provider: candidate?.image?.provider || null,
        query_used: candidate?.image?.metadata?.queryUsed || null,
        valid_after_attempt: validation ? Boolean(validation.valid) : null,
        image_topic_mismatch_after_attempt: validation ? hasImageTopicMismatchError(validation.errors || []) : null,
      });

      console.log(
        `[${logPrefix}] Image rescue attempt=${attempt.label} provider=${candidate?.image?.provider || 'unknown'} query="${candidate?.image?.metadata?.queryUsed || ''}"`
      );

      if (!validation || validation.valid || !hasImageTopicMismatchError(validation.errors || [])) {
        return {
          applied,
          diagnostics,
          validation: finalValidation,
          resolved: validation ? validation.valid : true,
        };
      }
    } catch (error) {
      diagnostics.push({
        attempt: attempt.label,
        provider: null,
        query_used: null,
        error: error.message,
      });
      console.log(`[${logPrefix}] Image rescue attempt=${attempt.label} failed: ${error.message}`);
    }
  }

  return {
    applied,
    diagnostics,
    validation: finalValidation,
    resolved: finalValidation ? finalValidation.valid : false,
  };
}
