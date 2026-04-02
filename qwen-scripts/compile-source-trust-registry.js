// File: qwen-scripts/compile-source-trust-registry.js
// Purpose: Compile canonical source trust registry (trusted reporting + official domains) for discovery, rescue, and gates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const OUTPUT_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'source-trust-registry.json');

const TRUSTED_REPORTING_HIGH = [
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

const TRUSTED_REPORTING_STANDARD = [
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

const OFFICIAL_PRIMARY_DOMAINS = [
  'whitehouse.gov',
  'congress.gov',
  'supremecourt.gov',
  'uscourts.gov',
  'justice.gov',
  'state.gov',
  'treasury.gov',
  'commerce.gov',
  'dol.gov',
  'energy.gov',
  'education.gov',
  'hhs.gov',
  'cdc.gov',
  'nih.gov',
  'cms.gov',
  'epa.gov',
  'fda.gov',
  'dhs.gov',
  'cisa.gov',
  'fema.gov',
  'faa.gov',
  'nhtsa.gov',
  'usda.gov',
  'nasa.gov',
  'sec.gov',
  'cftc.gov',
  'ftc.gov',
  'fcc.gov',
  'federalreserve.gov',
  'federalregister.gov',
  'govinfo.gov',
  'gov.uk',
  'parliament.uk',
  'ec.europa.eu',
  'europa.eu',
  'un.org',
  'who.int',
  'oecd.org',
];

const OFFICIAL_CONTEXT_DOMAINS = [
  'fifa.com',
  'uefa.com',
  'nba.com',
  'nfl.com',
  'mlb.com',
  'nhl.com',
  'olympics.com',
  'ncaa.com',
  'nature.com',
  'science.org',
  'nejm.org',
  'thelancet.com',
  'jamanetwork.com',
  'cell.com',
  'pnas.org',
];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeDomain(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function dedupeDomains(domains = []) {
  const set = new Set();
  for (const domain of domains) {
    const normalized = normalizeDomain(domain);
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

function buildRegistry() {
  const trustedHigh = dedupeDomains(TRUSTED_REPORTING_HIGH);
  const trustedStandard = dedupeDomains(TRUSTED_REPORTING_STANDARD);
  const officialPrimary = dedupeDomains(OFFICIAL_PRIMARY_DOMAINS);
  const officialContext = dedupeDomains(OFFICIAL_CONTEXT_DOMAINS);

  const entries = [
    ...trustedHigh.map((domain) => ({
      domain,
      role: 'trusted_reporting',
      tier: 'high',
      desks: ['all'],
    })),
    ...trustedStandard.map((domain) => ({
      domain,
      role: 'trusted_reporting',
      tier: 'standard',
      desks: ['all'],
    })),
    ...officialPrimary.map((domain) => ({
      domain,
      role: 'official_primary',
      tier: 'official',
      desks: ['all'],
    })),
    ...officialContext.map((domain) => ({
      domain,
      role: 'official_context',
      tier: 'context',
      desks: ['sports', 'health', 'news', 'business'],
    })),
  ];

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    source: 'qwen-scripts/compile-source-trust-registry.js',
    groups: {
      trusted_reporting_high: trustedHigh,
      trusted_reporting: dedupeDomains([...trustedHigh, ...trustedStandard]),
      official_primary: officialPrimary,
      official_context: officialContext,
      discovery_whitelist: dedupeDomains([
        ...trustedHigh,
        ...trustedStandard,
        ...officialPrimary,
      ]),
      strict_single_source_whitelist: dedupeDomains([...trustedHigh, ...officialPrimary]),
    },
    entries,
  };
}

function main() {
  const registry = buildRegistry();
  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  console.log(`[source-trust-registry] Wrote ${OUTPUT_PATH}`);
  console.log(`[source-trust-registry] trusted_reporting=${registry.groups.trusted_reporting.length}, official_primary=${registry.groups.official_primary.length}, discovery_whitelist=${registry.groups.discovery_whitelist.length}`);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}

export { buildRegistry };
