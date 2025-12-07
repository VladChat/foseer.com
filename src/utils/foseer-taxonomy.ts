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

export type TopicWithSection = Topic & {
  sectionId: string;
  sectionSlug: string;
  sectionTitle: string;
};

let cachedTaxonomy: Taxonomy | null = null;
let cachedMetrics: MetricsMap | null = null;

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

export function getTaxonomy(): Taxonomy {
  if (cachedTaxonomy) return cachedTaxonomy;

  const dataDir = getDataDir();
  const taxonomyPath = path.join(dataDir, "taxonomy.json");

  const taxonomy = loadJson<Taxonomy>(taxonomyPath, {
    sections: [],
    updated_at: "",
  });

  cachedTaxonomy = taxonomy;
  return taxonomy;
}

export function getMetrics(): MetricsMap {
  if (cachedMetrics) return cachedMetrics;

  const dataDir = getDataDir();
  const metricsPath = path.join(dataDir, "topic-metrics.json");

  const metrics = loadJson<MetricsMap>(metricsPath, {});
  cachedMetrics = metrics;
  return metrics;
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

export function getTopicBySlugs(
  sectionSlug: string,
  topicSlug: string
): TopicWithSection | undefined {
  return getTopicsFlat().find(
    (t) => t.sectionSlug === sectionSlug && t.slug === topicSlug
  );
}

export function getTopicMetrics(topicId: string): TopicMetrics {
  const metrics = getMetrics();
  const base = metrics[topicId];

  if (!base) {
    return {
      views_7d: 0,
      views_30d: 0,
      engagement_score: 0,
    };
  }

  return {
    views_7d: base.views_7d ?? 0,
    views_30d: base.views_30d ?? 0,
    engagement_score: base.engagement_score ?? 0,
  };
}

/**
 * Combined popularity score for a topic:
 *  - 0.7 * trend score (LLM + external signals)
 *  - 0.3 * engagement score (visits, currently a stub)
 */
export function getCombinedScore(topic: TopicWithSection): number {
  const metrics = getTopicMetrics(topic.id);
  const trendScore = topic.trend?.score ?? 0;
  const engagementScore = metrics.engagement_score ?? 0;

  return 0.7 * trendScore + 0.3 * engagementScore;
}

/**
 * Top sections by max combined score of topics inside each section.
 */
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

    const maxScore = Math.max(
      ...sectionTopics.map((t) => getCombinedScore(t))
    );
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

/**
 * Top topics by combined score across all sections.
 */
export function getTrendingTopics(limit = 8): TopicWithSection[] {
  const topics = getTopicsFlat();

  return [...topics]
    .sort((a, b) => getCombinedScore(b) - getCombinedScore(a))
    .slice(0, limit);
}

/**
 * Topics that belong to a single section.
 */
export function getTopicsBySection(sectionId: string): TopicWithSection[] {
  return getTopicsFlat().filter((t) => t.sectionId === sectionId);
}
