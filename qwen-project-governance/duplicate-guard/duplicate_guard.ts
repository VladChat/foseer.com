// File: qwen-project-governance/duplicate-guard/duplicate_guard.ts
// Purpose: Decide new article vs update existing vs reject as duplicate.
// Input: ranked_topic_schema.md + article_inventory.md
// Output: decision following duplicate_guard_spec.md

export interface RankedTopic {
  topic_id: string;
  topic_title: string;
  recommended_article_type: string;
  core_subjects: string[];
  entities: string[];
  is_time_bound: boolean;
}

export interface ArticleEntry {
  article_id: string;
  topic_id: string;
  title: string;
  created: string;
  last_updated: string;
  status: string;
  section: string;
  article_type: string;
  primary_topic: string;
  key_entities: string[];
  search_keywords: string[];
  canonical_url: string;
  core_subjects: string[];
}

export interface DuplicateGuardDecision {
  topic_id: string;
  decision_type: 'new' | 'update' | 'reject';
  target_article_id: string | null;
  decision_rationale: string;
  confidence: 'high' | 'medium' | 'low';
  assigned_article_id: string | null;
}

/**
 * Normalize a title into core subjects and entities.
 */
const TOKEN_NORMALIZATION: Record<string, string> = {
  detained: 'detain',
  detention: 'detain',
  detainment: 'detain',
  visa: 'visa',
  visas: 'visa',
  daughter: 'child',
  girl: 'child',
  child: 'child',
  children: 'child',
  mother: 'mother',
  autism: 'autism',
  canadian: 'canadian',
  texas: 'texas',
  immigration: 'immigration',
};

function canonicalizeToken(token: string): string {
  let value = token.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!value) return '';
  value = TOKEN_NORMALIZATION[value] || value;
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ing') && value.length > 5) return value.slice(0, -3);
  if (value.endsWith('ed') && value.length > 4) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 4) return value.slice(0, -1);
  return value;
}

export function normalizeTopic(title: string): { core_subjects: string[], entities: string[] } {
  const commonWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are', 'was', 'were', 'with', 'from', 'as', 'at', 'by', 'this', 'that', 'these', 'those', 'their', 'his', 'her', 'its', 'into', 'over', 'after', 'before']);

  const tokens = title
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .map((word) => canonicalizeToken(word))
    .filter((word) => word.length > 2 && !commonWords.has(word));

  const uniqueTokens = Array.from(new Set(tokens));

  const entityPattern = /(?:[A-Z]{2,}|[A-Z][a-z]+)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+))*/g;
  const entities = Array.from(new Set(title.match(entityPattern) || []));

  return {
    core_subjects: uniqueTokens.slice(0, 10),
    entities: entities.slice(0, 5),
  };
}


const DUPLICATE_MATCH_FLOOR = 0.35;
const PUBLISHED_REJECT_SIMILARITY_THRESHOLD = 0.78;
const TIME_BOUND_UPDATE_SIMILARITY_THRESHOLD = 0.5;

function normalizeComparableTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Calculate similarity between two subject sets.
 */
