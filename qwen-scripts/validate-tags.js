// File: qwen-scripts/validate-tags.js
// Purpose: Validate canonical tag selections against the controlled tag registry.

import { loadTagRegistry } from './tag-picker.js';

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateTagSelection(selection = {}) {
  const registry = loadTagRegistry();
  const errors = [];
  const warnings = [];
  const tags = Array.isArray(selection.tags) ? selection.tags : [];
  const slugs = Array.isArray(selection.tag_slugs) ? selection.tag_slugs : [];

  if (tags.length < 2) warnings.push('Fewer than 2 canonical tags (target floor is 2)');
  if (tags.length > 4) errors.push('More than 4 canonical tags');
  if (!selection.primary_topic_slug) errors.push('Missing primary topic tag');

  const seen = new Set();
  for (const slug of slugs) {
    const key = normalize(slug);
    if (!key) continue;
    if (seen.has(key)) errors.push(`Duplicate tag slug: ${slug}`);
    seen.add(key);
    if (!registry.bySlug?.[slug]) errors.push(`Unknown tag slug: ${slug}`);
  }

  const labelSeen = new Set();
  for (const tag of tags) {
    const key = normalize(tag);
    if (!key) continue;
    if (labelSeen.has(key)) errors.push(`Duplicate tag label: ${tag}`);
    labelSeen.add(key);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
