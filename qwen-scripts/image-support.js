// File: qwen-scripts/image-support.js
// Purpose: Shared image-library orchestration with local reuse, cooldown rules, metadata enrichment, and provider-agnostic cover selection.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

import {
  loadImageRegistry,
  saveImageRegistry,
  findExistingAssetForCandidate,
  findReusableAsset,
  registerAssetRecord,
  recordImageUsage,
  assetFileExists,
  isAssetWithinCooldown,
} from './image-library/registry.js';
import { applyEnrichmentToAsset, buildArticleSearchProfile, computeContextualEditorialFit } from './image-library/enrichment.js';
import { searchPexelsImageCandidates } from './image-library/providers/pexels.js';
import { searchPixabayImageCandidates } from './image-library/providers/pixabay.js';
import { getSectionRecord, getTopicRecord, resolveSectionId, resolveTopicId } from './utils/taxonomy-registry.js';
import { buildImageQueryPlan } from './utils/image-query-builder.js';

const IMAGE_CONFIG = {
  fallbackPath: '~/assets/images/posts/fallback/foseer-default-cover.svg',
  libraryBase: '~/assets/images/library',
  searchPerQuery: Number(process.env.QWEN_IMAGE_SEARCH_PER_QUERY || 15),
  maxQueriesPerRun: Number(process.env.QWEN_IMAGE_MAX_QUERIES || 8),
};

const SECTION_FALLBACK_KEYWORDS = {
  News: ['government briefing', 'breaking news city', 'news conference', 'press room'],
  Business: ['financial district', 'stock market screen', 'business handshake'],
  Tech: ['technology abstract', 'server room', 'software development'],
  Health: ['hospital corridor', 'medical research', 'healthcare professionals'],
  Sports: ['stadium crowd', 'sports arena', 'athlete training'],
  Culture: ['film set', 'concert stage', 'creator studio'],
};

