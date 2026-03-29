// File: src/utils/foseer-taxonomy.ts
// Purpose: Helper functions to read the compiled taxonomy registry and topic metrics for Foseer.

import fs from 'node:fs';
import path from 'node:path';

export type TrendInfo = {
  score: number;
  last_seen: string;
  components?: {
    trend_growth?: number;
    seo_potential?: number;
    our_expertise?: number;
    engagement?: number;
  };
};

export type Topic = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  trend: TrendInfo;
};

export type Section = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  trend: TrendInfo;
  topics: Topic[];
  kind: 'core' | 'special';
};

export type Taxonomy = {
  sections: Section[];
  updated_at: string;
};

export type TopicMetrics = {
  views_7d: number;
  views_30d: number;
  engagement_score?: number;
};

export type TaxonomyRegistry = {
  version: string;
  generated_at: string;
  source_path: string;
  sections: Array<{
    id: string;
    slug: string;
    label: string;
    description?: string;
    kind?: string;
    topic_ids?: string[];
  }>;
  topics: Array<{
    id: string;
    slug: string;
    label: string;
    description?: string;
    section_id: string;
    section_slug: string;
    section_label: string;
    aliases?: string[];
  }>;
  sectionById?: Record<string, {
    id: string;
    slug: string;
    label: string;
    description?: string;
    kind?: string;
    topic_ids?: string[];
  }>;
  topicById?: Record<string, {
    id: string;
    slug: string;
    label: string;
    description?: string;
    section_id: string;
    section_slug: string;
    section_label: string;
    aliases?: string[];
  }>;
  topicsBySection?: Record<string, string[]>;
  sectionByTopic?: Record<string, string>;
  aliases?: {
    sections?: Record<string, string>;
    topics?: Record<string, string>;
  };
  legacyMappings?: {
    topics?: Record<string, string>;
    sections?: Record<string, string>;
  };
  navigation?: {
    coreSectionIds?: string[];
    footerBrowseIds?: string[];
    headerTopicLimit?: number;
  };
  discoveryHints?: {
    bySection?: Record<string, string[]>;
    byTopic?: Record<string, string[]>;
  };
  imageHints?: {
    bySection?: Record<string, string[]>;
    byTopic?: Record<string, string[]>;
  };
  writerHints?: {
    defaultArticleTypeBySection?: Record<string, 'report' | 'analysis' | 'explainer'>;
    reportTopicIds?: string[];
  };
};

type MetricsMap = Record<string, TopicMetrics>;

type RawMetrics = {
  topics?: Record<string, { trendScore?: number; onsiteEngagementScore?: number }>;
  sections?: Record<string, { trendScore?: number; onsiteEngagementScore?: number }>;
};

export type TopicWithSection = Topic & {
  sectionId: string;
  sectionSlug: string;
  sectionTitle: string;
};

let cachedTaxonomy: Taxonomy | null = null;
let cachedMetrics: MetricsMap | null = null;
let cachedRawMetrics: RawMetrics | null = null;
let cachedRegistry: TaxonomyRegistry | null = null;

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeTrend(score: number, lastSeen = ''): TrendInfo {
  return {
    score: safeNumber(score, 0),
    last_seen: lastSeen,
  };
}

export function getTaxonomyRegistryPath(): string {
  return path.resolve(process.cwd(), 'qwen-data', 'contracts', 'taxonomy-registry.json');
}

function getMetricsPath(): string {
  return path.resolve(process.cwd(), 'src', 'data', 'topic-metrics.json');
}

export function getTaxonomyRegistry(): TaxonomyRegistry {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = loadJson<TaxonomyRegistry>(getTaxonomyRegistryPath(), {
    version: '0.0.0',
    generated_at: '',
    source_path: 'src/data/taxonomy.json',
    sections: [],
    topics: [],
    sectionById: {},
    topicById: {},
    topicsBySection: {},
    sectionByTopic: {},
    aliases: { sections: {}, topics: {} },
    legacyMappings: { topics: {}, sections: {} },
    navigation: { coreSectionIds: [], footerBrowseIds: [], headerTopicLimit: 5 },
  });
  return cachedRegistry;
}

export function getRawMetrics(): RawMetrics {
  if (cachedRawMetrics) return cachedRawMetrics;
  cachedRawMetrics = loadJson<RawMetrics>(getMetricsPath(), { topics: {}, sections: {} });
  return cachedRawMetrics;
}

