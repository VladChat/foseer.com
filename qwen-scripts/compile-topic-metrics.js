// File: qwen-scripts/compile-topic-metrics.js
// Purpose: Generate topic metrics aligned with the compiled taxonomy registry.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const ROOT = PROJECT_ROOT;
const REGISTRY_PATH = path.resolve(ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');
const OUTPUT_PATH = path.resolve(ROOT, 'src', 'data', 'topic-metrics.json');

const SECTION_SCORES = {
  news: { trendScore: 0.9, onsiteEngagementScore: 0.84 },
  business: { trendScore: 0.89, onsiteEngagementScore: 0.85 },
  tech: { trendScore: 0.92, onsiteEngagementScore: 0.86 },
  health: { trendScore: 0.84, onsiteEngagementScore: 0.78 },
  sports: { trendScore: 0.86, onsiteEngagementScore: 0.8 },
  culture: { trendScore: 0.85, onsiteEngagementScore: 0.82 },
};

const TOPIC_OVERRIDES = {
  'ai-big-tech': { trendScore: 0.96, onsiteEngagementScore: 0.9 },
  'us-politics': { trendScore: 0.9, onsiteEngagementScore: 0.85 },
  'world-geopolitics': { trendScore: 0.9, onsiteEngagementScore: 0.83 },
  'law-crime': { trendScore: 0.88, onsiteEngagementScore: 0.84 },
  'climate-extreme-weather': { trendScore: 0.88, onsiteEngagementScore: 0.8 },
  'society-social-trends': { trendScore: 0.84, onsiteEngagementScore: 0.79 },
  'economy-markets': { trendScore: 0.9, onsiteEngagementScore: 0.82 },
  'companies-deals': { trendScore: 0.91, onsiteEngagementScore: 0.84 },
  'consumer-money': { trendScore: 0.88, onsiteEngagementScore: 0.86 },
  'housing-real-estate': { trendScore: 0.82, onsiteEngagementScore: 0.77 },
  'crypto-bitcoin': { trendScore: 0.84, onsiteEngagementScore: 0.78 },
  'travel-consumer-issues': { trendScore: 0.82, onsiteEngagementScore: 0.76 },
  'consumer-tech': { trendScore: 0.86, onsiteEngagementScore: 0.8 },
  'cybersecurity': { trendScore: 0.83, onsiteEngagementScore: 0.78 },
  'mobility-evs': { trendScore: 0.8, onsiteEngagementScore: 0.72 },
  'space-astronomy': { trendScore: 0.82, onsiteEngagementScore: 0.75 },
  'enterprise-platforms': { trendScore: 0.84, onsiteEngagementScore: 0.79 },
  'public-health': { trendScore: 0.83, onsiteEngagementScore: 0.76 },
  'medical-research': { trendScore: 0.81, onsiteEngagementScore: 0.75 },
  'pharma-fda': { trendScore: 0.82, onsiteEngagementScore: 0.77 },
  'mental-health': { trendScore: 0.82, onsiteEngagementScore: 0.77 },
  'wellness-fitness': { trendScore: 0.79, onsiteEngagementScore: 0.74 },
  'major-leagues': { trendScore: 0.86, onsiteEngagementScore: 0.8 },
  'events-tournaments': { trendScore: 0.87, onsiteEngagementScore: 0.82 },
  'transfers-business': { trendScore: 0.84, onsiteEngagementScore: 0.79 },
  'athletes-culture': { trendScore: 0.83, onsiteEngagementScore: 0.78 },
  'film-tv': { trendScore: 0.85, onsiteEngagementScore: 0.82 },
  'music-celebrities': { trendScore: 0.86, onsiteEngagementScore: 0.83 },
  'internet-culture': { trendScore: 0.87, onsiteEngagementScore: 0.84 },
  'creators-platforms': { trendScore: 0.85, onsiteEngagementScore: 0.81 },
};

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
const topics = Object.fromEntries(registry.topics.map((topic) => {
  const sectionBaseline = SECTION_SCORES[topic.section_id] || { trendScore: 0.8, onsiteEngagementScore: 0.75 };
  return [topic.id, TOPIC_OVERRIDES[topic.id] || sectionBaseline];
}));

const sections = Object.fromEntries(registry.sections.map((section) => [section.id, SECTION_SCORES[section.id] || { trendScore: 0.8, onsiteEngagementScore: 0.75 }]));
const metrics = { topics, sections };
ensureDir(OUTPUT_PATH);
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(metrics, null, 2) + "\n");
console.log(`[compile-topic-metrics] Wrote metrics for ${Object.keys(topics).length} topics and ${Object.keys(sections).length} sections to ${path.relative(ROOT, OUTPUT_PATH)}`);