export async function getArticleImage(article, articleSlug, providerApiKeys = {}, context = {}) {
  console.log(`[image] Getting image for: ${article.title}`);

  const articleType = article.articleType || article.article_type || 'report';
  const rawSectionId = article.section_id || article?.metadata?.classification?.section_id || context?.brief?.section_id || context?.placement?.section_id || null;
  const topicId = resolveTopicId(article.topic_id || article?.metadata?.classification?.topic_id || context?.brief?.topic_id || context?.placement?.topic_id || null);
  const sectionId = topicId
    ? getTopicRecord(topicId)?.section_id || resolveSectionId(rawSectionId)
    : resolveSectionId(rawSectionId);
  const sectionRecord = getSectionRecord(sectionId);
  const topicRecord = getTopicRecord(topicId);
  const section = article?.metadata?.classification?.section || sectionRecord?.label || inferSectionFromText(article.title, article.excerpt || article.content || '');
  const imageContext = extractImageSelectionContext(article, context, { section, topicId, topicRecord, articleType });
  const imageQueryPlan = buildImageQueryPlan({
    title: article.title,
    excerpt: article.excerpt || article.content || '',
    section,
    articleType,
    topicRecord,
    entityHints: imageContext.entityHints,
    geoHints: imageContext.geoHints,
    publishReadySources: imageContext.publishReadySources,
    maxQueries: IMAGE_CONFIG.maxQueriesPerRun,
  });
  const queries = imageQueryPlan.queries;
  const registry = loadImageRegistry();
  const providers = getEnabledProviders(providerApiKeys);
  const articleProfile = buildArticleSearchProfile({
    title: article.title,
    excerpt: article.excerpt || article.content || '',
    queries,
    section,
    topicId,
    entityHints: imageContext.entityHints,
    sourceHints: imageQueryPlan.sourceHints?.length ? imageQueryPlan.sourceHints : imageContext.sourceHints,
    sectionHints: [section],
    topicHints: [topicRecord?.label, topicId].filter(Boolean),
  });

  let bestOnlineDecision = null;
  const decisionLog = [];

  for (const query of queries.slice(0, IMAGE_CONFIG.maxQueriesPerRun)) {
    const providerResults = await Promise.allSettled(providers.map(async (provider) => ({
      providerId: provider.id,
      candidates: await provider.searchCandidates({
        query,
        article,
        section,
        perPage: IMAGE_CONFIG.searchPerQuery,
      }),
    })));

    const candidatePool = [];
    for (const result of providerResults) {
      if (result.status === 'rejected') {
        console.error(`[image] Provider query failed (${query}): ${result.reason?.message || result.reason}`);
        continue;
      }
      const payload = result.value;
      if (!payload?.candidates?.length) continue;
      candidatePool.push(...payload.candidates.map((candidate) => ({ ...candidate, providerId: payload.providerId })));
    }

    if (!candidatePool.length) {
      decisionLog.push({ query, status: 'no_candidates', providersTried: providers.map((provider) => provider.id) });
      continue;
    }

    const decision = selectProviderCandidate(candidatePool, registry, {
      query,
      section,
      topicId,
      articleSlug,
      articleProfile,
    });
    if (!decision) {
      console.log(`[image] No eligible fresh online candidate across providers for query="${query}"`);
      decisionLog.push({ query, status: 'no_eligible_candidate', candidateCount: candidatePool.length });
      continue;
    }

    decisionLog.push({
      query,
      status: 'ranked_candidate',
      provider: decision.candidate.provider,
      providerAssetId: decision.candidate.providerAssetId || null,
      finalScore: decision.fit.finalScore,
      articleRelevanceScore: decision.fit.articleRelevanceScore,
      assetQualityScore: decision.fit.assetQualityScore,
      tier: decision.fit.tier,
    });

    bestOnlineDecision = chooseBetterDecision(bestOnlineDecision, decision);
    if (shouldEarlyStopOnlineSelection(bestOnlineDecision, imageQueryPlan)) {
      console.log(`[image] Early stop with context-confirmed strong match query="${query}" provider=${bestOnlineDecision.candidate.provider} score=${bestOnlineDecision.fit.finalScore}`);
      break;
    }
  }

  if (bestOnlineDecision?.type === 'download_new') {
    const storedAsset = await persistProviderCandidate(bestOnlineDecision.candidate, {
      section,
      query: bestOnlineDecision.query,
      topicId,
      entityHints: imageContext.entityHints,
    });
    if (storedAsset) {
      const assetRecord = registerAssetRecord(registry, storedAsset);
      recordImageUsage(registry, {
        asset: assetRecord,
        articleSlug,
        articleTitle: article.title,
        section,
        topicId,
        query: bestOnlineDecision.query,
        selectionMode: `provider_download_new:${bestOnlineDecision.candidate.provider}:${bestOnlineDecision.fit.tier}`,
      });
      saveImageRegistry(registry);
      return buildResultFromAsset(assetRecord, article, {
        articleSlug,
        queryUsed: bestOnlineDecision.query,
        selectionMode: `provider_download_new:${bestOnlineDecision.candidate.provider}:${bestOnlineDecision.fit.tier}`,
        sectionId,
        topicId,
        articleProfile,
        auditTrail: buildImageAuditTrail({
          queries,
          providers,
          decisionLog,
          bestOnlineDecision,
          onlineAttempted: providers.length > 0,
        }),
      });
    }
  }

  const localAsset = findReusableAsset(registry, {
    articleSlug,
    section,
    topicId,
    title: article.title,
    excerpt: article.excerpt || article.content || '',
    queries,
    entityHints: imageContext.entityHints,
  });

  if (localAsset) {
    console.log(`[image] Reusing local asset after online miss: ${localAsset.assetKey}`);
    recordImageUsage(registry, {
      asset: localAsset,
      articleSlug,
      articleTitle: article.title,
      section,
      topicId,
      query: queries[0] || section,
      selectionMode: 'local_registry_reuse_after_online_miss',
    });
    saveImageRegistry(registry);
    return buildResultFromAsset(localAsset, article, {
      articleSlug,
      queryUsed: queries[0] || null,
      selectionMode: 'local_registry_reuse_after_online_miss',
      sectionId,
      topicId,
      articleProfile,
      auditTrail: buildImageAuditTrail({
        queries,
        providers,
        decisionLog,
        bestOnlineDecision,
        onlineAttempted: providers.length > 0,
        imageQueryPlan,
      }),
    });
  }

  const fallbackAlt = generateAltText(article.title, article.excerpt, section);
  return {
    articleSlug,
    imagePath: IMAGE_CONFIG.fallbackPath,
    altText: fallbackAlt,
    imageAlt: fallbackAlt,
    provider: 'fallback',
    sourceUrl: null,
    metadata: {
      width: 1600,
      height: 900,
      format: 'svg',
      section,
      section_id: sectionId,
      topic_id: topicId,
      queriesTried: queries,
      onlineAttempted: providers.length > 0,
      onlineCandidateFound: Boolean(bestOnlineDecision),
      auditTrail: buildImageAuditTrail({
        queries,
        providers,
        decisionLog,
        bestOnlineDecision,
        onlineAttempted: providers.length > 0,
        imageQueryPlan,
      }),
    },
  };
}

