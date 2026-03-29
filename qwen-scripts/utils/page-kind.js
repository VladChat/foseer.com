// File: qwen-scripts/utils/page-kind.js
// Purpose: Detect the likely editorial page kind for a discovered URL/title without prematurely rejecting it.

const PAGE_KIND_RULES = [
  { kind: 'homepage', test: ({ path }) => !path || path === '/' },
  { kind: 'video', test: ({ path, text }) => /\/(video|videos)\//.test(path) || /\b(video:|watch video|video)\b/.test(text) },
  { kind: 'audio', test: ({ path, text }) => /\/(audio|podcasts?)\//.test(path) || /\b(podcast|audio)\b/.test(text) },
  { kind: 'live', test: ({ path, text }) => /\/(live|live-updates?)\b/.test(path) || /\b(live updates?|watch live|latest updates?)\b/.test(text) },
  { kind: 'section', test: ({ path }) => /\/(news|world|business|tech|technology|health|sports|culture)\/?$/.test(path) },
  { kind: 'topic', test: ({ path, text }) => /\/(topic|topics|tag|tags|section)\//.test(path) || /(suggested search|browse all|see all results)/.test(text) },
  { kind: 'official_release', test: ({ domain, path, text }) => (/\.(gov|mil)$/.test(domain) || /(press release|statement|filing|order|complaint|transcript|official)/.test(text) || /\/(press|press-release|releases|statement|media|orders?|filings?)\//.test(path)) && !/(suggested search|browse all|see all results)/.test(text) },
  { kind: 'roundup', test: ({ text, path }) => /\b(roundup|recap|headlines|newsletter|morning brief|news at a glance|weekly briefing)\b/.test(text) || /\/(roundup|newsletter|briefing)\//.test(path) },
  { kind: 'analysis', test: ({ text, path }) => /\b(analysis|opinion|explainer)\b/.test(text) || /\/(analysis|opinion|explainer)\//.test(path) },
  { kind: 'article', test: ({ path }) => /\/\d{4}\/\d{2}\/\d{2}\//.test(path) || /\/[a-z0-9-]{20,}/.test(path) },
];

export function detectPageKind({ url = '', title = '', snippet = '' } = {}) {
  const lowerUrl = String(url || '').trim().toLowerCase();
  const domain = getCanonicalDomain(lowerUrl);
  const path = getUrlPath(lowerUrl);
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();

  for (const rule of PAGE_KIND_RULES) {
    if (rule.test({ domain, path, text })) return rule.kind;
  }

  return 'unknown';
}

export function scoreGenericity(pageKind, { url = '', title = '', snippet = '' } = {}) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  const path = getUrlPath(String(url || '').toLowerCase());
  let score = 0;

  if (['homepage', 'section', 'topic', 'live', 'roundup', 'video', 'audio'].includes(pageKind)) score += 4;
  if (pageKind === 'official_release') score += 1;
  if (/\b(latest|breaking|live updates?|news at a glance|headlines)\b/.test(text)) score += 2;
  if (/\/(topic|topics|tag|tags|live|video|videos|audio|podcasts?)\//.test(path)) score += 2;
  if (/\/(news|world|business|technology|tech|health|sports|culture)\/?$/.test(path)) score += 3;

  return Math.min(10, score);
}

export function scoreArticleLikelihood(pageKind, { url = '', title = '', snippet = '' } = {}) {
  const path = getUrlPath(String(url || '').toLowerCase());
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  let score = 1;

  if (pageKind === 'article') score += 6;
  if (pageKind === 'analysis') score += 5;
  if (pageKind === 'official_release') score += 5;
  if (/\/\d{4}\/\d{2}\/\d{2}\//.test(path)) score += 2;
  if (/\/[a-z0-9-]{20,}/.test(path)) score += 1;
  if (/\b(analysis|report|exclusive|interview|investigation|statement|order|filing)\b/.test(text)) score += 1;
  if (['homepage', 'section', 'topic', 'video', 'audio'].includes(pageKind)) score -= 4;
  if (pageKind === 'live' || pageKind === 'roundup') score -= 2;

  return Math.max(0, Math.min(10, score));
}

export function getCanonicalDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

export function getUrlPath(url) {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
}
