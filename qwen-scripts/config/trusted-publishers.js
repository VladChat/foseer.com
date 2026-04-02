// File: qwen-scripts/config/trusted-publishers.js
// Purpose: Load canonical source trust domains (trusted reporting + official primary/context) from compiled registry with safe fallbacks.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const SOURCE_TRUST_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'source-trust-registry.json');

const DEFAULT_HIGH_TIER_TRUSTED = [
  'reuters.com',
  'apnews.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'bbc.com',
  'bbc.co.uk',
  'nytimes.com',
  'theguardian.com',
  'washingtonpost.com',
  'economist.com',
];

const DEFAULT_TRUSTED = [
  ...DEFAULT_HIGH_TIER_TRUSTED,
  'cnbc.com',
  'politico.com',
  'axios.com',
  'npr.org',
  'abcnews.go.com',
  'abcnews.com',
  'cbsnews.com',
  'nbcnews.com',
  'cnn.com',
  'nikkei.com',
  'asia.nikkei.com',
  'theglobeandmail.com',
  'aljazeera.com',
  'dw.com',
  'france24.com',
];

const DEFAULT_OFFICIAL_PRIMARY = [
  'sec.gov',
  'fda.gov',
  'whitehouse.gov',
  'justice.gov',
  'uscourts.gov',
  'supremecourt.gov',
  'congress.gov',
  'federalregister.gov',
  'govinfo.gov',
];

const DEFAULT_OFFICIAL_CONTEXT = [
  'fifa.com',
  'uefa.com',
  'nba.com',
  'nfl.com',
  'mlb.com',
  'nhl.com',
  'olympics.com',
  'nature.com',
  'science.org',
  'nejm.org',
  'thelancet.com',
];

function normalizeList(domains = []) {
  return Array.from(new Set((Array.isArray(domains) ? domains : []).map((domain) => normalizeDomain(domain)).filter(Boolean)));
}

function loadSourceTrustRegistry() {
  try {
    if (!fs.existsSync(SOURCE_TRUST_REGISTRY_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(SOURCE_TRUST_REGISTRY_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

const SOURCE_TRUST_REGISTRY = loadSourceTrustRegistry();

export const HIGH_TIER_TRUSTED_PUBLISHER_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.trusted_reporting_high || DEFAULT_HIGH_TIER_TRUSTED
);

export const TRUSTED_PUBLISHER_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.trusted_reporting || DEFAULT_TRUSTED
);

export const OFFICIAL_PRIMARY_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.official_primary || DEFAULT_OFFICIAL_PRIMARY
);

export const OFFICIAL_CONTEXT_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.official_context || DEFAULT_OFFICIAL_CONTEXT
);

export const DISCOVERY_WHITELIST_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.discovery_whitelist || [
    ...TRUSTED_PUBLISHER_DOMAINS,
    ...OFFICIAL_PRIMARY_DOMAINS,
  ]
);

export const STRICT_SINGLE_SOURCE_WHITELIST_DOMAINS = normalizeList(
  SOURCE_TRUST_REGISTRY?.groups?.strict_single_source_whitelist || [
    ...HIGH_TIER_TRUSTED_PUBLISHER_DOMAINS,
    ...OFFICIAL_PRIMARY_DOMAINS,
  ]
);

export function normalizeDomain(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function matchesAllowedDomain(value, allowedDomains = []) {
  const domain = normalizeDomain(value);
  if (!domain) return false;
  return (Array.isArray(allowedDomains) ? allowedDomains : [])
    .some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function isTrustedDiscoveryDomain(value) {
  return matchesAllowedDomain(value, DISCOVERY_WHITELIST_DOMAINS);
}

export function isTrustedReportingDomain(value) {
  return matchesAllowedDomain(value, TRUSTED_PUBLISHER_DOMAINS);
}

export function isHighTierTrustedReportingDomain(value) {
  return matchesAllowedDomain(value, HIGH_TIER_TRUSTED_PUBLISHER_DOMAINS);
}

export function isOfficialPrimaryDomain(value) {
  return matchesAllowedDomain(value, OFFICIAL_PRIMARY_DOMAINS);
}

export function isOfficialContextDomain(value) {
  return matchesAllowedDomain(value, OFFICIAL_CONTEXT_DOMAINS);
}

export function isStrictSingleSourceWhitelistDomain(value) {
  return matchesAllowedDomain(value, STRICT_SINGLE_SOURCE_WHITELIST_DOMAINS);
}

export function classifyTrustRoleForDomain(value) {
  if (isOfficialPrimaryDomain(value)) return 'official_primary';
  if (isTrustedReportingDomain(value)) return 'trusted_reporting';
  if (isOfficialContextDomain(value)) return 'official_context';
  return 'none';
}

export function chunkDomains(domains, chunkSize = 8) {
  const unique = normalizeList(domains);
  const chunks = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    chunks.push(unique.slice(i, i + chunkSize));
  }
  return chunks;
}

export function buildGoogleTrustedQueries() {
  const domainChunks = chunkDomains(DISCOVERY_WHITELIST_DOMAINS, 16).slice(0, 2);
  const topicalClauses = [
    '(announced OR approved OR filed OR charged OR launched OR confirmed OR warns)',
    '(markets OR economy OR policy OR ai OR cybersecurity OR health OR conflict)',
  ];

  return domainChunks.map((chunk, index) => {
    const siteClause = chunk.map((domain) => `site:${domain}`).join(' OR ');
    const topicalClause = topicalClauses[index] || topicalClauses[topicalClauses.length - 1];
    return `(${siteClause}) ${topicalClause}`;
  });
}

export function getSourceTrustRegistryMeta() {
  return {
    loaded: Boolean(SOURCE_TRUST_REGISTRY),
    path: SOURCE_TRUST_REGISTRY_PATH,
    version: SOURCE_TRUST_REGISTRY?.version || null,
    generated_at: SOURCE_TRUST_REGISTRY?.generated_at || null,
  };
}