function extractImageSelectionContext(article, context = {}, { section, topicId, topicRecord, articleType } = {}) {
  const sourcePack = context?.sourcePack || {};
  const publishReadySources = Array.isArray(sourcePack.publishReadySources) && sourcePack.publishReadySources.length > 0
    ? sourcePack.publishReadySources
    : Array.isArray(sourcePack.sources)
      ? sourcePack.sources
      : [];
  const sourceHints = publishReadySources
    .slice(0, 4)
    .map((source) => source?.title)
    .filter(Boolean);
  const sourceEntityHints = publishReadySources
    .flatMap((source) => Array.isArray(source?.entities) ? source.entities : [])
    .filter(Boolean);
  const rawEntityHints = [
    ...(Array.isArray(context?.brief?.entities) ? context.brief.entities : []),
    ...(Array.isArray(context?.brief?.involvedParties) ? context.brief.involvedParties : []),
    ...sourceEntityHints,
    ...(Array.isArray(sourcePack?.entities) ? sourcePack.entities : []),
  ];
  const entityHints = normalizeStringArray(rawEntityHints)
    .filter((value) => !isBroadTopicAlias(value))
    .slice(0, 8);
  const geoHints = normalizeStringArray([
    context?.brief?.region,
    ...(Array.isArray(context?.brief?.geoHints) ? context.brief.geoHints : []),
    ...(Array.isArray(article?.metadata?.classification?.geoHints) ? article.metadata.classification.geoHints : []),
  ]).slice(0, 5);

  return {
    section,
    topicId,
    articleType,
    entityHints,
    sourceHints: normalizeStringArray(sourceHints).slice(0, 6),
    geoHints,
    publishReadySources,
  };
}

function chooseBetterDecision(previous, candidate) {
  if (!candidate) return previous;
  if (!previous) return candidate;
  return Number(candidate.score || 0) > Number(previous.score || 0) ? candidate : previous;
}
function getEnabledProviders({ pexelsApiKey, pixabayApiKey } = {}) {
  const providers = [];
  if (pexelsApiKey) {
    providers.push({
      id: 'pexels',
      searchCandidates: async ({ query, perPage }) => searchPexelsImageCandidates({
        query,
        apiKey: pexelsApiKey,
        perPage,
        orientation: 'landscape',
      }),
    });
  }
  if (pixabayApiKey) {
    providers.push({
      id: 'pixabay',
      searchCandidates: async ({ query, perPage }) => searchPixabayImageCandidates({
        query,
        apiKey: pixabayApiKey,
        perPage,
        orientation: 'landscape',
      }),
    });
  }
  return providers;
}

