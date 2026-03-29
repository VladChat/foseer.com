// File: qwen-scripts/compile-taxonomy-registry.js
// Purpose: Compile src/data/taxonomy.json into a normalized registry consumed by downstream nodes.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const ROOT = PROJECT_ROOT;
const SOURCE_PATH = path.resolve(ROOT, 'src', 'data', 'taxonomy.json');
const OUTPUT_PATH = path.resolve(ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');

const LEGACY_TOPIC_MAPPINGS = {
  'global-conflicts': 'world-geopolitics',
  'culture-entertainment': 'film-tv',
  'social-media-trends': 'internet-culture',
  'tech-gadgets': 'consumer-tech',
  'transportation-evs': 'mobility-evs',
  'stock-market-economy': 'companies-deals',
  'consumer-money-personal-finance': 'consumer-money',
  'health-science': 'public-health',
  'sports-leagues-analysis': 'major-leagues',
  'sports-business-transfers': 'transfers-business',
  'big-issues-explained': 'society-social-trends',
  'editorial-perspectives': 'society-social-trends',
};

const SECTION_ALIASES = {
  politics: 'news',
  world: 'news',
  technology: 'tech',
  science: 'health',
  entertainment: 'culture',
};

const TOPIC_ALIASES = {
  'us-politics': ['u.s. politics', 'us politics', 'white house', 'congress'],
  'world-geopolitics': ['global conflicts', 'world news', 'geopolitics'],
  'law-crime': ['courts', 'crime', 'legal'],
  'climate-extreme-weather': ['climate', 'extreme weather'],
  'society-social-trends': ['society', 'social trends'],
  'economy-markets': ['economy', 'markets'],
  'companies-deals': ['companies', 'deals', 'earnings'],
  'consumer-money': ['personal finance', 'consumer money'],
  'housing-real-estate': ['housing', 'real estate'],
  'crypto-bitcoin': ['crypto', 'bitcoin'],
  'travel-consumer-issues': ['travel', 'consumer issues'],
  'ai-big-tech': ['ai', 'big tech', 'artificial intelligence'],
  'consumer-tech': ['consumer technology', 'gadgets', 'devices'],
  'cybersecurity': ['cyber', 'security'],
  'mobility-evs': ['evs', 'electric vehicles', 'mobility'],
  'space-astronomy': ['space', 'astronomy'],
  'enterprise-platforms': ['enterprise', 'platforms', 'cloud software'],
  'public-health': ['public health', 'health agencies'],
  'medical-research': ['medical research', 'clinical studies'],
  'pharma-fda': ['pharma', 'fda', 'drug approvals'],
  'mental-health': ['mental health'],
  'wellness-fitness': ['wellness', 'fitness'],
  'major-leagues': ['major leagues', 'league coverage'],
  'events-tournaments': ['events', 'tournaments'],
  'transfers-business': ['transfers', 'sports business'],
  'athletes-culture': ['athletes', 'sports culture'],
  'film-tv': ['film', 'tv', 'streaming'],
  'music-celebrities': ['music', 'celebrities'],
  'internet-culture': ['internet culture', 'viral culture'],
  'creators-platforms': ['creator economy', 'social platforms'],
};

const DISCOVERY_HINTS_BY_SECTION = {
  news: ['breaking news public affairs law climate world events', 'us politics geopolitics law crime climate social trends'],
  business: ['breaking business markets consumer companies housing crypto travel', 'economy markets consumer money companies travel issues'],
  tech: ['breaking technology ai cybersecurity consumer tech mobility space enterprise software', 'ai big tech cyber gadgets evs space platforms'],
  health: ['breaking health public health medical research pharma mental health wellness', 'health agencies medical studies pharma fda mental health wellness'],
  sports: ['breaking sports leagues tournaments transfers athlete culture', 'sports leagues playoffs tournaments transfer market athlete culture'],
  culture: ['breaking culture film tv music celebrities internet creators platforms', 'streaming movies celebrity news internet culture creator economy'],
};

const DISCOVERY_HINTS_BY_TOPIC = {
  'us-politics': ['white house congress federal policy supreme court election campaign'],
  'world-geopolitics': ['war diplomacy military sanctions ceasefire russia ukraine israel iran china'],
  'law-crime': ['court trial investigation arrest lawsuit police prosecutors'],
  'climate-extreme-weather': ['hurricane tornado wildfire heatwave flooding climate risks'],
  'society-social-trends': ['education labor unions demographics communities social shifts'],
  'economy-markets': ['inflation rates jobs gdp markets tariffs recession'],
  'companies-deals': ['earnings merger acquisition ceo restructuring corporate strategy'],
  'consumer-money': ['fees credit debt loans refund bills household budgets'],
  'housing-real-estate': ['rent mortgage home prices housing inventory landlords'],
  'crypto-bitcoin': ['bitcoin ethereum crypto exchange regulation tokens'],
  'travel-consumer-issues': ['airlines airports tsa flight cancellations refunds rental cars'],
  'ai-big-tech': ['openai google meta microsoft nvidia chips ai regulation'],
  'consumer-tech': ['iphone android apps gadgets laptops wearables'],
  'cybersecurity': ['data breach ransomware malware security flaws cyberattacks'],
  'mobility-evs': ['tesla ev charging robotaxi autonomous vehicles transit'],
  'space-astronomy': ['nasa spacex rocket launch satellites telescope astronomy'],
  'enterprise-platforms': ['cloud software enterprise platforms developer tools saas infrastructure'],
  'public-health': ['outbreak hospital system cdc who disease surveillance'],
  'medical-research': ['clinical trial study researchers treatment evidence'],
  'pharma-fda': ['drug approval fda recall biotech pharma'],
  'mental-health': ['therapy anxiety depression stress treatment access'],
  'wellness-fitness': ['exercise sleep nutrition workouts healthy habits'],
  'major-leagues': ['nfl nba mlb nhl premier league standings'],
  'events-tournaments': ['playoffs championship world cup olympics tournament'],
  'transfers-business': ['trade transfer contract rights deal sponsorship ownership'],
  'athletes-culture': ['athletes fans fandom locker room sports culture'],
  'film-tv': ['streaming box office television film franchise'],
  'music-celebrities': ['albums tours celebrities awards music industry'],
  'internet-culture': ['viral meme discourse fandom online communities'],
  'creators-platforms': ['youtube tiktok twitch instagram creators monetization moderation'],
};

const IMAGE_HINTS_BY_SECTION = {
  news: ['public affairs', 'world events', 'court building'],
  business: ['financial district', 'consumer checkout', 'office meeting'],
  tech: ['computer hardware', 'data center', 'consumer gadgets'],
  health: ['hospital exterior', 'medical research', 'wellness lifestyle'],
  sports: ['stadium crowd', 'athlete action', 'sports venue'],
  culture: ['concert crowd', 'movie theater', 'creator studio'],
};

const IMAGE_HINTS_BY_TOPIC = {
  'us-politics': ['white house exterior', 'capitol building', 'policy briefing'],
  'world-geopolitics': ['diplomatic summit', 'military map', 'world leaders'],
  'law-crime': ['courthouse exterior', 'police lights', 'gavel courtroom'],
  'climate-extreme-weather': ['storm clouds', 'wildfire smoke', 'flooded street'],
  'society-social-trends': ['community gathering', 'classroom', 'workers'],
  'economy-markets': ['stock market screen', 'economic chart', 'trading floor'],
  'companies-deals': ['corporate headquarters', 'boardroom meeting', 'earnings call'],
  'consumer-money': ['credit cards', 'shopping cart', 'utility bill'],
  'housing-real-estate': ['houses neighborhood', 'for rent sign', 'apartment building'],
  'crypto-bitcoin': ['bitcoin coin', 'crypto chart', 'digital wallet'],
  'travel-consumer-issues': ['airport terminal', 'airline gate', 'rental car lot'],
  'ai-big-tech': ['computer chip', 'server room', 'ai interface'],
  'consumer-tech': ['smartphone closeup', 'laptop on desk', 'gadgets'],
  'cybersecurity': ['padlock code', 'security terminal', 'cyber dashboard'],
  'mobility-evs': ['electric vehicle charging', 'ev dashboard', 'urban transit'],
  'space-astronomy': ['rocket launch', 'night sky telescope', 'satellite'],
  'enterprise-platforms': ['cloud dashboard', 'software team', 'office screens'],
  'public-health': ['hospital hallway', 'health agency briefing', 'vaccination clinic'],
  'medical-research': ['lab research', 'microscope', 'clinical study'],
  'pharma-fda': ['medicine bottles', 'drug manufacturing', 'regulatory documents'],
  'mental-health': ['therapy office', 'quiet reflection', 'support group'],
  'wellness-fitness': ['running trail', 'healthy meal', 'fitness training'],
  'major-leagues': ['stadium action', 'league match', 'sports field'],
  'events-tournaments': ['tournament trophy', 'competition arena', 'playoff crowd'],
  'transfers-business': ['press conference', 'signing table', 'sports executive'],
  'athletes-culture': ['athlete portrait', 'fans crowd', 'locker room'],
  'film-tv': ['movie set', 'cinema seats', 'streaming remote'],
  'music-celebrities': ['concert stage', 'red carpet', 'microphone performance'],
  'internet-culture': ['phone screen social media', 'meme collage', 'online chat'],
  'creators-platforms': ['content creator studio', 'streaming setup', 'social media creator'],
};

const WRITER_HINTS = {
  defaultArticleTypeBySection: {
    news: 'report',
    business: 'analysis',
    tech: 'analysis',
    health: 'analysis',
    sports: 'report',
    culture: 'report',
  },
  reportTopicIds: ['us-politics', 'world-geopolitics', 'law-crime', 'climate-extreme-weather', 'major-leagues', 'events-tournaments', 'film-tv', 'music-celebrities'],
};

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function compileRegistry() {
  const raw = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf-8'));
  const topicsById = new Map((raw.topics || []).map((topic) => [topic.id, topic]));

  const sections = (raw.sections || []).map((section) => ({
    id: section.id,
    slug: section.id,
    label: section.label,
    description: section.description || '',
    kind: section.kind || 'core',
    topic_ids: [...(section.topics || [])],
  }));

  const sectionById = Object.fromEntries(sections.map((section) => [section.id, section]));

  const topics = [];
  for (const section of sections) {
    for (const topicId of section.topic_ids) {
      const topic = topicsById.get(topicId);
      if (!topic) continue;
      topics.push({
        id: topic.id,
        slug: topic.id,
        label: topic.label,
        description: topic.description || '',
        section_id: section.id,
        section_slug: section.slug,
        section_label: section.label,
        aliases: unique([topic.label.toLowerCase(), topic.id.replace(/-/g, ' '), ...(TOPIC_ALIASES[topic.id] || [])]),
      });
    }
  }

  const topicById = Object.fromEntries(topics.map((topic) => [topic.id, topic]));
  const topicsBySection = Object.fromEntries(sections.map((section) => [section.id, [...section.topic_ids]]));
  const sectionByTopic = Object.fromEntries(topics.map((topic) => [topic.id, topic.section_id]));

  const registry = {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    source_path: 'src/data/taxonomy.json',
    sections,
    topics,
    sectionById,
    topicById,
    topicsBySection,
    sectionByTopic,
    aliases: {
      sections: SECTION_ALIASES,
      topics: Object.fromEntries(Object.entries(TOPIC_ALIASES).flatMap(([topicId, aliases]) => aliases.map((alias) => [alias, topicId]))),
    },
    legacyMappings: {
      topics: LEGACY_TOPIC_MAPPINGS,
      sections: SECTION_ALIASES,
    },
    navigation: {
      coreSectionIds: sections.filter((section) => section.kind === 'core').map((section) => section.id),
      footerBrowseIds: sections.filter((section) => section.kind !== 'core').map((section) => section.id),
      headerTopicLimit: 5,
    },
    discoveryHints: {
      bySection: DISCOVERY_HINTS_BY_SECTION,
      byTopic: DISCOVERY_HINTS_BY_TOPIC,
    },
    imageHints: {
      bySection: IMAGE_HINTS_BY_SECTION,
      byTopic: IMAGE_HINTS_BY_TOPIC,
    },
    writerHints: WRITER_HINTS,
  };

  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(registry, null, 2) + "\n");
  return registry;
}

const registry = compileRegistry();
console.log(`[compile-taxonomy-registry] Wrote ${registry.sections.length} sections and ${registry.topics.length} topics to ${path.relative(ROOT, OUTPUT_PATH)}`);