export function getTaxonomy(): Taxonomy {
  if (cachedTaxonomy) return cachedTaxonomy;

  const registry = getTaxonomyRegistry();
  const rawMetrics = getRawMetrics();
  const topicsById = new Map(registry.topics.map((topic) => [topic.id, topic]));

  const sections: Section[] = registry.sections.map((section) => {
    const topics: Topic[] = (section.topic_ids || []).map((topicId) => {
      const topic = topicsById.get(topicId);
      const topicTrendScore = safeNumber(rawMetrics.topics?.[topicId]?.trendScore, 0);
      return topic
        ? {
            id: topic.id,
            slug: topic.slug,
            title: topic.label,
            description: topic.description,
            trend: makeTrend(topicTrendScore),
          }
        : null;
    }).filter(Boolean) as Topic[];

    const sectionTrendScore = safeNumber(rawMetrics.sections?.[section.id]?.trendScore, 0);
    return {
      id: section.id,
      slug: section.slug,
      title: section.label,
      description: section.description,
      trend: makeTrend(sectionTrendScore),
      topics,
      kind: (section.kind as 'core' | 'special') || 'core',
    };
  });

  cachedTaxonomy = {
    sections,
    updated_at: registry.generated_at || '',
  };
  return cachedTaxonomy;
}

export function getMetrics(): MetricsMap {
  if (cachedMetrics) return cachedMetrics;

  const raw = getRawMetrics();
  const metrics: MetricsMap = {};
  for (const [topicId, value] of Object.entries(raw.topics || {})) {
    metrics[topicId] = {
      views_7d: 0,
      views_30d: 0,
      engagement_score: safeNumber(value.onsiteEngagementScore, 0),
    };
  }

  cachedMetrics = metrics;
  return cachedMetrics;
}

export function getTopicMetrics(topicId: string): TopicMetrics {
  const metrics = getMetrics();
  return metrics[topicId] || { views_7d: 0, views_30d: 0, engagement_score: 0 };
}

export function getSections(): Section[] {
  return getTaxonomy().sections;
}

export function getSectionBySlug(slug: string): Section | undefined {
  return getSections().find((section) => section.slug === slug);
}

export function getTopicsFlat(): TopicWithSection[] {
  const topics: TopicWithSection[] = [];
  for (const section of getTaxonomy().sections) {
    for (const topic of section.topics) {
      topics.push({
        ...topic,
        sectionId: section.id,
        sectionSlug: section.slug,
        sectionTitle: section.title,
      });
    }
  }
  return topics;
}

export function getCombinedScore(topic: TopicWithSection): number {
  const metrics = getTopicMetrics(topic.id);
  const trendScore = topic.trend?.score ?? 0;
  const engagementScore = metrics.engagement_score ?? 0;
  return 0.7 * trendScore + 0.3 * engagementScore;
}

export function getTopSections(limit = 6): Section[] {
  const sections = getSections();
  const topics = getTopicsFlat();
  const sectionScoreMap = new Map<string, number>();

  for (const section of sections) {
    const sectionTopics = topics.filter((topic) => topic.sectionId === section.id);
    if (sectionTopics.length === 0) {
      sectionScoreMap.set(section.id, section.trend?.score ?? 0);
      continue;
    }
    sectionScoreMap.set(section.id, Math.max(...sectionTopics.map((topic) => getCombinedScore(topic))));
  }

  return [...sections].sort((a, b) => (sectionScoreMap.get(b.id) ?? 0) - (sectionScoreMap.get(a.id) ?? 0)).slice(0, limit);
}

export function getTrendingTopics(limit = 8): TopicWithSection[] {
  return [...getTopicsFlat()].sort((a, b) => getCombinedScore(b) - getCombinedScore(a)).slice(0, limit);
}

export function getTopicsBySection(sectionId: string): TopicWithSection[] {
  return getTopicsFlat().filter((topic) => topic.sectionId === sectionId);
}

export function getTopicBySlugs(sectionSlug: string, topicSlug: string): Topic | undefined {
  const section = getSectionBySlug(sectionSlug);
  if (!section) return undefined;
  return section.topics.find((topic) => topic.slug === topicSlug);
}