function buildImageQueryCascade({ title, excerpt, section, articleType, sectionId, topicId, topicRecord, entityHints = [], sourceHints = [], geoHints = [] }) {
  const combined = `${title} ${excerpt}`.toLowerCase();
  const titleTokens = extractMeaningfulTokens(title).slice(0, 6);
  const titlePhrase = titleTokens.slice(0, 4).join(' ');
  const entityPhrase = normalizeStringArray(entityHints).filter((value) => !isBroadTopicAlias(value)).slice(0, 2).join(' ');
  const sourcePhrase = normalizeStringArray(sourceHints).map((value) => String(value).replace(/\.(com|org|net|gov|co\.uk)$/i, '')).slice(0, 1).join(' ');
  const geoPhrase = normalizeStringArray(geoHints).slice(0, 1).join(' ');
  const topical = inferTopicalKeywords(combined).slice(0, 3);
  const topicAliases = [topicRecord?.label, ...(topicRecord?.aliases || [])]
    .filter(Boolean)
    .filter((value) => !isBroadTopicAlias(value))
    .slice(0, 4);
  const queries = [];

  const push = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    queries.push(normalized);
  };

  if (entityPhrase && titlePhrase) push(`${entityPhrase} ${titlePhrase} photo`);
  if (entityPhrase) push(`${entityPhrase} photo`);
  if (titleTokens.length >= 2) push(`${titleTokens.slice(0, 3).join(' ')} photo`);
  if (geoPhrase && entityPhrase) push(`${geoPhrase} ${entityPhrase} photo`);
  if (sourcePhrase && entityPhrase) push(`${sourcePhrase} ${entityPhrase} photo`);
  if (titlePhrase && topicAliases[0]) push(`${titlePhrase} ${topicAliases[0]} photo`);
  if (entityPhrase && topicAliases[0]) push(`${entityPhrase} ${topicAliases[0]} photo`);
  if (topicAliases.length > 0) topicAliases.slice(0, 2).forEach((value) => push(`${value} photo`));
  if (topical.length > 0) topical.forEach((value) => push(`${value} photo`));
  if (section && SECTION_FALLBACK_KEYWORDS[section]) SECTION_FALLBACK_KEYWORDS[section].forEach((value) => push(`${value} photo`));
  push(`${section || articleType} photo`);
  push('news photo');

  return Array.from(new Set(queries.filter(Boolean))).slice(0, IMAGE_CONFIG.maxQueriesPerRun);
}

