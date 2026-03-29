// File: qwen-scripts/config/trusted-publishers.js
// Purpose: Local qwen copy of trusted publisher and official source domains for discovery-time query building.

export const TRUSTED_PUBLISHER_DOMAINS = [
  'reuters.com',
  'apnews.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'nytimes.com',
  'bbc.com',
  'bbc.co.uk',
  'theguardian.com',
  'washingtonpost.com',
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
  'economist.com',
];

export const OFFICIAL_PRIMARY_DOMAINS = [
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

export const DISCOVERY_WHITELIST_DOMAINS = [
  ...TRUSTED_PUBLISHER_DOMAINS,
  ...OFFICIAL_PRIMARY_DOMAINS,
];

export function normalizeDomain(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

export function isTrustedDiscoveryDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain) return false;
  return DISCOVERY_WHITELIST_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function chunkDomains(domains, chunkSize = 8) {
  const unique = Array.from(new Set(domains.map(normalizeDomain).filter(Boolean)));
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
