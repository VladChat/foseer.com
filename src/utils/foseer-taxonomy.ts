// File: src/utils/foseer-taxonomy.ts
// Purpose: Helper functions to read taxonomy and topic metrics and compute popularity scores for Foseer.

import fs from "node:fs";
import path from "node:path";

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

type MetricsMap = Record<string, TopicMetrics>;

type RawTaxonomy = {
  sections?: Array<{
    id: string;
    label: string;
    kind?: string;
    description?: string;
    topics?: string[];
  }>;
  topics?: Array<{
    id: string;
    label: string;
    description?: string;
    section?: string;
    keywords?: string[];
  }>;
};

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

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getDataDir(): string {
  return path.resolve(process.cwd(), "src", "data");
}

function safeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeTrend(score: number, lastSeen = ""): TrendInfo {
  return {
    score: safeNumber(score, 0),
    last_seen: lastSeen,
  };
}

export function getRawMetrics(): RawMetrics {
  if (cachedRawMetrics) return cachedRawMetrics;

  const dataDir = getDataDir();
  const metricsPath = path.join(dataDir, "topic-metrics.json");

  const raw = loadJson<RawMetrics>(metricsPath, { topics: {}, sections: {} });
  cachedRawMetrics = raw;
  return raw;
}

/**
 * Normalize src/data/taxonomy.json into runtime Taxonomy model
 */
export function getTaxonomy(): Taxonomy {
  if (cachedTaxonomy) return cachedTaxonomy;

  const dataDir = getDataDir();
  const taxonomyPath = path.join(dataDir, "taxonomy.json");

  const rawTaxonomy = loadJson<RawTaxonomy>(taxonomyPath, {
    sections: [],
    topics: [],
  });

  const rawMetrics = getRawMetrics();

  const rawTopicsById = new Map<string, RawTaxonomy["topics"][number]>();
  for (const t of rawTaxonomy.topics ?? []) rawTopicsById.set(t.id, t);

  const sections: Section[] = [];

  for (const s of rawTaxonomy.sections ?? []) {
    const sectionTrendScore = safeNumber(rawMetrics.sections?.[s.id]?.trendScore, 0);

    const topics: Topic[] = [];
    for (const topicId of s.topics ?? []) {
      const rt = rawTopicsById.get(topicId);
      if (!rt) continue;

      const topicTrendScore = safeNumber(rawMetrics.topics?.[topicId]?.trendScore, 0);

      topics.push({
        id: rt.id,
        slug: rt.id,
        title: rt.label,
        description: rt.description,
        trend: makeTrend(topicTrendScore),
      });
    }

    sections.push({
      id: s.id,
      slug: s.id,
      title: s.label,
      description: s.description,
      trend: makeTrend(sectionTrendScore),
      topics,
    });
  }

  cachedTaxonomy = {
    sections,
    updated_at: "",
  };

  return cachedTaxonomy;
}

export function getMetrics(): MetricsMap {
  if (cachedMetrics) return cachedMetrics;

  const raw = getRawMetrics();
  const m: MetricsMap = {};

  for (const [topicId, v] of Object.entries(raw.topics ?? {})) {
    m[topicId] = {
      views_7d: 0,
      views_30d: 0,
      engagement_score: safeNumber(v.onsiteEngagementScore, 0),
    };
  }

  cachedMetrics = m;
  return m;
}

export function getTopicMetrics(topicId: string): TopicMetrics {
  const metrics = getMetrics();
  return (
    metrics[topicId] ?? {
      views_7d: 0,
      views_30d: 0,
      engagement_score: 0,
    }
  );
}

export function getSections(): Section[] {
  return getTaxonomy().sections;
}

export function getSectionBySlug(slug: string): Section | undefined {
  return getSections().find((section) => section.slug === slug);
}

export function getTopicsFlat(): TopicWithSection[] {
  const taxonomy = getTaxonomy();
  const topics: TopicWithSection[] = [];

  for (const section of taxonomy.sections) {
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
    const sectionTopics = topics.filter((t) => t.sectionId === section.id);

    if (sectionTopics.length === 0) {
      sectionScoreMap.set(section.id, section.trend?.score ?? 0);
      continue;
    }

    const maxScore = Math.max(...sectionTopics.map((t) => getCombinedScore(t)));
    sectionScoreMap.set(section.id, maxScore);
  }

  return [...sections]
    .sort((a, b) => {
      const sa = sectionScoreMap.get(a.id) ?? 0;
      const sb = sectionScoreMap.get(b.id) ?? 0;
      return sb - sa;
    })
    .slice(0, limit);
}

export function getTrendingTopics(limit = 8): TopicWithSection[] {
  return [...getTopicsFlat()]
    .sort((a, b) => getCombinedScore(b) - getCombinedScore(a))
    .slice(0, limit);
}

export function getTopicsBySection(sectionId: string): TopicWithSection[] {
  return getTopicsFlat().filter((t) => t.sectionId === sectionId);
}

/**
 * Added for section/topic pages compatibility
 */
export function getTopicBySlugs(
  sectionSlug: string,
  topicSlug: string
): Topic | undefined {
  const section = getSectionBySlug(sectionSlug);
  if (!section) return undefined;

  return section.topics.find((topic) => topic.slug === topicSlug);
}