function extractMeaningfulTokens(title) {
  return String(title || '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z0-9-]/g, ''))
    .filter((token) => token.length > 3)
    .filter((token) => !['breaking', 'claims', 'offered', 'denied', 'rises', 'tensions', 'today', 'latest', 'news'].includes(token.toLowerCase()));
}

function inferTopicalKeywords(text) {
  const topicalMap = [
    { keywords: ['court', 'judge', 'legal', 'lawsuit', 'verdict', 'copyright', 'piracy'], queries: ['courthouse exterior', 'courtroom', 'legal documents'] },
    { keywords: ['iran', 'tehran', 'israel', 'middle east', 'diplomacy', 'nuclear'], queries: ['middle east diplomacy', 'international diplomacy', 'government meeting'] },
    { keywords: ['trump', 'white house', 'president', 'administration'], queries: ['presidential press conference', 'government podium', 'white house exterior'] },
    { keywords: ['immigration', 'ice', 'border', 'deportation', 'tsa', 'airport', 'travel'], queries: ['airport security', 'transport terminal', 'government enforcement'] },
    { keywords: ['market', 'stocks', 'economy', 'earnings'], queries: ['stock market screen', 'financial district', 'business office'] },
    { keywords: ['ai', 'technology', 'software', 'chip'], queries: ['technology abstract', 'data center', 'computer hardware'] },
    { keywords: ['health', 'medical', 'hospital', 'fda'], queries: ['medical research', 'hospital corridor', 'healthcare team'] },
    { keywords: ['sports', 'game', 'team', 'match'], queries: ['sports stadium', 'athlete training', 'arena lights'] },
  ];

  for (const entry of topicalMap) {
    if (entry.keywords.some((keyword) => text.includes(keyword))) {
      return entry.queries;
    }
  }

  return ['editorial news photo'];
}

function isBroadTopicAlias(value) {
  const normalized = String(value || '').toLowerCase().trim();
  if (!normalized) return true;
  return [
    'news',
    'business',
    'technology',
    'tech',
    'health',
    'sports',
    'culture',
    'u s politics policy',
    'u.s. politics & policy',
    'world geopolitics',
    'climate & extreme weather',
    'economy & markets',
  ].includes(normalized.replace(/[^a-z0-9]+/g, ' ').trim());
}

function inferSectionFromText(title, excerpt) {
  const text = `${title} ${excerpt}`.toLowerCase();
  if (/(market|economy|business|earnings|stocks|refund|fee|travel)/.test(text)) return 'Business';
  if (/(tech|ai|software|chip|device|cloud|cyber)/.test(text)) return 'Tech';
  if (/(health|medical|drug|hospital|fda|disease|outbreak)/.test(text)) return 'Health';
  if (/(team|game|sports|league|player|tournament|championship)/.test(text)) return 'Sports';
  if (/(movie|film|music|celebrity|creator|youtube|instagram|tiktok|streaming|viral)/.test(text)) return 'Culture';
  return 'News';
}

function tokenize(text) {
  const stopwords = new Set(['news', 'photo', 'photos', 'editorial', 'image', 'images', 'latest', 'breaking', 'cover', 'screen', 'abstract']);
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !stopwords.has(token));
}

function scoreProviderPhoto(candidate, articleProfile) {
  const fit = downgradeUnconfirmedFit(computeContextualEditorialFit(candidate, articleProfile));
  const sizeScore = Math.round(((candidate.width || 0) * (candidate.height || 0)) / 10000);
  const rawTagsCount = Array.isArray(candidate.rawTags) ? candidate.rawTags.length : 0;
  const providerBonus = candidate.provider === 'pexels' ? 3 : candidate.provider === 'pixabay' ? 2 : 0;
  const scenicPenalty = fit.scenicPenalty ? 6 : 0;
  const genericPenalty = fit.genericPenalty ? 10 : 0;
  const score = (
    fit.finalScore * 1000
    + fit.articleRelevanceScore * 1200
    + fit.assetQualityScore * 800
    + fit.entityOverlap * 140
    + fit.overlap * 90
    + rawTagsCount * 4
    + providerBonus
    + sizeScore
    - scenicPenalty
    - genericPenalty
  );
  return { score, fit };
}