export function calculateSimilarity(subjects1: string[], subjects2: string[]): number {
  const set1 = new Set(subjects1.map(s => s.toLowerCase()));
  const set2 = new Set(subjects2.map(s => s.toLowerCase()));
  
  const intersection = new Set([...set1].filter(s => set2.has(s)));
  const union = new Set([...set1, ...set2]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Decide whether to create new article, update existing, or reject as duplicate.
 */
export function decideNewOrUpdate(
  rankedTopic: RankedTopic,
  inventory: ArticleEntry[]
): DuplicateGuardDecision {
  const normalized = normalizeTopic(rankedTopic.topic_title);
  const comparableTitle = normalizeComparableTitle(rankedTopic.topic_title);

  let bestMatch: { entry: ArticleEntry; similarity: number } | null = null;

  for (const entry of inventory) {
    const similarity = calculateSimilarity(normalized.core_subjects, entry.core_subjects);
    if (similarity >= DUPLICATE_MATCH_FLOOR && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { entry, similarity };
    }
  }

  if (!bestMatch) {
    return {
      topic_id: rankedTopic.topic_id,
      decision_type: 'new',
      target_article_id: null,
      decision_rationale: `No existing article covers "${rankedTopic.topic_title}". Core subjects (${normalized.core_subjects.join(', ')}) have no match in inventory.`,
      confidence: 'high',
      assigned_article_id: generateNewArticleId(),
    };
  }

  const matchedComparableTitle = normalizeComparableTitle(bestMatch.entry.title);
  const exactTitleMatch = comparableTitle.length > 0 && comparableTitle === matchedComparableTitle;
  const isPublished = bestMatch.entry.status === 'published';

  if (isPublished && exactTitleMatch && bestMatch.similarity >= PUBLISHED_REJECT_SIMILARITY_THRESHOLD) {
    return {
      topic_id: rankedTopic.topic_id,
      decision_type: 'reject',
      target_article_id: bestMatch.entry.article_id,
      decision_rationale: `Topic is duplicate of existing article "${bestMatch.entry.title}" (${bestMatch.entry.article_id}). Similarity score: ${(bestMatch.similarity * 100).toFixed(0)}%.`,
      confidence: bestMatch.similarity > 0.9 ? 'high' : 'medium',
      assigned_article_id: null,
    };
  }

  if (rankedTopic.is_time_bound && bestMatch.similarity < TIME_BOUND_UPDATE_SIMILARITY_THRESHOLD) {
    return {
      topic_id: rankedTopic.topic_id,
      decision_type: 'new',
      target_article_id: null,
      decision_rationale: `Time-sensitive topic "${rankedTopic.topic_title}" warrants new article despite some overlap with "${bestMatch.entry.title}". Similarity: ${(bestMatch.similarity * 100).toFixed(0)}%.`,
      confidence: 'medium',
      assigned_article_id: generateNewArticleId(),
    };
  }

  return {
    topic_id: rankedTopic.topic_id,
    decision_type: 'update',
    target_article_id: bestMatch.entry.article_id,
    decision_rationale: `Topic updates existing article "${bestMatch.entry.title}" (${bestMatch.entry.article_id}). Similarity score: ${(bestMatch.similarity * 100).toFixed(0)}%. New information should be incorporated.`,
    confidence: bestMatch.similarity > 0.7 ? 'high' : 'medium',
    assigned_article_id: null,
  };
}

/**
 * Generate new article ID in format ART-YYYY-NNN.
 */
export function generateNewArticleId(): string {
  const year = new Date().getFullYear();
  // Simple counter - in production would track last used ID
  const randomNum = Math.floor(Math.random() * 900) + 100;
  return `ART-${year}-${randomNum}`;
}

const INVENTORY_LEGACY_HEADERS = ['article id', 'topic id', 'title', 'created', 'last updated', 'status'];

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function normalizeInventoryHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getInventoryValue(cells: string[], headerMap: Map<string, number>, header: string): string {
  const idx = headerMap.get(normalizeInventoryHeader(header));
  if (idx === undefined || idx < 0 || idx >= cells.length) return '';
  return cells[idx].trim();
}

function splitInventoryList(value: string): string[] {
  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse article inventory markdown table.
 * Supports the legacy 6-column format and the expanded metadata format.
 */
export function parseInventory(markdown: string): ArticleEntry[] {
  const entries: ArticleEntry[] = [];
  const lines = markdown.split('\n');

  const headerLineIndex = lines.findIndex((line) => normalizeInventoryHeader(line).includes('article id') && normalizeInventoryHeader(line).includes('topic id'));
  if (headerLineIndex < 0) return entries;

  const headerCells = splitMarkdownRow(lines[headerLineIndex]);
  const headerMap = new Map<string, number>();
  headerCells.forEach((header, index) => {
    headerMap.set(normalizeInventoryHeader(header), index);
  });

  if (!headerMap.has('article id')) {
    INVENTORY_LEGACY_HEADERS.forEach((header, index) => headerMap.set(header, index));
  }

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    if (/^\|(?:\s*[-:]+\s*\|)+$/.test(line)) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length < 6) continue;

    const title = getInventoryValue(cells, headerMap, 'Title');
    const primaryTopic = getInventoryValue(cells, headerMap, 'Primary Topic');
    const keyEntities = splitInventoryList(getInventoryValue(cells, headerMap, 'Key Entities'));
    const searchKeywords = splitInventoryList(getInventoryValue(cells, headerMap, 'Search Keywords'));
    const normalized = normalizeTopic(
      [primaryTopic, title, ...keyEntities, ...searchKeywords].filter(Boolean).join(' ')
    );

    entries.push({
      article_id: getInventoryValue(cells, headerMap, 'Article ID'),
      topic_id: getInventoryValue(cells, headerMap, 'Topic ID'),
      title,
      created: getInventoryValue(cells, headerMap, 'Created'),
      last_updated: getInventoryValue(cells, headerMap, 'Last Updated'),
      status: getInventoryValue(cells, headerMap, 'Status'),
      section: getInventoryValue(cells, headerMap, 'Section'),
      article_type: getInventoryValue(cells, headerMap, 'Article Type'),
      primary_topic: primaryTopic || title,
      key_entities: keyEntities.length > 0 ? keyEntities : normalized.entities,
      search_keywords: searchKeywords.length > 0 ? searchKeywords : normalized.core_subjects,
      canonical_url: getInventoryValue(cells, headerMap, 'Canonical URL'),
      core_subjects: normalized.core_subjects,
    });
  }

  return entries;
}

/**
 * Format decision as markdown.
 */
export function formatDecision(decision: DuplicateGuardDecision): string {
  return `---
topic_id: ${decision.topic_id}
decision_type: ${decision.decision_type}
target_article_id: ${decision.target_article_id}
assigned_article_id: ${decision.assigned_article_id}
confidence: ${decision.confidence}
---

# Duplicate Guard Decision: ${decision.topic_id}

## Decision
**${decision.decision_type.toUpperCase()}**

## Rationale
${decision.decision_rationale}

## Next Step
${decision.decision_type === 'new' 
  ? `Proceed to brief builder with article ID: ${decision.assigned_article_id}`
  : decision.decision_type === 'update'
  ? `Route to brief builder for update of ${decision.target_article_id}`
  : 'Topic rejected - no further action required'
}
`;
}