function selectProviderCandidate(candidates, registry, { query, section, topicId, articleProfile }) {
  const ranked = [];

  for (const candidate of candidates) {
    const enrichedCandidate = applyEnrichmentToAsset({
      ...candidate,
      sectionHints: [section].filter(Boolean),
      topicHints: [topicId].filter(Boolean),
      queryHistory: [candidate.searchQuery || query].filter(Boolean),
      tags: normalizeStringArray([...(candidate.rawTags || []), ...(Array.isArray(candidate.tags) ? candidate.tags : [])]),
    });

    const existingAsset = findExistingAssetForCandidate(registry, enrichedCandidate);

    if (existingAsset && assetFileExists(existingAsset)) {
      if (isAssetWithinCooldown(existingAsset)) {
        console.log(`[image] Rejecting recent duplicate asset=${existingAsset.assetKey}`);
      } else {
        console.log(`[image] Deferring reusable local asset until online options are exhausted: ${existingAsset.assetKey}`);
      }
      continue;
    }

    const scored = scoreProviderPhoto(enrichedCandidate, articleProfile);
    if (!scored || scored.score < 0) continue;
    if (!hasSemanticImageConfirmation(scored.fit) && scored.fit.tier !== 'strong') continue;
    if (scored.fit.tier === 'weak' && scored.fit.articleRelevanceScore < 18) continue;
    if (scored.fit.contextRequired && Number(scored.fit.contextOverlap || 0) === 0 && Number(scored.fit.sourceOverlap || 0) < 2) continue;

    ranked.push({
      type: 'download_new',
      candidate: enrichedCandidate,
      query,
      score: scored.score,
      fit: scored.fit,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}


function hasSemanticImageConfirmation(fit = {}) {
  return (fit.confirmationScore || 0) >= 20
    || (fit.titleOverlap || 0) >= 2
    || (fit.primaryEntityOverlap || 0) >= 1
    || (fit.contextOverlap || 0) >= 1
    || (fit.sourceOverlap || 0) >= 2
    || (fit.geoOverlap || 0) >= 1;
}

function shouldEarlyStopOnlineSelection(decision, imageQueryPlan = null) {
  if (!decision?.fit || decision.fit.tier !== 'strong') return false;
  const contextPhrases = Array.isArray(imageQueryPlan?.contextPhrases) ? imageQueryPlan.contextPhrases : [];
  const contextRequired = Boolean(decision.fit.contextRequired) || contextPhrases.length > 0;
  if (!contextRequired) return true;
  return Number(decision.fit.contextOverlap || 0) >= 1 || Number(decision.fit.sourceOverlap || 0) >= 2;
}

function downgradeUnconfirmedFit(fit = {}) {
  if (hasSemanticImageConfirmation(fit)) return fit;
  const articleRelevanceScore = Math.min(Number(fit.articleRelevanceScore || 0), 34);
  const finalScore = Math.min(Number(fit.finalScore || 0), 44);
  return {
    ...fit,
    articleRelevanceScore,
    finalScore,
    confirmedStrong: false,
    tier: finalScore >= 40 && articleRelevanceScore >= 24 ? 'usable' : 'weak',
    semanticConfirmationMissing: true,
  };
}

function sanitizePathSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'asset';
}

function deriveAssetFolderName(candidate) {
  if (candidate.providerAssetId) {
    return sanitizePathSegment(candidate.providerAssetId);
  }
  return crypto.createHash('sha1').update(String(candidate.sourceDownloadUrl || candidate.sourcePageUrl || candidate.altText || 'asset')).digest('hex').slice(0, 16);
}

function normalizeFormat(format) {
  const lowered = String(format || 'jpg').toLowerCase();
  if (lowered === 'jpeg') return 'jpg';
  if (['jpg', 'png', 'webp', 'svg'].includes(lowered)) return lowered;
  return 'jpg';
}

async function persistProviderCandidate(candidate, { section, query, topicId, entityHints = [] }) {
  try {
    const providerSegment = sanitizePathSegment(candidate.provider || 'provider');
    const folderSegment = deriveAssetFolderName(candidate);
    const extension = normalizeFormat(candidate.format);
    const assetDir = path.resolve(PROJECT_ROOT, 'src/assets/images/library', providerSegment, folderSegment);
    const fileRelativePath = path.posix.join('src/assets/images/library', providerSegment, folderSegment, `cover.${extension}`);
    const localPath = `${IMAGE_CONFIG.libraryBase}/${providerSegment}/${folderSegment}/cover.${extension}`;
    const metadataRelativePath = path.posix.join('src/assets/images/library', providerSegment, folderSegment, 'metadata.json');
    const localFilePath = path.resolve(PROJECT_ROOT, fileRelativePath);
    const metadataFilePath = path.resolve(PROJECT_ROOT, metadataRelativePath);

    if (!fs.existsSync(assetDir)) {
      fs.mkdirSync(assetDir, { recursive: true });
    }

    if (!fs.existsSync(localFilePath)) {
      const response = await fetch(candidate.sourceDownloadUrl);
      if (!response.ok) {
        console.warn(`[image] Failed to download candidate: ${response.status} ${response.statusText}`);
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localFilePath, buffer);
    }

    const enrichedCandidate = applyEnrichmentToAsset({
      ...candidate,
      sectionHints: [section].filter(Boolean),
      topicHints: [topicId].filter(Boolean),
      queryHistory: [query, candidate.searchQuery].filter(Boolean),
      tags: normalizeStringArray([topicId, ...entityHints, ...(candidate.rawTags || []), ...(Array.isArray(candidate.tags) ? candidate.tags : [])]),
    });

    const metadataPayload = {
      provider: enrichedCandidate.provider,
      providerAssetId: enrichedCandidate.providerAssetId || null,
      sourcePageUrl: enrichedCandidate.sourcePageUrl || null,
      sourceDownloadUrl: enrichedCandidate.sourceDownloadUrl || null,
      authorName: enrichedCandidate.authorName || null,
      authorUrl: enrichedCandidate.authorUrl || null,
      license: enrichedCandidate.license || null,
      altText: enrichedCandidate.altText || null,
      width: enrichedCandidate.width || null,
      height: enrichedCandidate.height || null,
      format: extension,
      sectionHint: section || null,
      topicId: topicId || null,
      query: query || null,
      rawTags: enrichedCandidate.rawTags || [],
      entityHints: enrichedCandidate.entityHints || [],
      sceneType: enrichedCandidate.sceneType || null,
      geoHints: enrichedCandidate.geoHints || [],
      visualType: enrichedCandidate.visualType || null,
      editorialFitScore: enrichedCandidate.editorialFitScore ?? null,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metadataFilePath, JSON.stringify(metadataPayload, null, 2), 'utf-8');

    return {
      assetKey: enrichedCandidate.assetKey || `${enrichedCandidate.provider}:${folderSegment}`,
      provider: enrichedCandidate.provider,
      providerAssetId: enrichedCandidate.providerAssetId || null,
      sourcePageUrl: enrichedCandidate.sourcePageUrl || null,
      sourceDownloadUrl: enrichedCandidate.sourceDownloadUrl || null,
      authorName: enrichedCandidate.authorName || null,
      authorUrl: enrichedCandidate.authorUrl || null,
      license: enrichedCandidate.license || null,
      altText: enrichedCandidate.altText || null,
      width: enrichedCandidate.width || 1600,
      height: enrichedCandidate.height || 900,
      format: extension,
      localPath,
      fileRelativePath,
      metadataRelativePath,
      sectionHints: [section].filter(Boolean),
      topicHints: [topicId].filter(Boolean),
      queryHistory: [query, enrichedCandidate.searchQuery].filter(Boolean),
      tags: normalizeStringArray([topicId, ...entityHints, ...(enrichedCandidate.rawTags || []), ...(Array.isArray(enrichedCandidate.tags) ? enrichedCandidate.tags : [])]),
      entityHints: enrichedCandidate.entityHints || [],
      sceneType: enrichedCandidate.sceneType || null,
      geoHints: enrichedCandidate.geoHints || [],
      visualType: enrichedCandidate.visualType || null,
      editorialFitScore: enrichedCandidate.editorialFitScore ?? null,
      firstSeenAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      status: 'ready',
      provenance: 'provider_download',
    };
  } catch (error) {
    console.warn(`[image] Failed to persist provider candidate: ${error.message}`);
    return null;
  }
}

function buildResultFromAsset(asset, article, { articleSlug, queryUsed, selectionMode, sectionId, topicId, articleProfile, auditTrail = null }) {
  const altText = generateAltText(article.title, article.excerpt, asset.altText);
  const fit = downgradeUnconfirmedFit(computeContextualEditorialFit(asset, articleProfile || buildArticleSearchProfile({ title: article.title, excerpt: article.excerpt || article.content || '' })));
  return {
    articleSlug,
    imagePath: asset.localPath,
    altText,
    imageAlt: altText,
    provider: asset.provider,
    sourceUrl: asset.sourcePageUrl || asset.sourceDownloadUrl || null,
    metadata: {
      assetKey: asset.assetKey,
      width: asset.width || 1600,
      height: asset.height || 900,
      format: asset.format || 'jpg',
      queryUsed: queryUsed || null,
      authorName: asset.authorName || null,
      selectionMode,
      section_id: sectionId || null,
      topic_id: topicId || null,
      entityHints: asset.entityHints || [],
      sceneType: asset.sceneType || null,
      geoHints: asset.geoHints || [],
      visualType: asset.visualType || null,
      editorialFitScore: fit.finalScore,
      articleRelevanceScore: fit.articleRelevanceScore,
      assetQualityScore: fit.assetQualityScore,
      relevanceTier: fit.tier,
      baseEditorialFitScore: asset.editorialFitScore ?? null,
      semanticConfirmationMissing: Boolean(fit.semanticConfirmationMissing),
      auditTrail: auditTrail || null,
    },
  };
}

function buildImageAuditTrail({ queries = [], providers = [], decisionLog = [], bestOnlineDecision = null, onlineAttempted = false, imageQueryPlan = null } = {}) {
  return {
    queriesTried: Array.isArray(queries) ? queries.slice(0, IMAGE_CONFIG.maxQueriesPerRun) : [],
    providersTried: Array.isArray(providers) ? providers.map((provider) => provider.id) : [],
    decisionLog: Array.isArray(decisionLog) ? decisionLog : [],
    imageQueryPlan: imageQueryPlan ? {
      entityHints: imageQueryPlan.entityHints || [],
      geoHints: imageQueryPlan.geoHints || [],
      sourceHints: imageQueryPlan.sourceHints || [],
      contextPhrases: imageQueryPlan.contextPhrases || [],
      debug: imageQueryPlan.debug || null,
    } : null,
    bestOnlineDecision: bestOnlineDecision ? {
      query: bestOnlineDecision.query || null,
      provider: bestOnlineDecision.candidate?.provider || null,
      providerAssetId: bestOnlineDecision.candidate?.providerAssetId || null,
      finalScore: bestOnlineDecision.fit?.finalScore ?? null,
      articleRelevanceScore: bestOnlineDecision.fit?.articleRelevanceScore ?? null,
      assetQualityScore: bestOnlineDecision.fit?.assetQualityScore ?? null,
      tier: bestOnlineDecision.fit?.tier || null,
    } : null,
    onlineAttempted: Boolean(onlineAttempted),
  };
}

function generateAltText(title, excerpt, photoAlt) {
  const cleanTitle = String(title || 'News article').replace(/["']/g, '').trim();
  const titleTokens = tokenize(`${title} ${excerpt}`).slice(0, 8);
  const normalizedPhotoAlt = String(photoAlt || '').trim();
  if (normalizedPhotoAlt.length > 5) {
    const lowerAlt = normalizedPhotoAlt.toLowerCase();
    const overlap = titleTokens.filter((token) => lowerAlt.includes(token)).length;
    if (overlap > 0) {
      return normalizedPhotoAlt;
    }
  }
  return `Illustration for ${cleanTitle}`;
}

function normalizeStringArray(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

export function bindImageToFrontmatter(content, imagePath) {
  if (!imagePath || !content.startsWith('---\n')) return content;
  const lines = content.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return content;
  const frontmatterLines = lines.slice(1, endIndex);
  const imageLine = `image: ${imagePath}`;
  const hasImage = frontmatterLines.some((line) => line.trim().startsWith('image:'));
  const updated = hasImage
    ? frontmatterLines.map((line) => (line.trim().startsWith('image:') ? imageLine : line))
    : [...frontmatterLines, imageLine];
  return ['---', ...updated, '---', ...lines.slice(endIndex + 1)].join('\n');
}
