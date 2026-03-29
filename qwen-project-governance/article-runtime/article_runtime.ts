// File: qwen-project-governance/article-runtime/article_runtime.ts
// Purpose: Generate real article drafts from research packs using OpenAI.
// Input: Parsed source content OR URLs to fetch + brief key questions
// Output: Final article markdown ready for publication
// Requires: OPENAI_API_KEY environment variable
// Optional: source-fetching module for URL-based input

import { extractEvidence, type ParsedSourceContent, type EvidenceExtractionResult } from '../evidence-extraction/evidence_extraction.js';
import { generateResearchPack, type ResearchPack } from '../evidence-extraction/research_pack.js';
import type { FetchResult } from '../source-fetching/source_fetching.js';
import {
  runExtractionQualityGate,
  type ExtractionQualitySummary,
  type CleanEvidencePackSummary,
  type RejectedExtractionSource,
} from '../source-fetching/extraction_quality_gate.js';
import { assembleSourcePackLive, toSourceUrls, type SourcePackAssemblyConfig, type SourcePackAssemblyResult } from '../source-pack/source_pack_assembly.js';
import { formatPublishedArticle, type ArticleDraft as PublisherArticleDraft, type PublishSourceLink } from '../publisher/publisher.js';
import type { ValidatedSource } from '../source-validation/source_validation.js';
import {
  routeAuthorPersona,
  type AuthorRoutingDecision,
  type CanonicalArticleType,
} from './author_personas.js';
import type { SectionId, TopicId } from '../../src/utils/taxonomy-contract.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRunOutputsDir } from '../runtime/runtime_paths.js';

export interface ArticleDraft {
  topic_id: string;
  article_id: string;
  title: string;
  generated_at: string;
  content: string;
  word_count: number;
  evidence_used: string[];  // Evidence IDs referenced
  sources_cited: string[];  // Source URLs cited
  author_name: string;
  author_persona_id: string;
  routed_article_type: CanonicalArticleType;
  routing_rationale: string[];
  tags?: string[];
}

export interface EditorPass {
  pass_number: number;
  stage: 'structural_editor' | 'fact_source_checker' | 'trust_policy_editor' | 'reader_editor' | 'chief_editor';
  changes_made: string[];
  quality_score: number;  // 1-10
  approved: boolean;
  notes: string;
}

export interface StructuralReviewArtifact {
  stage: 'structural_editor';
  improvements_applied: string[];
  removed_repetition_count: number;
  clarity_notes: string[];
  fallback_used: boolean;
}

export interface FactSourceReviewArtifact {
  stage: 'fact_source_checker';
  weak_claims_softened: string[];
  unsupported_urls_removed: string[];
  revisions_summary: string[];
}

export interface TrustPolicyReviewArtifact {
  stage: 'trust_policy_editor';
  risky_phrases_softened: string[];
  policy_sensitive_revisions: string[];
  trust_notes: string[];
}

export type SourceQualityTier = 'strong' | 'moderate' | 'weak';

export interface SourceQualityEntry {
  url: string;
  title: string;
  domain: string;
  source_type: string;
  credibility: number;
  evidence_count: number;
  tier: SourceQualityTier;
  rationale: string[];
}

export interface SourceQualityReviewArtifact {
  stage: 'source_quality_review';
  entries: SourceQualityEntry[];
  summary: {
    total_sources: number;
    strong_sources: number;
    moderate_sources: number;
    weak_sources: number;
    unique_domains: number;
    source_type_mix: Record<string, number>;
    weak_evidence_share: number;
    strong_evidence_share: number;
    primary_like_evidence_share: number;
    primary_like_sources: number;
  };
  concerns: string[];
}

export interface SourceQualityGateResult {
  gate: 'source_quality_required';
  valid: boolean;
  total_sources: number;
  strong_sources: number;
  moderate_sources: number;
  weak_sources: number;
  unique_domains: number;
  weak_evidence_share: number;
  strong_evidence_share: number;
  primary_like_evidence_share: number;
  allowed_weak_evidence_share: number;
  minimum_primary_like_evidence_share: number;
  minimum_unique_domains: number;
  minimum_strong_or_moderate_sources: number;
  failure_reasons: string[];
}

export type ChiefEditorDecision = 'publish' | 'revise' | 'reject';

export type ClaimSupportStatus = 'supported' | 'partially_supported' | 'unsupported' | 'opinion_or_analysis';

export interface ClaimMapEntry {
  id: string;
  claim_text: string;
  support_status: ClaimSupportStatus;
  matching_score: number;
  claim_specificity: 'high' | 'medium' | 'low';
  grounding_signal: 'evidence_match' | 'source_url_only' | 'opinion_pattern' | 'none';
  supporting_evidence_ids: string[];
  supporting_source_urls: string[];
  weakness_or_uncertainty_note?: string;
}

export interface ClaimMapArtifact {
  stage: 'claim_map';
  entries: ClaimMapEntry[];
  summary: {
    total_claims: number;
    supported: number;
    partially_supported: number;
    unsupported: number;
    opinion_or_analysis: number;
  };
  derived_from: 'source_pack_pre_draft' | 'final_stabilized_draft';
}

export interface ClaimMapGateResult {
  gate: 'claim_map_required';
  valid: boolean;
  total_claims: number;
  factual_claims: number;
  weak_claims: number;
  allowed_weak_claims: number;
  supported_factual_ratio: number;
  minimum_supported_factual_ratio: number;
  unsupported_claims: number;
  allowed_unsupported_claims: number;
  failure_reasons: string[];
}

export interface ChiefEditorArtifact {
  stage: 'chief_editor';
  decision: ChiefEditorDecision;
  rationale: string[];
  blocking_issues: string[];
  reviewed_stages: Array<'author' | 'structural_editor' | 'fact_source_checker' | 'trust_policy_editor' | 'reader_editor'>;
}

export interface ArticleRuntimeResult {
  topic_id: string;
  article_id: string;
  fetch_results?: FetchResult[];  // If URLs were fetched
  source_admission_summary?: {
    considered_urls: number;
    admitted_sources: number;
    rejected_before_extraction: number;
    unique_domains: number;
    role_mix: Record<string, number>;
  };
  extraction_quality_summary?: ExtractionQualitySummary;
  clean_evidence_pack_summary?: CleanEvidencePackSummary;
  extraction_rejected_sources?: RejectedExtractionSource[];
  evidence_result: EvidenceExtractionResult;
  research_pack: ResearchPack;
  pre_author_source_gate: PreAuthorSourceSufficiencyGate;
  pre_draft_claim_map: ClaimMapArtifact;
  draft: ArticleDraft;
  source_quality_review: SourceQualityReviewArtifact;
  source_quality_gate: SourceQualityGateResult;
  structural_review: StructuralReviewArtifact;
  fact_source_review: FactSourceReviewArtifact;
  trust_policy_review: TrustPolicyReviewArtifact;
  claim_map: ClaimMapArtifact;
  claim_map_gate: ClaimMapGateResult;
  chief_editor_review: ChiefEditorArtifact;
  author_routing: AuthorRoutingDecision;
  editor_passes: EditorPass[];
  final_article: string;
  total_tokens_used: number;
  model_api_trace: RuntimeModelApiTraceEntry[];
  token_usage_summary: RuntimeTokenUsageSummary;
  generation_timestamp: string;
}

export interface RuntimeModelApiTraceEntry {
  stage_name: string;
  provider_api: string;
  model: string;
  configured_max_tokens: number;
  temperature: number;
  attempt: number;
  success: boolean;
  fallback_used: boolean;
  usage_available: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  estimated_total_tokens?: number;
  error?: string;
}

export interface RuntimeTokenUsageSummary {
  exact_prompt_tokens: number;
  exact_completion_tokens: number;
  exact_total_tokens: number;
  estimated_total_tokens: number;
  usage_available_for_all_calls: boolean;
}

export interface RuntimePublishOptions {
  output_dir?: string;
  title?: string;
  excerpt?: string;
  category?: string;
  author?: string;
  image?: string;
  tags?: string[];
  allow_overwrite?: boolean;
  allow_unguarded_publish?: boolean;
  // Canonical taxonomy fields (new)
  article_type?: CanonicalArticleType;
  section_id?: SectionId;
  topic_id?: TopicId;
}

export interface RuntimePublishResult {
  filename: string;
  output_path: string;
  content: string;
}

export interface AuthorRuntimeContext {
  category?: string;
  author_override?: string;
}

export interface LocalDownstreamValidationInput {
  topic: string;
  topic_id: string;
  article_id: string;
  draft_content: string;
  source_urls: string[];
  category?: string;
  key_questions?: string[];
  author_name?: string;
  author_persona_id?: string;
  routed_article_type?: CanonicalArticleType;
}

export interface RuntimeSourcePackAssemblyResult {
  source_pack_result: SourcePackAssemblyResult;
  source_urls: string[];
}

export interface EditorialArtifactPaths {
  source_quality_review_path: string;
  structural_review_path: string;
  fact_source_review_path: string;
  trust_policy_review_path: string;
  claim_map_path: string;
  chief_editor_review_path: string;
}

export interface PreAuthorSourceSufficiencyGate {
  gate: 'pre_author_source_sufficiency';
  valid: boolean;
  total_sources: number;
  total_evidence_items: number;
  unique_domains: number;
  source_type_diversity: number;
  key_question_coverage_ratio: number;
  primary_like_sources: number;
  strong_sources: number;
  moderate_sources: number;
  weak_sources: number;
  high_credibility_sources: number;
  average_relevance_score: number;
  minimum_total_sources: number;
  minimum_total_evidence_items: number;
  minimum_unique_domains: number;
  minimum_source_type_diversity: number;
  minimum_key_question_coverage_ratio: number;
  minimum_high_credibility_sources: number;
  maximum_weak_source_share: number;
  failure_reasons: string[];
}

export interface RevisionRepairPacket {
  chief_editor_blockers: string[];
  claim_failures: string[];
  source_quality_concerns: string[];
  fact_source_issues: string[];
  unsupported_claims: ClaimMapEntry[];
  partially_supported_claims: ClaimMapEntry[];
  known_source_urls: string[];
  evidence_anchors: Array<{
    id: string;
    claim: string;
    excerpt: string;
    source_url: string;
    source_title: string;
  }>;
  claim_repair_directives: Array<{
    claim_text: string;
    support_status: 'unsupported' | 'partially_supported';
    recommended_actions: Array<'delete' | 'narrow' | 're_attribute' | 'replace_with_supported_evidence'>;
    supporting_evidence_ids: string[];
    supporting_source_urls: string[];
    reason: string;
  }>;
  paragraph_repair_targets: Array<{
    paragraph_index: number;
    paragraph_excerpt: string;
    issue: 'unsupported_fragment' | 'partial_fragment' | 'broad_without_anchor';
    recommended_actions: Array<'delete' | 'narrow' | 're_attribute' | 'replace_with_supported_evidence' | 'split'>;
    supporting_source_urls: string[];
    supporting_evidence_ids: string[];
  }>;
}

/**
 * Generate article from URLs using OpenAI.
 * Fetches URLs, extracts content, generates article.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function generateArticleFromUrls(
  topic: string,
  topicId: string,
  articleId: string,
  urls: string[],
  validatedSources: ValidatedSource[],
  keyQuestions: string[],
  openAiApiKey?: string,
  authorContext: AuthorRuntimeContext = {},
  whitelistTrusted: boolean = false  // NEW: for whitelist-trusted topics
): Promise<ArticleRuntimeResult> {
  const normalizedUrls = Array.from(
    new Set(
      urls
        .map((url) => url.trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .map((url) => normalizeUrlForMatch(url))
    )
  ).filter((url) => Boolean(url));
  if (!normalizedUrls.length) {
    throw new Error('SOURCE_PACK_FAILED: no valid source URLs provided after source admission.');
  }

  const byUrl = new Map<string, ValidatedSource>();
  for (const source of validatedSources) {
    const direct = normalizeUrlForMatch(source.url);
    const canonical = normalizeUrlForMatch(source.canonical_url || source.url);
    if (direct && !byUrl.has(direct)) {
      byUrl.set(direct, source);
    }
    if (canonical && !byUrl.has(canonical)) {
      byUrl.set(canonical, source);
    }
  }

  const extractionCandidates = normalizedUrls.map((url) => {
    const source = byUrl.get(url);
    return {
      url,
      canonical_url: source?.canonical_url || source?.url || url,
      title: source?.title || url,
      snippet: source?.snippet || '',
      display_domain: source?.display_domain || safeDomain(url),
      domain_class: source?.domain_class || mapOriginClassToDomainClass(source?.source_origin_class),
      source_role: source?.source_role || 'reporting',
      event_match_score: Number(source?.event_match_score || source?.relevance_score || 5),
      relevance_score: Number(source?.relevance_score || source?.event_match_score || 5),
    };
  });

  const admittedUrlSet = new Set(
    validatedSources
      .filter((source) => source.admission_decision !== 'reject' && source.source_role !== 'reject')
      .flatMap((source) => [normalizeUrlForMatch(source.url), normalizeUrlForMatch(source.canonical_url || source.url)])
      .filter((value): value is string => Boolean(value))
  );
  const admittedSources = extractionCandidates.filter((candidate) => admittedUrlSet.has(candidate.url)).length;
  const roleMix = validatedSources.reduce<Record<string, number>>((acc, source) => {
    const key = source.source_role || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const uniqueDomains = new Set(
    validatedSources
      .map((source) => safeDomain(source.canonical_url || source.url))
      .filter((domain) => Boolean(domain))
  ).size;

  const extractionPolicyThresholds = resolveExtractionPolicyThresholds(topic);
  const extractionGate = await runExtractionQualityGate(topic, keyQuestions, extractionCandidates, {
    whitelistTrusted: whitelistTrusted,
  });
  if (extractionGate.failure_mode === 'extraction_failed') {
    throw new Error(
      `EXTRACTION_FAILED: ${extractionGate.summary.policy_failures.join(' | ') || 'All extraction candidates were rejected.'}`
    );
  }
  if (extractionGate.failure_mode === 'evidence_pack_failed') {
    throw new Error(
      `EVIDENCE_PACK_FAILED: ${extractionGate.summary.policy_failures.join(' | ') || 'Clean evidence pack did not satisfy policy.'}`
    );
  }
  if (!extractionGate.parsed_contents.length) {
    throw new Error('EXTRACTION_FAILED: no policy-compliant extracted sources survived quality gating.');
  }

  const runtimeResult = await generateArticle(
    topic,
    topicId,
    articleId,
    extractionGate.parsed_contents,
    validatedSources,
    keyQuestions,
    openAiApiKey,
    extractionGate.fetch_results,
    authorContext
  );

  return {
    ...runtimeResult,
    source_admission_summary: {
      considered_urls: extractionCandidates.length,
      admitted_sources: admittedSources,
      rejected_before_extraction: Math.max(0, extractionCandidates.length - admittedSources),
      unique_domains: uniqueDomains,
      role_mix: roleMix,
    },
    extraction_quality_summary: extractionGate.summary,
    clean_evidence_pack_summary: extractionGate.clean_evidence_pack_summary,
    extraction_rejected_sources: extractionGate.rejected_sources,
  };
}

/**
 * Assemble source-pack URLs from topic + questions using registry-first collection.
 * Returned URLs are directly compatible with generateArticleFromUrls().
 */
export async function assembleSourceUrlsForTopic(
  topic: string,
  topicId: string,
  keyQuestions: string[],
  requiredSources: string[] = [],
  assemblyConfig: SourcePackAssemblyConfig = {}
): Promise<RuntimeSourcePackAssemblyResult> {
  const sourcePackResult = await assembleSourcePackLive(
    topic,
    topicId,
    keyQuestions,
    requiredSources,
    assemblyConfig
  );

  return {
    source_pack_result: sourcePackResult,
    source_urls: toSourceUrls(sourcePackResult),
  };
}

/**
 * Generate article from parsed content using OpenAI.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function generateArticle(
  topic: string,
  topicId: string,
  articleId: string,
  parsedContents: ParsedSourceContent[],
  validatedSources: ValidatedSource[],
  keyQuestions: string[],
  openAiApiKey?: string,
  fetchResults?: FetchResult[],
  authorContext: AuthorRuntimeContext = {}
): Promise<ArticleRuntimeResult> {
  const apiKey = openAiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const generationTimestamp = new Date().toISOString();
  const modelTrace: RuntimeModelApiTraceEntry[] = [];

  // Step 1: Extract evidence from parsed content
  const evidenceResult = extractEvidence(topicId, validatedSources, parsedContents, keyQuestions);
  if (evidenceResult.total_evidence_items === 0) {
    throw new Error('Pipeline guard: evidence extraction returned zero items; stopping article generation.');
  }

  // Step 2: Generate research pack
  const researchPack = generateResearchPack(topic, topicId, keyQuestions, evidenceResult, validatedSources);
  const sourceQuality = evaluateSourceQuality(researchPack);
  const preAuthorGate = evaluatePreAuthorSourceSufficiency(validatedSources, researchPack);
  const authorRouting = routeAuthorPersona(
    {
      topic,
      category: authorContext.category,
      key_questions: keyQuestions,
      source_types: validatedSources.map((source) => source.source_type),
      source_count: validatedSources.length,
      high_credibility_count: validatedSources.filter((source) => source.credibility_score >= 4).length,
    },
    authorContext.author_override
  );

  // Step 3: Build pre-draft claim map directly from source pack evidence.
  const preDraftClaimMap = buildPreDraftClaimMapFromSourcePack(researchPack);

  // Step 4: Generate article draft from claim map + source pack.
  const draft = await generateDraftWithOpenAI(
    topic,
    articleId,
    researchPack,
    apiKey,
    authorRouting,
    preDraftClaimMap,
    modelTrace
  );
  ensureDeterministicSourceCitations(draft, researchPack, getTargetCitationCount(researchPack));

  // Step 5: Deterministic structural cleanup only (one-writer mode; no second model call).
  const structural = runStructuralEditorPassDeterministic(draft, researchPack);
  draft.content = preserveEditorialLength(draft.content, structural.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  // Step 6: Fact / Source Checker stage
  const factSource = runFactSourceCheckerPass(draft.content, researchPack);
  draft.content = preserveEditorialLength(draft.content, factSource.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  // Step 7: Trust / Policy Editor stage
  const trustPolicy = runTrustPolicyEditorPass(draft.content);
  draft.content = preserveEditorialLength(draft.content, trustPolicy.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  // Step 7.5: Final reader cleanup pass (factual-preserving readability tighten).
  const readerEditor = runFinalReadabilityPass(draft.content, draft.title, draft.routed_article_type);
  draft.content = preserveEditorialLength(draft.content, readerEditor.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  // S17/S18: one last sentence-level grounding hardening pass before claim-map extraction.
  draft.content = preserveEditorialLength(
    draft.content,
    applyPreClaimMapSourceUrlOnlyHardening(draft.content, researchPack),
    draft.routed_article_type
  );
  draft.word_count = draft.content.split(/\s+/).length;

  // Recompute source/evidence references after editor-chain revisions.
  const revisedSources = extractSourceReferences(draft.content, researchPack);
  const revisedEvidence = extractEvidenceReferences(draft.content, researchPack);
  if (revisedSources.length > 0) {
    draft.sources_cited = revisedSources;
  }
  draft.evidence_used = revisedEvidence;

  // Step 8: Claim Map stage (derived from stabilized draft content)
  const claimMap = buildClaimMapFromStabilizedDraft(draft.content, researchPack);
  const claimMapGate = evaluateClaimMapGate(claimMap);

  // Step 9: Chief Editor decision stage
  const chiefEditor = runChiefEditorPass(
    draft,
    researchPack,
    trustPolicy.artifact,
    claimMapGate,
    sourceQuality.gate,
    getTargetCitationCount(researchPack)
  );

  const editorPasses: EditorPass[] = [structural.pass, factSource.pass, trustPolicy.pass, readerEditor.pass, chiefEditor.pass];

  // Step 10: Generate final article
  const finalArticle = formatFinalArticle(draft, editorPasses);
  const finalSources = extractSourceReferences(finalArticle, researchPack);
  const finalEvidence = extractEvidenceReferences(finalArticle, researchPack);
  draft.sources_cited = finalSources.length > 0 ? finalSources : draft.sources_cited;
  draft.evidence_used = finalEvidence;

  return {
    topic_id: topicId,
    article_id: articleId,
    fetch_results: fetchResults,
    evidence_result: evidenceResult,
    research_pack: researchPack,
    pre_author_source_gate: preAuthorGate,
    pre_draft_claim_map: preDraftClaimMap,
    draft,
    source_quality_review: sourceQuality.review,
    source_quality_gate: sourceQuality.gate,
    structural_review: structural.artifact,
    fact_source_review: factSource.artifact,
    trust_policy_review: trustPolicy.artifact,
    claim_map: claimMap,
    claim_map_gate: claimMapGate,
    chief_editor_review: chiefEditor.artifact,
    author_routing: authorRouting,
    editor_passes: editorPasses,
    final_article: finalArticle,
    total_tokens_used: estimateTokens(researchPack, draft),
    model_api_trace: modelTrace,
    token_usage_summary: summarizeTokenUsage(modelTrace, estimateTokens(researchPack, draft)),
    generation_timestamp: generationTimestamp,
  };
}

function buildPreDraftClaimMapFromSourcePack(researchPack: ResearchPack): ClaimMapArtifact {
  const entries = getPriorityEvidenceForDraft(researchPack, 18).map((item, index) => {
    const hasSource = Boolean(item.source_url);
    const confidence = evidenceConfidenceScore(item.confidence);
    const supportStatus: ClaimSupportStatus = !hasSource
      ? 'unsupported'
      : confidence >= 8
      ? 'supported'
      : confidence >= 6
      ? 'partially_supported'
      : 'opinion_or_analysis';

    return {
      id: `PC${String(index + 1).padStart(3, '0')}`,
      claim_text: compactPromptText(item.claim, 260),
      support_status: supportStatus,
      matching_score: Number(Math.max(0, Math.min(1, confidence / 10)).toFixed(3)),
      claim_specificity: assessClaimSpecificity(item.claim, tokenizeForOverlap(item.claim).size),
      grounding_signal: hasSource ? 'evidence_match' : 'none',
      supporting_evidence_ids: [item.id],
      supporting_source_urls: hasSource ? [item.source_url] : [],
      weakness_or_uncertainty_note:
        supportStatus === 'partially_supported'
          ? 'Evidence exists but scope should stay narrow.'
          : supportStatus === 'opinion_or_analysis'
          ? 'Use analysis framing only unless stronger evidence appears.'
          : supportStatus === 'unsupported'
          ? 'No valid source URL found in source pack.'
          : undefined,
    } satisfies ClaimMapEntry;
  });

  const summary = {
    total_claims: entries.length,
    supported: entries.filter((entry) => entry.support_status === 'supported').length,
    partially_supported: entries.filter((entry) => entry.support_status === 'partially_supported').length,
    unsupported: entries.filter((entry) => entry.support_status === 'unsupported').length,
    opinion_or_analysis: entries.filter((entry) => entry.support_status === 'opinion_or_analysis').length,
  };

  return {
    stage: 'claim_map',
    entries,
    summary,
    derived_from: 'source_pack_pre_draft',
  };
}

/**
 * Run a cheap deterministic downstream validation pass from fixed local inputs.
 * This intentionally avoids discovery/fetch/OpenAI and only exercises the downstream editorial chain.
 */
export function runDeterministicDownstreamValidation(input: LocalDownstreamValidationInput): ArticleRuntimeResult {
  const generationTimestamp = new Date().toISOString();
  const sourceUrls = Array.from(new Set((input.source_urls || []).filter((url) => /^https?:\/\//i.test(url))));
  const keyQuestions = (input.key_questions && input.key_questions.length > 0)
    ? input.key_questions.slice(0, 4)
    : [
        `What happened in ${input.topic}?`,
        `Why does ${input.topic} matter?`,
        `Which details are clearly supported by available sources?`,
        `What uncertainty remains around ${input.topic}?`,
      ];

  const validatedSources = buildSyntheticValidatedSources(sourceUrls);
  const researchPack = buildSyntheticResearchPackFromDraft(input.topic, input.topic_id, keyQuestions, input.draft_content, validatedSources);
  const sourceQuality = evaluateSourceQuality(researchPack);
  const preAuthorGate = evaluatePreAuthorSourceSufficiency(validatedSources, researchPack);
  const preDraftClaimMap = buildPreDraftClaimMapFromSourcePack(researchPack);
  const authorRouting = routeAuthorPersona(
    {
      topic: input.topic,
      category: input.category,
      key_questions: keyQuestions,
      source_types: validatedSources.map((source) => source.source_type),
      source_count: validatedSources.length,
      high_credibility_count: validatedSources.filter((source) => source.credibility_score >= 4).length,
    },
    input.author_name
  );

  const baseTitle = input.topic;
  const normalizedDraft = polishGeneratedDraft(input.draft_content || '', baseTitle, researchPack, authorRouting.article_type);
  const draft: ArticleDraft = {
    topic_id: input.topic_id,
    article_id: input.article_id,
    title: baseTitle,
    generated_at: generationTimestamp,
    content: normalizedDraft,
    word_count: normalizedDraft.split(/\s+/).length,
    evidence_used: extractEvidenceReferences(normalizedDraft, researchPack),
    sources_cited: extractSourceReferences(normalizedDraft, researchPack),
    author_name: input.author_name || authorRouting.persona.display_name,
    author_persona_id: input.author_persona_id || authorRouting.persona.id,
    routed_article_type: input.routed_article_type || authorRouting.article_type,
    routing_rationale: authorRouting.rationale,
    tags: deriveDraftTags(researchPack, authorRouting.article_type, input.topic),
  };
  ensureDeterministicSourceCitations(draft, researchPack, getTargetCitationCount(researchPack));

  const structural = runStructuralEditorPassDeterministic(draft, researchPack);
  draft.content = preserveEditorialLength(draft.content, structural.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  const factSource = runFactSourceCheckerPass(draft.content, researchPack);
  draft.content = preserveEditorialLength(draft.content, factSource.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  const trustPolicy = runTrustPolicyEditorPass(draft.content);
  draft.content = preserveEditorialLength(draft.content, trustPolicy.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  const readerEditor = runFinalReadabilityPass(draft.content, draft.title, draft.routed_article_type);
  draft.content = preserveEditorialLength(draft.content, readerEditor.revised_content, draft.routed_article_type);
  draft.word_count = draft.content.split(/\s+/).length;

  draft.content = preserveEditorialLength(
    draft.content,
    applyPreClaimMapSourceUrlOnlyHardening(draft.content, researchPack),
    draft.routed_article_type
  );
  draft.word_count = draft.content.split(/\s+/).length;

  const revisedSources = extractSourceReferences(draft.content, researchPack);
  const revisedEvidence = extractEvidenceReferences(draft.content, researchPack);
  if (revisedSources.length > 0) {
    draft.sources_cited = revisedSources;
  }
  draft.evidence_used = revisedEvidence;

  const claimMap = buildClaimMapFromStabilizedDraft(draft.content, researchPack);
  const claimMapGate = evaluateClaimMapGate(claimMap);
  const chiefEditor = runChiefEditorPass(
    draft,
    researchPack,
    trustPolicy.artifact,
    claimMapGate,
    sourceQuality.gate,
    getTargetCitationCount(researchPack)
  );
  const editorPasses: EditorPass[] = [structural.pass, factSource.pass, trustPolicy.pass, readerEditor.pass, chiefEditor.pass];
  const finalArticle = formatFinalArticle(draft, editorPasses);
  const finalSources = extractSourceReferences(finalArticle, researchPack);
  const finalEvidence = extractEvidenceReferences(finalArticle, researchPack);
  draft.sources_cited = finalSources.length > 0 ? finalSources : draft.sources_cited;
  draft.evidence_used = finalEvidence;

  const evidenceResult = {
    topic_id: input.topic_id,
    total_sources_processed: validatedSources.length,
    total_evidence_items: researchPack.evidence_items.length,
    key_questions: keyQuestions,
  } as unknown as EvidenceExtractionResult;

  return {
    topic_id: input.topic_id,
    article_id: input.article_id,
    fetch_results: undefined,
    evidence_result: evidenceResult,
    research_pack: researchPack,
    pre_author_source_gate: preAuthorGate,
    pre_draft_claim_map: preDraftClaimMap,
    draft,
    source_quality_review: sourceQuality.review,
    source_quality_gate: sourceQuality.gate,
    structural_review: structural.artifact,
    fact_source_review: factSource.artifact,
    trust_policy_review: trustPolicy.artifact,
    claim_map: claimMap,
    claim_map_gate: claimMapGate,
    chief_editor_review: chiefEditor.artifact,
    author_routing: authorRouting,
    editor_passes: editorPasses,
    final_article: finalArticle,
    total_tokens_used: estimateTokens(researchPack, draft),
    model_api_trace: [],
    token_usage_summary: summarizeTokenUsage([], estimateTokens(researchPack, draft)),
    generation_timestamp: generationTimestamp,
  };
}

/**
 * Legacy surgical revision flow is intentionally disabled.
 * Runtime now uses a single writer model call followed by deterministic local gates only.
 */
export async function reviseArticleResultSurgically(
  _result: ArticleRuntimeResult,
  _revisedArticleId: string,
  _openAiApiKey?: string
): Promise<ArticleRuntimeResult> {
  throw new Error('Legacy revision flow is disabled. Runtime uses one writer model call and deterministic local gates only.');
}

/**
 * Generate article from parsed content and publish as Astro-compatible MDX.
 */
export async function generateArticleAndPublish(
  topic: string,
  topicId: string,
  articleId: string,
  parsedContents: ParsedSourceContent[],
  validatedSources: ValidatedSource[],
  keyQuestions: string[],
  publishOptions: RuntimePublishOptions = {},
  openAiApiKey?: string,
  fetchResults?: FetchResult[]
): Promise<ArticleRuntimeResult & { published: RuntimePublishResult }> {
  if (!publishOptions.allow_unguarded_publish) {
    throw new Error('Direct publish helper is disabled by default. Use scripts/run-article-pipeline.ts publish mode (guarded flow), or set allow_unguarded_publish=true explicitly.');
  }

  const result = await generateArticle(
    topic,
    topicId,
    articleId,
    parsedContents,
    validatedSources,
    keyQuestions,
    openAiApiKey,
    fetchResults,
    {
      author_override: publishOptions.author,
    }
  );

  const published = publishRuntimeArticle(result, publishOptions);
  return { ...result, published };
}

/**
 * Generate article from URLs and publish as Astro-compatible MDX.
 */
export async function generateArticleFromUrlsAndPublish(
  topic: string,
  topicId: string,
  articleId: string,
  urls: string[],
  validatedSources: ValidatedSource[],
  keyQuestions: string[],
  publishOptions: RuntimePublishOptions = {},
  openAiApiKey?: string
): Promise<ArticleRuntimeResult & { published: RuntimePublishResult }> {
  if (!publishOptions.allow_unguarded_publish) {
    throw new Error('Direct publish helper is disabled by default. Use scripts/run-article-pipeline.ts publish mode (guarded flow), or set allow_unguarded_publish=true explicitly.');
  }

  const result = await generateArticleFromUrls(
    topic,
    topicId,
    articleId,
    urls,
    validatedSources,
    keyQuestions,
    openAiApiKey,
    {
      author_override: publishOptions.author,
    }
  );

  const published = publishRuntimeArticle(result, publishOptions);
  return { ...result, published };
}

/**
 * Generate article draft using OpenAI API.
 */
async function generateDraftWithOpenAI(
  topic: string,
  articleId: string,
  researchPack: ResearchPack,
  apiKey: string,
  authorRouting: AuthorRoutingDecision,
  preDraftClaimMap: ClaimMapArtifact,
  modelTrace: RuntimeModelApiTraceEntry[]
): Promise<ArticleDraft> {
  const targetWordRange = getTargetWordRange(authorRouting.article_type, researchPack);
  const minimumDraftWords = readRuntimeIntEnv('PIPELINE_RUNTIME_MIN_DRAFT_WORDS', 450, 250, 1600);
  const onePassFloor = Math.max(minimumDraftWords, targetWordRange.min);
  const onePassCeiling = Math.max(targetWordRange.max, onePassFloor + 160);
  const prompt =
    buildArticleGenerationPrompt(researchPack, authorRouting, preDraftClaimMap, targetWordRange) +
    `\n\nHard requirement for this runtime: produce the final article in a single model call. Aim for approximately ${onePassFloor}-${onePassCeiling} words when the evidence naturally supports it. When evidence is thin, it is acceptable to land shorter rather than pad, repeat, or invent. Extend reader value through grounded consequence, clear explanation, real-world significance, and a smooth transition into a clearly headed forecast section that explores plausible near-term outcomes without presenting them as fact.`;

  const response = await callOpenAI(
    [
      {
        role: 'system',
        content: `You are ${authorRouting.persona.display_name}, ${authorRouting.persona.editorial_role}. Write one clean, publishable, reader-facing article using only the provided evidence. This runtime allows exactly one writer model call, so deliver the final article in one pass with natural attribution, strong flow, and no raw URLs, notes, source dumps, or checklist prose. The article should move from reported news into grounded significance and finish with a clearly headed, disciplined forecast section that signals possibilities without inventing facts.`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    apiKey,
    {
      stage_name: 'draft_generation',
      model_trace: modelTrace,
      model: 'gpt-5.1',
      temperature: 0.2,
      max_tokens: 4600,
    }
  );

  const content = response.choices[0].message.content || '';
  const polishedContent = polishGeneratedDraft(content, researchPack.topic, researchPack, authorRouting.article_type);

  const evidenceUsed = extractEvidenceReferences(polishedContent, researchPack);
  const sourcesCited = extractSourceReferences(polishedContent, researchPack);

  return {
    topic_id: researchPack.topic_id,
    article_id: articleId,
    title: researchPack.topic,
    generated_at: new Date().toISOString(),
    content: polishedContent,
    word_count: polishedContent.split(/\s+/).length,
    evidence_used: evidenceUsed,
    sources_cited: sourcesCited,
    author_name: authorRouting.persona.display_name,
    author_persona_id: authorRouting.persona.id,
    routed_article_type: authorRouting.article_type,
    routing_rationale: authorRouting.rationale,
    tags: deriveDraftTags(researchPack, authorRouting.article_type, topic),
  };
}

/**
 * Run Structural Editor stage on draft.
 */
async function runStructuralEditorPass(
  draft: ArticleDraft,
  researchPack: ResearchPack,
  apiKey: string,
  modelTrace: RuntimeModelApiTraceEntry[]
): Promise<{ revised_content: string; artifact: StructuralReviewArtifact; pass: EditorPass }> {
  const editorPrompt = buildStructuralEditorPrompt(draft, researchPack);
  const fallbackContent = applyDeterministicStructuralCleanup(draft.content, draft.title);

  try {
    const response = await callOpenAI(
      [
        {
          role: 'system',
          content:
            'You are a light-touch structural editor. Improve flow, remove repetition, and tighten transitions while preserving factual meaning. Do not add new facts, do not append source sections, and do not insert raw citation markup.',
        },
        {
          role: 'user',
          content: editorPrompt,
        },
      ],
      apiKey,
      {
        stage_name: 'structural_editor',
        model_trace: modelTrace,
        model: 'gpt-5.1',
        temperature: 0.15,
        max_tokens: 1800,
      }
    );

    const raw = response.choices?.[0]?.message?.content || '';
    const parsed = parseStructuredEditorResponse(raw);
    const revised = parsed.revised_content || fallbackContent;
    const changes = parsed.improvements_applied.length ? parsed.improvements_applied : ['Applied structure and clarity edits.'];

    return {
      revised_content: revised,
      artifact: {
        stage: 'structural_editor',
        improvements_applied: changes,
        removed_repetition_count: parsed.removed_repetition_count,
        clarity_notes: parsed.clarity_notes,
        fallback_used: false,
      },
      pass: {
        pass_number: 1,
        stage: 'structural_editor',
        changes_made: changes,
        quality_score: 8,
        approved: true,
        notes: 'Structural editor pass applied.',
      },
    };
  } catch {
    return {
      revised_content: fallbackContent,
      artifact: {
        stage: 'structural_editor',
        improvements_applied: ['Applied deterministic filler/repetition cleanup.'],
        removed_repetition_count: estimateRepetitionReduction(draft.content, fallbackContent),
        clarity_notes: ['Fallback structural cleanup used due editor model call failure.'],
        fallback_used: true,
      },
      pass: {
        pass_number: 1,
        stage: 'structural_editor',
        changes_made: ['Deterministic structural cleanup applied.'],
        quality_score: 7,
        approved: true,
        notes: 'Structural editor fallback path used.',
      },
    };
  }
}

function runStructuralEditorPassDeterministic(
  draft: ArticleDraft,
  researchPack: ResearchPack
): { revised_content: string; artifact: StructuralReviewArtifact; pass: EditorPass } {
  const revised = applyDeterministicStructuralCleanup(draft.content, draft.title);
  return {
    revised_content: revised,
    artifact: {
      stage: 'structural_editor',
      improvements_applied: [
        'Applied deterministic structure cleanup (offline local validation mode).',
        'Removed repetitive/boilerplate scaffolding before downstream gates.',
      ],
      removed_repetition_count: estimateRepetitionReduction(draft.content, revised),
      clarity_notes: [
        'No model call used in local-downstream validation mode.',
        `Research-pack evidence items available: ${researchPack.evidence_items.length}.`,
      ],
      fallback_used: true,
    },
    pass: {
      pass_number: 1,
      stage: 'structural_editor',
      changes_made: ['Deterministic offline structural cleanup applied.'],
      quality_score: 7,
      approved: true,
      notes: 'Structural editor deterministic local-validation path used.',
    },
  };
}

/**
 * Format final article with frontmatter.
 */
function formatFinalArticle(draft: ArticleDraft, editorPasses: EditorPass[]): string {
  const body = normalizeDraftBody(draft.content, draft.title);
  const article = `---
title: "${draft.title}"
article_id: ${draft.article_id}
generated_at: ${draft.generated_at}
author_name: ${draft.author_name}
author_persona_id: ${draft.author_persona_id}
routed_article_type: ${draft.routed_article_type}
word_count: ${draft.word_count}
evidence_items_used: ${draft.evidence_used.length}
sources_cited: ${draft.sources_cited.length}
editor_passes: ${editorPasses.length}
status: draft
---

# ${draft.title}

${body}

---

## Sources

${formatSourcesList(draft.sources_cited)}
`;

  return article;
}

// ============================================================================
// LIVE-FILE RULE + DUPLICATE HANDLING
// ============================================================================

interface LiveFileValidation {
  isValid: boolean;
  wordCount: number;
  excerptLength: number;
  hasImage: boolean;
  publishDate: string;
  filename: string;
}

interface DuplicateCheckResult {
  hasLiveDuplicate: boolean;
  liveFilePath: string | null;
  liveFileValidation: LiveFileValidation | null;
  brokenDuplicates: Array<{ filePath: string; filename: string; reason: string }>;
}

/**
 * Extract frontmatter value from file content.
 */
function extractFrontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * Validate a file as a live article (non-empty body, excerpt, image).
 */
function validateAsLiveFile(filePath: string): LiveFileValidation | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Extract body (after frontmatter)
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) return null;
    
    const body = content.slice(frontmatterMatch[0].length).trim();
    const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
    
    // Extract excerpt
    const excerpt = extractFrontmatterValue(content, 'excerpt');
    const excerptLength = excerpt.length;
    
    // Extract image
    const image = extractFrontmatterValue(content, 'image');
    const hasImage = image.length > 0;
    
    // Extract publishDate
    const publishDate = extractFrontmatterValue(content, 'publishDate');
    
    const filename = path.basename(filePath);
    
    return {
      isValid: wordCount > 100 && excerptLength > 40 && hasImage,
      wordCount,
      excerptLength,
      hasImage,
      publishDate,
      filename,
    };
  } catch {
    return null;
  }
}

/**
 * Check for live duplicates of the same topic_id in the output directory.
 * Returns the live file (if any) and broken duplicates to quarantine.
 */
function checkForLiveDuplicates(
  topicId: string,
  outputDir: string,
  excludeFilename?: string
): DuplicateCheckResult {
  const result: DuplicateCheckResult = {
    hasLiveDuplicate: false,
    liveFilePath: null,
    liveFileValidation: null,
    brokenDuplicates: [],
  };

  try {
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mdx') || f.endsWith('.md'));
    
    for (const file of files) {
      if (file === excludeFilename) continue;
      if (file.includes('_quarantine')) continue;
      
      const filePath = path.join(outputDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileTopicId = extractFrontmatterValue(content, 'topic_id');
      
      if (fileTopicId !== topicId) continue;
      
      const validation = validateAsLiveFile(filePath);
      if (!validation) {
        result.brokenDuplicates.push({
          filePath,
          filename: file,
          reason: 'Could not parse file',
        });
        continue;
      }
      
      if (validation.isValid) {
        // Found a live duplicate
        if (!result.hasLiveDuplicate) {
          result.hasLiveDuplicate = true;
          result.liveFilePath = filePath;
          result.liveFileValidation = validation;
        } else {
          // Multiple valid files - the one with latest publishDate wins
          if (result.liveFileValidation && validation.publishDate > result.liveFileValidation.publishDate) {
            // Current file is newer, quarantine the old live file
            result.brokenDuplicates.push({
              filePath: result.liveFilePath!,
              filename: result.liveFileValidation!.filename,
              reason: 'Superseded by newer live file',
            });
            result.liveFilePath = filePath;
            result.liveFileValidation = validation;
          } else {
            // Current file is older, quarantine it
            result.brokenDuplicates.push({
              filePath,
              filename: file,
              reason: 'Superseded by existing live file',
            });
          }
        }
      } else {
        // Broken file - mark for quarantine
        const reasons = [];
        if (validation.wordCount <= 100) reasons.push(`body too short (${validation.wordCount} words)`);
        if (validation.excerptLength <= 40) reasons.push(`excerpt too short (${validation.excerptLength} chars)`);
        if (!validation.hasImage) reasons.push('missing image');
        result.brokenDuplicates.push({
          filePath,
          filename: file,
          reason: reasons.join('; '),
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return result;
}

/**
 * Quarantine a broken or superseded duplicate file.
 */
function quarantineInvalidDuplicate(filePath: string, outputDir: string): string {
  const quarantineDir = path.join(outputDir, '_quarantine');
  fs.mkdirSync(quarantineDir, { recursive: true });
  
  const filename = path.basename(filePath);
  const quarantinePath = path.join(quarantineDir, filename);
  
  // Handle collision in quarantine
  let finalPath = quarantinePath;
  let counter = 1;
  while (fs.existsSync(finalPath) && counter < 100) {
    const ext = path.extname(filename);
    const name = path.basename(filename, ext);
    finalPath = path.join(quarantineDir, `${name}_quarantined_${counter}${ext}`);
    counter += 1;
  }
  
  fs.renameSync(filePath, finalPath);
  console.log(`[quarantine] moved ${filename} to _quarantine/`);
  
  return finalPath;
}

/**
 * Validate publish integrity: body, excerpt, image must all be present and valid.
 */
function validatePublishIntegrity(
  content: string,
  title: string
): { isValid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  // Extract body (after frontmatter)
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    issues.push('No frontmatter found');
    return { isValid: false, issues };
  }
  
  const body = content.slice(frontmatterMatch[0].length).trim();
  const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
  
  if (wordCount <= 100) {
    issues.push(`Body too short: ${wordCount} words (minimum: 100)`);
  }
  
  // Extract excerpt
  const excerpt = extractFrontmatterValue(content, 'excerpt');
  if (excerpt.length <= 40) {
    issues.push(`Excerpt too short: ${excerpt.length} characters (minimum: 40)`);
  }
  
  // Extract image
  const image = extractFrontmatterValue(content, 'image');
  if (!image || image.length === 0) {
    issues.push('Missing image frontmatter');
  }
  
  return {
    isValid: issues.length === 0,
    issues,
  };
}

/**
 * Publish runtime result to src/data/post using publisher module formatting.
 *
 * Publish Safety Gate:
 * - Validates final article body is safe for MDX before writing
 * - Removes broken HTML/MDX residue, truncated tags, source-snippet artifacts
 * - If content is unsafe after sanitization, throws error and does NOT write file
 *
 * Live-File Rule:
 * - Checks for existing live files with same topic_id
 * - Quarantines broken/superseded duplicates
 * - Blocks publish if live duplicate already exists
 *
 * Publish Integrity Gate:
 * - Validates body > 100 words
 * - Validates excerpt > 40 characters
 * - Validates image frontmatter present
 * - If integrity check fails, throws error and does NOT write file
 */
export function publishRuntimeArticle(
  result: ArticleRuntimeResult,
  options: RuntimePublishOptions = {}
): RuntimePublishResult {
  const outputDir = options.output_dir || path.resolve(process.cwd(), 'src/data/post');
  fs.mkdirSync(outputDir, { recursive: true });

  const publisherDraft: PublisherArticleDraft = {
    topic_id: result.topic_id,
    article_id: result.article_id,
    draft_version: 1,
    author: options.author || result.draft.author_name || 'Foseer Editorial',
    created: result.generation_timestamp.split('T')[0],
    status: 'approved',
    content: toPublishableBody(result),
    tags: options.tags && options.tags.length > 0 ? options.tags : result.draft.tags,
  };

  const publishBody = publisherDraft.content;
  const title = options.title || result.draft.title;
  const excerpt = options.excerpt || buildExcerpt(publishBody);
  const category = options.category || inferPublishCategory(result);
  const tags = options.tags && options.tags.length > 0
    ? options.tags
    : deriveDraftTags(result.research_pack, result.draft.routed_article_type, result.draft.title);

  // Log taxonomy classification for observability
  if (options.article_type || options.section_id || options.topic_id) {
    logTaxonomyPublish({
      article_id: result.article_id,
      article_type: options.article_type || result.draft.routed_article_type,
      section_id: options.section_id,
      topic_id: options.topic_id,
      source: options.section_id && options.topic_id ? 'explicit' : 'inferred',
    });
  }

  const publishSources = derivePublishSources(result.research_pack, result.draft.sources_cited);

  const { filename: baseFilename, content } = formatPublishedArticle(publisherDraft, title, excerpt, {
    category,
    tags,
    sources: publishSources,
    author: options.author || result.draft.author_name || 'Foseer Editorial',
    article_type: options.article_type || result.draft.routed_article_type,
    section_id: options.section_id,
    topic_id: options.topic_id,
  });

  // A. Publish Safety Gate: Validate and sanitize content before write
  const sanitizedContent = applyPublishSafetyGate(content);
  const safetyValidation = validatePublishSafety(sanitizedContent);
  if (!safetyValidation.isSafe) {
    throw new Error(
      `PUBLISH_SAFETY_GATE_FAILED: Article "${title}" contains unsafe MDX-breaking content. ` +
      `Issues: ${safetyValidation.issues.join('; ')}. Article NOT written to disk.`
    );
  }

  const categoryBoundContent = bindCategoryFrontmatter(sanitizedContent, category);

  // B. Image Resolution: Pexels -> source original image -> blue fallback
  const resolvedImagePath = resolveArticleImage(options.image, result.article_id, category);
  const boundContent = bindImageFrontmatter(categoryBoundContent, resolvedImagePath);

  // C. Live-File Rule: Check for duplicates with same topic_id
  const duplicateCheck = checkForLiveDuplicates(result.topic_id, outputDir);
  
  // Quarantine broken duplicates first
  for (const broken of duplicateCheck.brokenDuplicates) {
    quarantineInvalidDuplicate(broken.filePath, outputDir);
  }
  
  // Block if live duplicate exists
  if (duplicateCheck.hasLiveDuplicate) {
    throw new Error(
      `PUBLISH_BLOCKED_DUPLICATE: Live article already exists for topic_id ${result.topic_id}. ` +
      `Existing: ${duplicateCheck.liveFileValidation?.filename || 'unknown'}. ` +
      `Action: Delete or quarantine existing file before republishing.`
    );
  }

  // D. Safe filename handling: avoid hard failure on existing files
  const filename = generateSafeFilename(baseFilename, outputDir, options.allow_overwrite);
  const outputPath = path.join(outputDir, filename);

  if (!options.allow_overwrite && fs.existsSync(outputPath)) {
    throw new Error(`Publish blocked: output file already exists at ${outputPath}`);
  }

  fs.writeFileSync(outputPath, boundContent, 'utf-8');

  // E. Publish Integrity Gate: Validate written file
  const writtenContent = fs.readFileSync(outputPath, 'utf-8');
  const integrityValidation = validatePublishIntegrity(writtenContent, title);
  if (!integrityValidation.isValid) {
    // Quarantine the broken file we just wrote
    fs.unlinkSync(outputPath);
    throw new Error(
      `PUBLISH_INTEGRITY_GATE_FAILED: Article "${title}" failed integrity validation. ` +
      `Issues: ${integrityValidation.issues.join('; ')}. File NOT published.`
    );
  }

  return {
    filename,
    output_path: outputPath,
    content: boundContent,
  };
}

function inferPublishCategory(result: ArticleRuntimeResult): string {
  if (result.draft.routed_article_type === 'report') return 'News';
  if (result.draft.routed_article_type === 'explainer') return 'Explainer';
  return 'Analysis';
}

function derivePublishSources(researchPack: ResearchPack, citedUrls: string[]): PublishSourceLink[] {
  // Published/frontmatter sources must mirror the article's real sourcing.
  // Do not leak uncited core sources into frontmatter just because they existed in the pack.
  const coreSources = researchPack.sources.filter(
    (source) => source.source_role === 'primary' || source.source_role === 'reporting'
  );
  const coreUrls = new Set(coreSources.map((source) => source.url));
  const citedCoreUrls = citedUrls.filter((url) => coreUrls.has(url));
  const used = new Set<string>();
  const resolved: PublishSourceLink[] = [];

  const pushUrl = (url: string) => {
    if (!url || used.has(url)) return;
    const source = researchPack.sources.find((item) => item.url === url);
    used.add(url);
    resolved.push({
      title: source?.title || sourceDisplayLabel(url),
      url,
    });
  };

  for (const url of citedCoreUrls) {
    pushUrl(url);
    if (resolved.length >= 4) break;
  }

  // Only fall back to uncited core anchors when the article body failed to surface any source URLs at all.
  if (resolved.length === 0) {
    for (const source of coreSources) {
      pushUrl(source.url);
      if (resolved.length >= 2) break;
    }
  }

  if (resolved.length < 4) {
    const citedContextUrls = citedUrls.filter(
      (url) => !used.has(url) && researchPack.sources.some((source) => source.url === url && source.source_role === 'context')
    );
    for (const url of citedContextUrls) {
      pushUrl(url);
      if (resolved.length >= 4) break;
    }
  }

  return resolved;
}

function sourceDisplayLabel(url: string): string {
  const domain = safeDomain(url).replace(/^www\./i, '');
  if (!domain) return 'Source';
  const base = domain.split('.')[0] || domain;
  return base
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}


function deriveDraftTags(
  researchPack: ResearchPack,
  articleType: CanonicalArticleType,
  topic: string
): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  const blocked = new Set([
    'news', 'report', 'analysis', 'explainer', 'foseer', 'editorial',
    'mother', 'daughter', 'father', 'son', 'family', 'story', 'reports', 'reporters', 'says', 'said',
    'guardian', 'theguardian', 'globeandmail', 'theglobeandmail', 'reuters', 'ap', 'bbc', 'cnn',
  ]);

  const pushTag = (value: string) => {
    const cleaned = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 4 || cleaned.length > 32) return;
    if (blocked.has(cleaned)) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    tags.push(cleaned);
  };

  const topicWords = String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !/^(with|from|that|this|will|have|their|about|into|after|before|during|where|says|said|reports|report|news)$/.test(token));

  for (let i = 0; i < topicWords.length - 1; i += 1) {
    pushTag(`${topicWords[i]} ${topicWords[i + 1]}`);
    if (tags.length >= 3) break;
  }

  if (tags.length < 2) {
    for (const token of topicWords) {
      pushTag(token);
      if (tags.length >= 3) break;
    }
  }

  if (tags.length === 0 && articleType !== 'report') {
    pushTag(articleType);
  }

  return tags.slice(0, 3);
}

function toPublishableBody(result: ArticleRuntimeResult): string {
  const final = result.final_article?.trim();
  if (!final) {
    return sanitizePublishedBody(result.draft.content);
  }

  // Remove runtime frontmatter block if present; publisher will add site frontmatter.
  const withoutFrontmatter = final.replace(/^---\n[\s\S]*?\n---\n*/m, '');
  return sanitizePublishedBody(withoutFrontmatter.trim());
}

function sanitizePublishedBody(content: string): string {
  let text = String(content || '').replace(/\r\n/g, '\n');
  text = text.replace(/^\s*##\s+Article Draft\s*\n?/gim, '');
  text = text.replace(/\n##\s+Sources[\s\S]*$/im, '');
  text = text.replace(/^\s*##\s+Claim References[\s\S]*$/gim, '');
  text = text.replace(/\[Source\]\([^)]+\)/g, '');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label) => looksLikeRawSourceLabel(label) ? '' : label);
  text = text.replace(/\bSource\s*\((https?:\/\/[^)]+)\)/gi, '');
  text = text.replace(/\((?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s)]*)?\)/gi, '');
  text = text.replace(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s)]*)?/gi, (match) => /^[a-z]/i.test(match) && /\s/.test(match) ? match : '');
  text = text.replace(/\[\^\d+\]/g, '');
  text = text.replace(/^\[\^\d+\]:\s.*$/gim, '');
  text = text.replace(/^>+\s*/gm, '');
  text = text.replace(/\bAccording to available reporting,\s*/gi, '');
  text = text.replace(/\bIn summary,\s*/gi, '');
  text = stripUnsafeInlineHtml(text);
  text = text.replace(/\s(?=\[\^\d+\]:\s)/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^\s*---\s*$/gm, '');
  
  // Split into paragraphs and filter, but keep substantive content
  const paragraphs = text.split(/\n{2,}/);
  const keptParagraphs: string[] = [];
  
  for (const para of paragraphs) {
    const normalized = normalizePublishedParagraph(para);
    
    // Keep paragraphs with substantive content (>30 chars)
    if (normalized.length > 30) {
      keptParagraphs.push(normalized);
    }
  }
  
  text = keptParagraphs.join('\n\n');
  text = removeNearDuplicateParagraphs(text);
  // Remove standalone heading lines BUT preserve the text content
  text = text.replace(/^\s*#+\s+([^\n]+)\n?/gm, '$1\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function stripUnsafeInlineHtml(content: string): string {
  let text = String(content || '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>\n]*\.{2,}\s*/g, ' ');
  text = text.replace(/<\/?[a-z][^>\n]*>/gi, ' ');
  text = text.replace(/<[^>\n]*$/gm, ' ');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/\s{2,}/g, ' ');
  return text;
}

function normalizePublishedParagraph(paragraph: string): string {
  let value = paragraph.replace(/\s+/g, ' ').trim();
  value = value.replace(/\s+([,.;:!?])/g, '$1');
  value = value.replace(/\(\s*\)/g, '');
  value = value.replace(/,\s*,/g, ',');
  value = value.replace(/\.\s*\./g, '.');
  value = value.replace(/\s+\.$/g, '.');
  value = value.replace(/\s{2,}/g, ' ');
  return value.trim();
}


function looksLikeRawSourceLabel(label: string): boolean {
  const normalized = String(label || '').trim().toLowerCase();
  return /^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/.test(normalized);
}

function isPublishedResidueParagraph(paragraph: string): boolean {
  const value = paragraph.trim();
  if (!value) return true;
  if (/^\.+$/.test(value)) return true;
  // Only filter "According to" patterns that look like source snippets (with photograph/image credits)
  if (/^according to [^.\n]{24,180},\s*(photograph:|image:|photo:)/i.test(value)) return true;
  // Filter "According to" patterns that are clearly source attribution residue (no footnote markers, very generic)
  if (/^according to [^.\n]{50,220}\.\s*$/i.test(value) && !/\[\^\d+\]/.test(value) && !/[0-9]/.test(value)) return true;
  if (/^(in summary,\s*)?based on available reporting,/i.test(value)) return true;
  if (/^source\s*[:\-]/i.test(value)) return true;
  if (/^footnotes?\s*[:\-]/i.test(value)) return true;
  return false;
}

/**
 * Build a short excerpt from article markdown content.
 */
function buildExcerpt(content: string, maxLength: number = 160): string {
  const sanitized = sanitizePublishedBody(content);
  const candidateParagraphs = sanitized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 40)
    .filter((part) => !/^#{1,6}\s+/.test(part))
    .filter((part) => !isPublishedResidueParagraph(part));

  const base = candidateParagraphs[0] || sanitized;
  const plain = base
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= maxLength) {
    return plain;
  }

  const truncated = plain.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const safe = lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
  return `${safe.trim()}...`;
}

/**
 * Build prompt for article generation.
 */
function getTargetWordRange(
  articleType: CanonicalArticleType,
  researchPack?: Pick<ResearchPack, 'sources' | 'evidence_items'>
): { min: number; max: number } {
  const sourceCount = researchPack?.sources?.length || 0;
  const evidenceCount = researchPack?.evidence_items?.length || 0;

  if (evidenceCount <= 6 || sourceCount <= 1) {
    return articleType === 'report' ? { min: 480, max: 700 } : { min: 520, max: 760 };
  }

  if (evidenceCount <= 10 || sourceCount <= 2) {
    return articleType === 'report' ? { min: 620, max: 860 } : { min: 700, max: 980 };
  }

  return articleType === 'report' ? { min: 820, max: 1080 } : { min: 900, max: 1200 };
}

function getForecastSectionHeadingOptions(articleType: CanonicalArticleType): string[] {
  if (articleType === 'analysis') {
    return [
      'What This Could Mean',
      'Where This Could Lead',
      'Possible Outcomes',
      'What Comes Next',
      'Where This Is Heading',
      'What May Happen Next',
    ];
  }

  if (articleType === 'report') {
    return [
      'What Comes Next',
      'Where This Could Lead',
      'What May Happen Next',
      'What This Could Mean',
      'Possible Outcomes',
      'Where This Is Heading',
    ];
  }

  return [
    'Where This Could Lead',
    'What Comes Next',
    'What This Could Mean',
    'Possible Outcomes',
    'What May Happen Next',
    'Where This Is Heading',
  ];
}

function buildArticleGenerationPrompt(
  researchPack: ResearchPack,
  authorRouting: AuthorRoutingDecision,
  preDraftClaimMap: ClaimMapArtifact,
  targetWordRange: { min: number; max: number } = getTargetWordRange(authorRouting.article_type, researchPack)
): string {
  const keyQuestions = researchPack.key_questions.slice(0, 5).map((q, i) => `${i + 1}. ${compactPromptText(q, 170)}`);
  const coreEvidence = getPriorityEvidenceForDraft(researchPack, 12)
    .filter((item) => {
      const source = researchPack.sources.find((candidate) => candidate.url === item.source_url);
      return source?.source_role === 'primary' || source?.source_role === 'reporting';
    })
    .slice(0, 8)
    .map(
      (item, index) =>
        `${index + 1}. [${item.id}] ${compactPromptText(item.claim, 200)} (Source: ${compactPromptText(item.source || safeDomain(item.source_url) || 'Source', 90)})`
    );
  const fallbackEvidence = getPriorityEvidenceForDraft(researchPack, 10)
    .slice(0, 8)
    .map(
      (item, index) =>
        `${index + 1}. [${item.id}] ${compactPromptText(item.claim, 200)} (Source: ${compactPromptText(item.source || safeDomain(item.source_url) || 'Source', 90)})`
    );
  const supportingContext = researchPack.sources
    .filter((source) => source.source_role === 'context')
    .slice(0, 4)
    .map((source) => `- ${compactPromptText(source.title, 110)} (${safeDomain(source.url) || 'context'})`);
  const mappedClaims = preDraftClaimMap.entries
    .filter((entry) => entry.support_status === 'supported' || entry.support_status === 'partially_supported')
    .slice(0, 8)
    .map(
      (entry, index) =>
        `${index + 1}. (${entry.support_status}) ${compactPromptText(entry.claim_text, 200)}`
    );
  const coreEvidenceBlock = coreEvidence.length > 0 ? coreEvidence : fallbackEvidence;
  const forecastHeadingOptions = getForecastSectionHeadingOptions(authorRouting.article_type);
  const recommendedForecastHeading = forecastHeadingOptions[0];
  const sectionBlueprint = targetWordRange.max <= 700
    ? [
        '1. What Happened',
        '2. What Is Confirmed',
        '3. What Is Still Unclear',
        `4. ${recommendedForecastHeading}`,
      ]
    : [
        '1. What Happened',
        '2. Confirmed Facts',
        '3. Response and Current Situation',
        '4. What Remains Unclear',
        `5. ${recommendedForecastHeading}`,
      ];

  return `## Author Style
Name: ${authorRouting.persona.display_name}
Role: ${authorRouting.persona.editorial_role}
Routed type: ${authorRouting.article_type}

Voice:
${authorRouting.persona.voice}

Audience:
${authorRouting.persona.audience_level}

Tone guidance:
${authorRouting.persona.tone_guidance.slice(0, 3).map((item) => `- ${item}`).join('\n')}

Focus guidance:
${authorRouting.persona.focus_guidance.slice(0, 3).map((item) => `- ${item}`).join('\n')}

Pacing guidance:
${authorRouting.persona.pacing_guidance.slice(0, 3).map((item) => `- ${item}`).join('\n')}

Style avoidances:
${authorRouting.persona.avoid_style.slice(0, 3).map((item) => `- ${item}`).join('\n')}

---

## Assignment
Write one clean, publishable, reader-facing article about:
${researchPack.topic}

Use only the provided evidence and source-backed facts. Do not invent details. If evidence is partial or incomplete, keep the scope narrow and state clearly what remains unconfirmed. The article should already feel edited in one pass: clear, non-repetitive, natural, readable, and publishable.

## Article Goal
The reader should finish the article understanding:
1. what happened
2. what is confirmed
3. what is still unclear
4. why this matters
5. where this could lead next

The article must feel informative, emotionally grounded, and trustworthy. Emotion should come from real human consequence, risk, scale, loss, uncertainty, or impact — never from artificial dramatic language.

## Topic Focus Lock
This article is about:
${researchPack.topic}

Stay tightly centered on that selected event. Do not broaden the piece into adjacent policy, trend, or industry coverage unless that adjacent angle appears directly in the core evidence and clearly helps explain the selected event.

## Required Structure
Write the article in 4 or 5 short sections using this order as a blueprint. Aim for approximately ${targetWordRange.min}-${targetWordRange.max} words when the evidence supports it. When the evidence is thin, a shorter article is acceptable. Never pad or repeat just to hit a number.

${sectionBlueprint.join('\n')}

## Final Forecast Section Heading
The final section must be explicitly forward-looking and must use a natural reader-facing markdown heading. Choose the single best-fit heading from this list for this specific article:
${forecastHeadingOptions.map((item) => `- ${item}`).join('\n')}

Prefer the heading that best matches the article's tone:
- use "Where This Could Lead" for a balanced news-analysis forecast
- use "What Comes Next" for direct, straightforward event follow-through
- use "What This Could Mean" when the value is in consequence and significance
- use "Possible Outcomes" when the ending should feel more analytical and scenario-based
- use "What May Happen Next" when cautious plain-language forecasting is best
- use "Where This Is Heading" only when the piece can support a slightly more interpretive tone

Section instructions:
- What Happened: open with a strong lead in plain language and make the first paragraph useful immediately.
- Confirmed Facts / What Is Confirmed: cover the most important verified who/what/where/when details without repeating the lead in different words.
- Response and Current Situation: explain what directly involved officials, institutions, companies, or witnesses are doing or saying now.
- What Remains Unclear / What Is Still Unclear: state clearly what is still unknown, disputed, or unconfirmed; do not speculate.
- Final forecast section: transition smoothly from the reported event into disciplined forecasting. Explain what this event could lead to next, what pressure or momentum it creates, what actors are now likely to watch or do, and what the most plausible near-term consequences are.

## Evidence


### Core Evidence
${coreEvidenceBlock.join('\n')}

### Supporting Context
${supportingContext.length > 0 ? supportingContext.join('\n') : '- No separate context sources available. Use only the core evidence and keep the scope narrow.'}

### Key Questions To Cover
${keyQuestions.length > 0 ? keyQuestions.join('\n') : '- Cover only the questions that the evidence can answer confidently.'}

### Claim Backbone
${mappedClaims.length > 0 ? mappedClaims.join('\n') : '- Use supported evidence claims only and keep synthesis narrow.'}

## Global Writing Rules
- Every paragraph must add new information or new value.
- Before writing each new section, make sure it adds information that previous sections did not already deliver.
- If a sentence does not add a new fact, clarification, consequence, implication, or transition value, remove it.
- Do not repeat the same fact in different wording.
- Do not write in research-note style.
- Do not use checklist prose.
- Do not use mechanical ordinal scaffolding such as "First," "Second," "Third," or "Finally," as the main way of organizing the article.
- Do not write broken fragments like "According to ..." without a complete sentence.
- Use natural attribution in prose.
- Prefer concrete nouns, actions, dates, places, institutions, and attributed statements.
- Keep paragraphs short and readable.
- Prefer six to nine compact paragraphs over compressed all-in-one summary blocks when the evidence supports that structure.
- Do not output raw URLs, source appendices, metadata, or notes.
- Do not use bullet points in the final article body.
- No personal opinion, moralizing, sensational phrasing, or filler background that does not help the reader understand this event.
- If the evidence is thin, be narrow and precise rather than broad and impressive.
- When evidence is thin, shorten the article and narrow the scope instead of widening the frame with extra context.
- You may extend the article naturally through safe synthesis: explain why the event matters, what practical consequence follows, what pressure or uncertainty it creates, what precedent or institutional stake it touches, and what a reader should watch next.
- You may add one short closing paragraph that lands emotionally through consequence, tension, institutional stakes, or human stakes, but it must stay grounded in the provided evidence and context.
- The final forecast section may project near-term consequences, likely next moves, or emerging pressure points, but only as clearly signaled possibilities.
- In the forecast section, use cautious language such as "could", "may", "is likely to", "would suggest", or "one likely next step is".
- Keep forecasting near-term, plausible, and directly tied to the confirmed event and supporting context.
- Keep the forecast section shorter than the factual body when the evidence base is thin.
- Never invent new people, quotes, numbers, scenes, motives, timelines, conversations, or undisclosed causes.
- Never present speculation as established fact.
- Never manufacture emotion. Earn it through what the sourced facts imply for people, institutions, or the next decision point.

## Forecast Discipline Rules
- The final section must feel like a smooth continuation of the article, not a separate essay.
- Forecast only from the event, the evidence, and safe contextual implications.
- Prefer 2 to 4 grounded possibilities over broad futurism.
- Do not introduce new factual reporting in the forecast section unless it already appears in the evidence pack.
- The forecast should answer: what pressure now exists, what may happen next, and why that next step matters.

## Emotional Depth Rules
You may strengthen reader engagement through human consequence, scale of impact, documented uncertainty, practical implications, institutional stakes, and what readers should understand about what happens next. Let the facts carry the emotional weight. A short, natural closing note is allowed when it grows directly out of verified facts, likely consequences, and the next real decision point. Do not use phrases like "this is shocking", "this is heartbreaking", "clearly", or "obviously".

## Source Usage Rules
Use Core Evidence as the foundation of factual event claims. Use Supporting Context only for consequence, background, or forward-looking relevance. Do not let supporting context replace core event proof.
- If a source does not directly describe the selected event, it may appear only briefly as context and must not drive a main section.
- Do not let supporting context introduce a second story line, second controversy, or broader thematic frame that the core evidence does not support.
- The lead, the main factual spine, and the key confirmed points must come from core evidence, not contextual sources.

## Output Rules
Return only the final article body in clean markdown. No title suggestions, notes, explanations, metadata, bullet summaries, or source lists. The article may be shorter than the target range when evidence is limited, but it should still feel finished, coherent, human, and end with a properly headed forward-looking section chosen from the allowed heading list.`;
}

function compactPromptText(value: string, maxLength: number): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

/**
 * Build prompt for structural editor pass.
 */
function buildStructuralEditorPrompt(draft: ArticleDraft, researchPack: ResearchPack): string {
  const compactDraft = compactPromptText(draft.content, 20000);
  return `Revise the following article for structure and clarity.

## Article Draft
${compactDraft}

## Original Research Pack
- Topic: ${researchPack.topic}
- Evidence items available: ${researchPack.evidence_items.length}
- Evidence used: ${draft.evidence_used.join(', ') || 'none detected yet'}

## Structural Editor Checklist
1. Remove obvious filler and redundant wording
2. Improve section flow and transition clarity
3. Reduce repetition
4. Preserve evidence-grounded content while removing raw URLs and source dump formatting
5. Do not add new factual claims
6. Replace generic checklist bullets with evidence-specific prose where possible
7. Remove weak universal advice statements that have no clear evidence grounding
8. Add a short subheading only when it improves readability; do not output headings like "Article Draft" or "Sources"

## Output Format
Return strict JSON:
{
  "revised_content": "full revised markdown body",
  "improvements_applied": ["..."],
  "removed_repetition_count": 0,
  "clarity_notes": ["..."]
}`;
}

/**
 * Call OpenAI API.
 */
async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  options: {
    stage_name?: string;
    model_trace?: RuntimeModelApiTraceEntry[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
  } = {}
): Promise<any> {
  const maxAttempts = 3;
  let lastError: Error | null = null;
  let activeMessages = messages.map((message) => ({
    role: message.role,
    content: message.content || '',
  }));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model || 'gpt-4o-mini',
          messages: activeMessages,
          temperature: options.temperature ?? 0.7,
          max_completion_tokens: options.max_completion_tokens ?? options.max_tokens ?? 2000,
        }),
      });

      clearTimeout(timeoutId);

      const modelName = options.model || 'gpt-4o-mini';
      const configuredMaxTokens = options.max_completion_tokens ?? options.max_tokens ?? 2000;
      const configuredTemperature = options.temperature ?? 0.7;

      if (!response.ok) {
        const errorText = await response.text();
        if (isContextLengthExceededError(response.status, errorText) && attempt < maxAttempts - 1) {
          pushModelTrace(options.model_trace, {
            stage_name: options.stage_name || 'unspecified_stage',
            provider_api: 'openai_chat_completions',
            model: modelName,
            configured_max_tokens: configuredMaxTokens,
            temperature: configuredTemperature,
            attempt: attempt + 1,
            success: false,
            fallback_used: true,
            usage_available: false,
            error: `Context length exceeded: ${errorText.slice(0, 240)}`,
          });
          activeMessages = shrinkMessagesForContext(activeMessages);
          await waitBeforeRetry(attempt);
          continue;
        }
        const error = new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        if (isRetryableOpenAiStatus(response.status) && attempt < maxAttempts - 1) {
          pushModelTrace(options.model_trace, {
            stage_name: options.stage_name || 'unspecified_stage',
            provider_api: 'openai_chat_completions',
            model: modelName,
            configured_max_tokens: configuredMaxTokens,
            temperature: configuredTemperature,
            attempt: attempt + 1,
            success: false,
            fallback_used: true,
            usage_available: false,
            error: `Retryable API error ${response.status}: ${errorText.slice(0, 240)}`,
          });
          await waitBeforeRetry(attempt);
          continue;
        }
        pushModelTrace(options.model_trace, {
          stage_name: options.stage_name || 'unspecified_stage',
          provider_api: 'openai_chat_completions',
          model: modelName,
          configured_max_tokens: configuredMaxTokens,
          temperature: configuredTemperature,
          attempt: attempt + 1,
          success: false,
          fallback_used: false,
          usage_available: false,
          error: `OpenAI API error ${response.status}: ${errorText.slice(0, 240)}`,
        });
        throw error;
      }
      const payload = await response.json();
      const usage = (payload?.usage || {}) as {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      const promptTokens = Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : undefined;
      const completionTokens = Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : undefined;
      const totalTokens = Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : undefined;
      pushModelTrace(options.model_trace, {
        stage_name: options.stage_name || 'unspecified_stage',
        provider_api: 'openai_chat_completions',
        model: modelName,
        configured_max_tokens: configuredMaxTokens,
        temperature: configuredTemperature,
        attempt: attempt + 1,
        success: true,
        fallback_used: attempt > 0,
        usage_available: Number.isFinite(totalTokens),
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        estimated_total_tokens: Number.isFinite(totalTokens)
          ? undefined
          : estimateMessageTokens(activeMessages, configuredMaxTokens),
      });
      return payload;
    } catch (error) {
      clearTimeout(timeoutId);
      const typedError = error instanceof Error ? error : new Error(String(error));
      lastError = typedError;
      const alreadyTracedApiError = typedError.message.startsWith('OpenAI API error:');
      if (attempt < maxAttempts - 1 && isRetryableNetworkError(typedError)) {
        pushModelTrace(options.model_trace, {
          stage_name: options.stage_name || 'unspecified_stage',
          provider_api: 'openai_chat_completions',
          model: options.model || 'gpt-4o-mini',
          configured_max_tokens: options.max_completion_tokens ?? options.max_tokens ?? 2000,
          temperature: options.temperature ?? 0.7,
          attempt: attempt + 1,
          success: false,
          fallback_used: true,
          usage_available: false,
          error: `Retryable network error: ${typedError.message.slice(0, 240)}`,
        });
        await waitBeforeRetry(attempt);
        continue;
      }
      if (!alreadyTracedApiError) {
        pushModelTrace(options.model_trace, {
          stage_name: options.stage_name || 'unspecified_stage',
          provider_api: 'openai_chat_completions',
          model: options.model || 'gpt-4o-mini',
          configured_max_tokens: options.max_completion_tokens ?? options.max_tokens ?? 2000,
          temperature: options.temperature ?? 0.7,
          attempt: attempt + 1,
          success: false,
          fallback_used: false,
          usage_available: false,
          error: typedError.message.slice(0, 240),
        });
      }
      throw typedError;
    }
  }

  throw lastError || new Error('OpenAI API failed after retries');
}

function pushModelTrace(trace: RuntimeModelApiTraceEntry[] | undefined, entry: RuntimeModelApiTraceEntry): void {
  if (!trace) {
    return;
  }
  trace.push(entry);
}

function estimateMessageTokens(messages: Array<{ role: string; content: string }>, configuredMaxTokens: number): number {
  const promptChars = messages.reduce((sum, message) => sum + (message.content || '').length, 0);
  const promptEstimate = Math.max(1, Math.round(promptChars / 4));
  return promptEstimate + Math.max(0, Math.round(configuredMaxTokens * 0.55));
}

function summarizeTokenUsage(trace: RuntimeModelApiTraceEntry[], fallbackEstimate: number): RuntimeTokenUsageSummary {
  const successful = trace.filter((entry) => entry.success);
  const exactPrompt = successful.reduce((sum, entry) => sum + Number(entry.prompt_tokens || 0), 0);
  const exactCompletion = successful.reduce((sum, entry) => sum + Number(entry.completion_tokens || 0), 0);
  const exactTotal = successful.reduce((sum, entry) => sum + Number(entry.total_tokens || 0), 0);
  const estimatedTotal = successful.reduce((sum, entry) => {
    if (Number.isFinite(Number(entry.total_tokens))) {
      return sum + Number(entry.total_tokens || 0);
    }
    return sum + Number(entry.estimated_total_tokens || 0);
  }, 0);
  return {
    exact_prompt_tokens: exactPrompt,
    exact_completion_tokens: exactCompletion,
    exact_total_tokens: exactTotal,
    estimated_total_tokens: estimatedTotal > 0 ? estimatedTotal : fallbackEstimate,
    usage_available_for_all_calls: successful.length > 0 && successful.every((entry) => entry.usage_available),
  };
}

function isContextLengthExceededError(status: number, errorText: string): boolean {
  if (status !== 400) {
    return false;
  }
  const normalized = (errorText || '').toLowerCase();
  return normalized.includes('context_length_exceeded') || normalized.includes('maximum context length');
}

function shrinkMessagesForContext(
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  return messages.map((message, index) => {
    const cap = index === 0 ? 6000 : 42000;
    return {
      role: message.role,
      content: compactPromptText(message.content || '', cap),
    };
  });
}

/**
 * Extract evidence IDs referenced in article content.
 */
function extractEvidenceReferences(content: string, researchPack: ResearchPack): string[] {
  const evidenceIds = new Set<string>();
  const evidencePattern = /\[?(E\d{3})\]?/g;
  let match;

  while ((match = evidencePattern.exec(content)) !== null) {
    const id = match[1];
    if (researchPack.evidence_items.some((e) => e.id === id)) {
      evidenceIds.add(id);
    }
  }

  const urls = extractSourceReferences(content, researchPack);
  for (const evidenceItem of researchPack.evidence_items) {
    if (evidenceItem.source_url && urls.includes(evidenceItem.source_url)) {
      evidenceIds.add(evidenceItem.id);
    }
  }

  return Array.from(evidenceIds);
}

/**
 * Extract source URLs referenced in article content.
 */
function extractSourceReferences(content: string, researchPack: ResearchPack): string[] {
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s\)]+/g;
  let match;

  while ((match = urlPattern.exec(content)) !== null) {
    const url = match[0];
    if (researchPack.sources.some((s) => s.url === url) && !urls.includes(url)) {
      urls.push(url);
    }
  }

  return urls;
}

function ensureDeterministicSourceCitations(
  draft: ArticleDraft,
  researchPack: ResearchPack,
  minimumSources: number
): void {
  const merged = new Set<string>(draft.sources_cited);
  for (const url of getPreferredCitationUrls(researchPack)) {
    if (merged.size >= minimumSources) {
      break;
    }
    merged.add(url);
  }
  draft.sources_cited = Array.from(merged);
}

function getPreferredCitationUrls(researchPack: ResearchPack): string[] {
  const byDomain = new Map<string, string[]>();

  for (const item of researchPack.evidence_items) {
    if (item.source_url) {
      const domain = safeDomain(item.source_url);
      if (!byDomain.has(domain)) {
        byDomain.set(domain, []);
      }
      const items = byDomain.get(domain)!;
      if (!items.includes(item.source_url)) {
        items.push(item.source_url);
      }
    }
  }

  for (const source of researchPack.sources) {
    if (source.url) {
      const domain = safeDomain(source.url);
      if (!byDomain.has(domain)) {
        byDomain.set(domain, []);
      }
      const items = byDomain.get(domain)!;
      if (!items.includes(source.url)) {
        items.push(source.url);
      }
    }
  }

  const diverseFirst: string[] = [];
  let advanced = true;
  let round = 0;
  while (advanced) {
    advanced = false;
    for (const urls of byDomain.values()) {
      if (urls[round]) {
        diverseFirst.push(urls[round]);
        advanced = true;
      }
    }
    round += 1;
  }

  return diverseFirst;
}

function getTargetCitationCount(researchPack: ResearchPack): number {
  const unique = new Set(getPreferredCitationUrls(researchPack));
  if (unique.size >= 3) {
    return 3;
  }
  if (unique.size >= 2) {
    return 2;
  }
  return 1;
}

/**
 * Parse editor changes from response.
 */
function parseEditorChanges(content: string): string[] {
  const changes: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.trim().startsWith('-') || line.trim().startsWith('*') || line.trim().match(/^\d+\./)) {
      const change = line.replace(/^[-*]|\d+\.\s*/g, '').trim();
      if (change.length > 10) {
        changes.push(change);
      }
    }
  }

  return changes.slice(0, 10);
}

function parseStructuredEditorResponse(content: string): {
  revised_content: string;
  improvements_applied: string[];
  removed_repetition_count: number;
  clarity_notes: string[];
} {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    return {
      revised_content: typeof parsed.revised_content === 'string' ? parsed.revised_content.trim() : '',
      improvements_applied: Array.isArray(parsed.improvements_applied) ? parsed.improvements_applied.map(String) : [],
      removed_repetition_count: Number.isFinite(parsed.removed_repetition_count) ? Number(parsed.removed_repetition_count) : 0,
      clarity_notes: Array.isArray(parsed.clarity_notes) ? parsed.clarity_notes.map(String) : [],
    };
  } catch {
    return {
      revised_content: '',
      improvements_applied: [],
      removed_repetition_count: 0,
      clarity_notes: [],
    };
  }
}

function applyDeterministicStructuralCleanup(content: string, title: string): string {
  let text = normalizeDraftBody(content, title);
  const replacements: Array<[RegExp, string]> = [
    [/This article will (?:explore|cover) [^.]+\.\s*/gi, ''],
    [/In this article,?\s*/gi, ''],
    [/It is important to note that\s*/gi, ''],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return dedupeParagraphs(text).trim();
}

function dedupeParagraphs(content: string): string {
  const paragraphs = content.split(/\n{2,}/);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const key = paragraph.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(paragraph.trim());
  }
  return kept.join('\n\n');
}

function removeNearDuplicateParagraphs(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const fingerprints: string[] = [];
  const kept: string[] = [];

  for (const paragraph of paragraphs) {
    const fingerprint = paragraph
      .toLowerCase()
      .replace(/\b(according to|reported by|reports|states|said|says)\b/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!fingerprint) continue;
    if (fingerprints.includes(fingerprint)) continue;
    if (fingerprint.length < 48 && kept.length > 0) continue;

    fingerprints.push(fingerprint);
    kept.push(paragraph);
  }

  return kept.join('\n\n');
}

function estimateRepetitionReduction(before: string, after: string): number {
  const beforeCount = before.split(/\n{2,}/).length;
  const afterCount = after.split(/\n{2,}/).length;
  return Math.max(0, beforeCount - afterCount);
}

function runFactSourceCheckerPass(
  content: string,
  researchPack: ResearchPack
): { revised_content: string; artifact: FactSourceReviewArtifact; pass: EditorPass } {
  const weakClaims: string[] = [];
  const unsupportedUrls = findUnsupportedUrls(content, researchPack);
  let revised = content;

  revised = revised.replace(/\b(always|never|guarantees|proves|definitely|undeniably)\b/gi, (token) => {
    const softened = softenToken(token);
    if (softened.toLowerCase() !== token.toLowerCase() && weakClaims.length < 12) {
      weakClaims.push(`Softened wording: "${token}" -> "${softened}"`);
    }
    return softened;
  });

  for (const url of unsupportedUrls) {
    const escaped = escapeRegex(url);
    const linkPattern = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, 'g');
    revised = revised.replace(linkPattern, '$1');
    const urlPattern = new RegExp(escaped, 'g');
    revised = revised.replace(urlPattern, '');
  }
  revised = revised.replace(/\n{3,}/g, '\n\n').trim();

  const revisionsSummary: string[] = [];
  if (weakClaims.length > 0) revisionsSummary.push(`Softened ${weakClaims.length} overly-certain claim phrase(s).`);
  if (unsupportedUrls.length > 0) revisionsSummary.push(`Removed ${unsupportedUrls.length} unsupported external URL reference(s).`);
  if (revisionsSummary.length === 0) revisionsSummary.push('No factual support issues detected by deterministic checker.');

  return {
    revised_content: revised,
    artifact: {
      stage: 'fact_source_checker',
      weak_claims_softened: weakClaims,
      unsupported_urls_removed: unsupportedUrls,
      revisions_summary: revisionsSummary,
    },
    pass: {
      pass_number: 2,
      stage: 'fact_source_checker',
      changes_made: revisionsSummary,
      quality_score: unsupportedUrls.length > 0 ? 7 : 8,
      approved: true,
      notes: 'Fact/source checker pass applied with deterministic claim and source checks.',
    },
  };
}

function runTrustPolicyEditorPass(
  content: string
): { revised_content: string; artifact: TrustPolicyReviewArtifact; pass: EditorPass } {
  let revised = content;
  const riskyPhrases: string[] = [];
  const policySensitiveRevisions: string[] = [];

  const riskyMap: Array<{ pattern: RegExp; replacement: string; reason: string }> = [
    { pattern: /\b(no risk|risk[- ]free)\b/gi, replacement: 'lower risk in some cases', reason: 'absolute risk framing' },
    { pattern: /\b(foolproof|guaranteed)\b/gi, replacement: 'more reliable', reason: 'overpromising certainty' },
    { pattern: /\b(everyone should|you should always)\b/gi, replacement: 'many teams may want to', reason: 'over-generalized prescription' },
    { pattern: /\b(obviously|without question)\b/gi, replacement: 'in many cases', reason: 'misleading certainty cue' },
  ];

  for (const rule of riskyMap) {
    revised = revised.replace(rule.pattern, (match) => {
      if (riskyPhrases.length < 12) {
        riskyPhrases.push(`Softened "${match}" (${rule.reason})`);
      }
      return rule.replacement;
    });
  }

  const framingMap: Array<{ pattern: RegExp; replacement: string; note: string }> = [
    { pattern: /\bthis proves\b/gi, replacement: 'this suggests', note: 'converted proof claim to evidence-based phrasing' },
    { pattern: /\bthe only way\b/gi, replacement: 'one common approach', note: 'removed exclusivity framing' },
  ];
  for (const rule of framingMap) {
    revised = revised.replace(rule.pattern, () => {
      if (policySensitiveRevisions.length < 12) {
        policySensitiveRevisions.push(rule.note);
      }
      return rule.replacement;
    });
  }

  revised = revised.replace(/\n{3,}/g, '\n\n').trim();

  const trustNotes: string[] = [];
  if (riskyPhrases.length > 0) {
    trustNotes.push(`Softened ${riskyPhrases.length} risky certainty/promise phrase(s).`);
  }
  if (policySensitiveRevisions.length > 0) {
    trustNotes.push(`Adjusted ${policySensitiveRevisions.length} policy-sensitive framing phrase(s).`);
  }
  if (trustNotes.length === 0) {
    trustNotes.push('No trust/policy phrasing issues detected by deterministic pass.');
  }

  return {
    revised_content: revised,
    artifact: {
      stage: 'trust_policy_editor',
      risky_phrases_softened: riskyPhrases,
      policy_sensitive_revisions: policySensitiveRevisions,
      trust_notes: trustNotes,
    },
    pass: {
      pass_number: 3,
      stage: 'trust_policy_editor',
      changes_made: trustNotes,
      quality_score: riskyPhrases.length > 0 ? 8 : 9,
      approved: true,
      notes: 'Trust/policy editor pass applied with deterministic phrasing safeguards.',
    },
  };
}

function runFinalReadabilityPass(
  content: string,
  title: string,
  articleType: CanonicalArticleType
): { revised_content: string; pass: EditorPass } {
  const before = content || '';
  let revised = before;

  revised = revised.replace(/\r\n/g, '\n');
  revised = revised.replace(/^\s*#\s+.+$/gm, (heading) => heading.replace(/\s+/g, ' ').trim());
  revised = revised.replace(/\bAccording to available reporting,\s*/gi, '');
  revised = revised.replace(/\bIn summary,\s*/gi, '');
  revised = revised.replace(/\n{3,}/g, '\n\n');

  // Tight deterministic line edits to reduce robot-like transition clutter.
  revised = revised.replace(/\bAt the same time,\s+At the same time,\s+/gi, 'At the same time, ');
  revised = revised.replace(/\bThis case also appears in the context of\b/gi, 'The case also sits within');
  revised = revised.replace(/\bAs of the latest reports,\s+As of the latest reports,/gi, 'As of the latest reports,');
  revised = revised.replace(/(^|\n\n)(First,\s+)/gi, '$1');
  revised = revised.replace(/(^|\n\n)(Second,\s+)/gi, '$1At the same time, ');
  revised = revised.replace(/(^|\n\n)(Third,\s+)/gi, '$1More broadly, ');
  revised = revised.replace(/(^|\n\n)(Finally,\s+)/gi, '$1Taken together, ');
  revised = revised.replace(/\s+\.\s*/g, '. ');
  revised = revised.replace(/\.\s+\.\s+/g, '. ');

  revised = ensureForecastSectionHeading(revised, articleType);
  revised = removeNearDuplicateParagraphs(revised);
  revised = revised.replace(/\n{3,}/g, '\n\n').trim();

  const changeCount = countRoughReadabilityChanges(before, revised);
  const notes = [
    `Applied readability tighten pass for ${articleType} article output.`,
    changeCount > 0
      ? `Removed/merged approximately ${changeCount} repetitive or low-value fragment(s).`
      : 'No major readability changes were required.',
  ];

  return {
    revised_content: revised,
    pass: {
      pass_number: 4,
      stage: 'reader_editor',
      changes_made: notes,
      quality_score: 9,
      approved: true,
      notes: `Final reader-editor pass applied before claim-map extraction for "${title}".`,
    },
  };
}

function countRoughReadabilityChanges(before: string, after: string): number {
  const beforeParts = before.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length;
  const afterParts = after.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length;
  return Math.max(0, beforeParts - afterParts);
}

function ensureForecastSectionHeading(content: string, articleType: CanonicalArticleType): string {
  const normalized = (content || '').trim();
  if (!normalized) return normalized;
  const headingPattern = /(^|\n)##\s+(Where This Could Lead|What Comes Next|What This Could Mean|Possible Outcomes|What May Happen Next|Where This Is Heading)\s*$/im;
  if (headingPattern.test(normalized)) {
    return normalized;
  }

  const heading = getForecastSectionHeadingOptions(articleType)[0] || 'Where This Could Lead';
  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length < 3) {
    return `${normalized}\n\n## ${heading}`.trim();
  }

  const forecastParagraphIndex = findForecastParagraphIndex(paragraphs);
  if (forecastParagraphIndex === -1) {
    return normalized;
  }

  const rebuilt: string[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (index === forecastParagraphIndex) {
      rebuilt.push(`## ${heading}`);
    }
    rebuilt.push(paragraph);
  });
  return rebuilt.join('\n\n').trim();
}

function findForecastParagraphIndex(paragraphs: string[]): number {
  for (let index = Math.max(0, paragraphs.length - 3); index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index] || '';
    if (/^#{1,6}\s+/.test(paragraph)) continue;
    if (/\b(could|may|might|likely|watch next|next step|pressure point|outcome|where this could lead|where this is heading)\b/i.test(paragraph)) {
      return index;
    }
  }
  return paragraphs.length >= 5 ? paragraphs.length - 1 : -1;
}

async function runSurgicalRevisionPass(
  originalContent: string,
  packet: RevisionRepairPacket,
  apiKey: string,
  modelTrace: RuntimeModelApiTraceEntry[]
): Promise<string> {
  const prompt = buildSurgicalRevisionPrompt(originalContent, packet);
  const response = await callOpenAI(
    [
      {
        role: 'system',
        content:
          'You are a surgical editorial reviser. Edit only where necessary. Keep English only. Do not add unsupported claims.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    apiKey,
    {
      stage_name: 'surgical_revision',
      model_trace: modelTrace,
      model: 'gpt-5.1',
      temperature: 0.15,
      max_tokens: 2400,
    }
  );

  const content = (response.choices?.[0]?.message?.content || '').trim();
  if (!content) {
    return applyDeterministicFallbackRevision(originalContent, packet);
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { revised_content?: string };
      if (parsed.revised_content && parsed.revised_content.trim()) {
        return applyClaimTargetedDeterministicRevision(parsed.revised_content.trim(), packet);
      }
    } catch {
      // fall back to plain content path below
    }
  }

  return applyClaimTargetedDeterministicRevision(content, packet);
}

function buildRevisionRepairPacket(result: ArticleRuntimeResult): RevisionRepairPacket {
  const unsupportedClaims = result.claim_map.entries
    .filter((entry) => entry.support_status === 'unsupported')
    .slice(0, 10);
  const partiallySupportedClaims = result.claim_map.entries
    .filter((entry) => entry.support_status === 'partially_supported')
    .slice(0, 10);
  const evidenceAnchors = getPriorityEvidenceForDraft(result.research_pack, 14).map((item) => ({
    id: item.id,
    claim: compactPromptText(item.claim, 220),
    excerpt: compactPromptText(item.excerpt, 220),
    source_url: item.source_url,
    source_title: compactPromptText(item.source || safeDomain(item.source_url) || 'Source', 120),
  }));
  const claimRepairDirectives = buildClaimRepairDirectives(
    [...unsupportedClaims, ...partiallySupportedClaims],
    result.research_pack
  );
  const paragraphRepairTargets = buildParagraphRepairTargets(
    result.draft.content,
    unsupportedClaims,
    partiallySupportedClaims,
    result.research_pack
  );

  return {
    chief_editor_blockers: result.chief_editor_review.blocking_issues,
    claim_failures: result.claim_map_gate.failure_reasons,
    source_quality_concerns: result.source_quality_review.concerns,
    fact_source_issues: result.fact_source_review.revisions_summary,
    unsupported_claims: unsupportedClaims,
    partially_supported_claims: partiallySupportedClaims,
    known_source_urls: result.research_pack.sources.map((source) => source.url),
    evidence_anchors: evidenceAnchors,
    claim_repair_directives: claimRepairDirectives,
    paragraph_repair_targets: paragraphRepairTargets,
  };
}

function buildSurgicalRevisionPrompt(originalContent: string, packet: RevisionRepairPacket): string {
  const unsupported = packet.unsupported_claims
    .map(
      (entry, index) =>
        `${index + 1}. Claim: "${entry.claim_text}" | action required: delete OR narrow OR re-attribute OR replace with directly supported evidence`
    )
    .join('\n');
  const partial = packet.partially_supported_claims
    .map((entry, index) => `${index + 1}. "${entry.claim_text}" -> narrow wording and add explicit attribution.`)
    .join('\n');
  const claimDirectives = packet.claim_repair_directives
    .map(
      (directive, index) =>
        `${index + 1}. ${directive.support_status.toUpperCase()} | "${directive.claim_text}" | actions: ${directive.recommended_actions.join(', ')} | evidence_ids: ${directive.supporting_evidence_ids.join(', ') || 'none'} | source_urls: ${directive.supporting_source_urls.join(', ') || 'none'} | reason: ${directive.reason}`
    )
    .join('\n');
  const evidenceAnchors = packet.evidence_anchors
    .map(
      (item) =>
        `- [${item.id}] ${item.claim} | excerpt: ${item.excerpt} (Source: ${item.source_title} - ${item.source_url})`
    )
    .join('\n');
  const paragraphTargets = packet.paragraph_repair_targets
    .map(
      (target) =>
        `${target.paragraph_index + 1}. issue=${target.issue} | actions=${target.recommended_actions.join(', ')} | evidence_ids=${target.supporting_evidence_ids.join(', ') || 'none'} | source_urls=${target.supporting_source_urls.join(', ') || 'none'} | excerpt="${target.paragraph_excerpt}"`
    )
    .join('\n');

  return `You must perform a paragraph-level repair of this article, not a freeform rewrite.

Return JSON only:
{
  "revised_content": "full revised markdown content"
}

Rules:
- Keep structure and sections unless a claim requires deletion.
- For unsupported claims, explicitly choose one action: delete, narrow, re-attribute, or replace with directly supported wording.
- For unsupported/partial claims, use the claim repair directives and evidence anchors below.
- Do not introduce broad new claims.
- Keep all user-facing text in English.
- Remove internal/debug/service style text if present.
- Keep source links truthful.
- Prefer deleting weak unsupported text over preserving prose smoothness.
- Keep revisions claim-targeted; avoid rewriting unrelated paragraphs.
- Inspect weak paragraphs directly. When a paragraph mixes supported and unsupported content, remove only the unsupported fragment and preserve supported details.
- Prefer splitting blended factual paragraphs into multiple tighter paragraphs tied to one evidence-backed point each.
- Every factual paragraph you keep should be attributable to evidence anchors or known valid URLs.
- Treat URL-only factual sentences with weak anchor/excerpt overlap as unsupported: rewrite narrowly from anchors or delete.

Chief editor blockers:
${packet.chief_editor_blockers.map((item) => `- ${item}`).join('\n') || '- none'}

Claim-map failures:
${packet.claim_failures.map((item) => `- ${item}`).join('\n') || '- none'}

Source-quality concerns:
${packet.source_quality_concerns.map((item) => `- ${item}`).join('\n') || '- none'}

Fact/source issues:
${packet.fact_source_issues.map((item) => `- ${item}`).join('\n') || '- none'}

Unsupported claims to repair:
${unsupported || '- none'}

Partially supported claims to narrow:
${partial || '- none'}

Claim-targeted repair directives:
${claimDirectives || '- none'}

Weak paragraph repair targets:
${paragraphTargets || '- none'}

Evidence anchors available for replacement/narrowing:
${evidenceAnchors || '- none'}

Known valid source URLs:
${packet.known_source_urls.map((url) => `- ${url}`).join('\n') || '- none'}

Original content:
${originalContent}
`;
}

function applyDeterministicFallbackRevision(originalContent: string, packet: RevisionRepairPacket): string {
  return applyClaimTargetedDeterministicRevision(originalContent, packet);
}

function shouldAttemptDeterministicClaimPrune(gate: ClaimMapGateResult): boolean {
  if (gate.valid) {
    return false;
  }
  return gate.failure_reasons.some((reason) =>
    /unsupported claims exceed threshold|weakly grounded claims exceed threshold/i.test(reason)
  );
}


function preserveEditorialLength(
  previousContent: string,
  revisedContent: string,
  articleType: CanonicalArticleType
): string {
  const previous = (previousContent || '').trim();
  const revised = (revisedContent || '').trim();
  if (!revised) {
    return previous;
  }

  const previousWords = previous.split(/\s+/).filter(Boolean).length;
  const revisedWords = revised.split(/\s+/).filter(Boolean).length;
  const targetFloor = getTargetWordRange(articleType).min;
  const severeShrinkThreshold = Math.max(targetFloor, Math.floor(previousWords * 0.8));

  if (previousWords >= targetFloor && revisedWords < severeShrinkThreshold) {
    return previous;
  }
  return revised;
}

function ensureMinimumRevisionLength(
  originalContent: string,
  revisedContent: string,
  packet: RevisionRepairPacket,
  minimumWords: number
): string {
  const revisedWordCount = revisedContent.split(/\s+/).filter(Boolean).length;
  if (revisedWordCount >= minimumWords) {
    return revisedContent;
  }

  const knownUrls = new Set(packet.known_source_urls);
  const anchorTokens = new Set(
    packet.evidence_anchors.flatMap((anchor) =>
      Array.from(tokenizeForOverlap(`${anchor.claim} ${anchor.excerpt} ${anchor.source_title}`))
    )
  );
  const mergedParagraphs = revisedContent
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const seen = new Set(mergedParagraphs.map((paragraph) => paragraph.toLowerCase().replace(/\s+/g, ' ').trim()));

  const fallbackCandidates = originalContent
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .filter((paragraph) => {
      if (/^#{1,6}\s+/.test(paragraph)) return false;
      const key = paragraph.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      const urls = extractUrlsFromText(paragraph);
      const hasKnownUrl = urls.some((url) => knownUrls.has(url));
      const hasEvidenceId = /\bE\d{3}\b/.test(paragraph);
      const hasAnchorOverlap = hasEvidenceAnchorOverlap(paragraph, anchorTokens);
      return hasEvidenceId || hasAnchorOverlap || hasKnownUrl;
    });

  for (const paragraph of fallbackCandidates) {
    mergedParagraphs.push(paragraph);
    const key = paragraph.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key) {
      seen.add(key);
    }
    const words = mergedParagraphs.join(' ').split(/\s+/).filter(Boolean).length;
    if (words >= minimumWords) {
      break;
    }
  }

  return dedupeParagraphs(mergedParagraphs.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
}

function buildClaimRepairDirectives(
  claims: ClaimMapEntry[],
  researchPack: ResearchPack
): RevisionRepairPacket['claim_repair_directives'] {
  const directives: RevisionRepairPacket['claim_repair_directives'] = [];
  const dedupe = new Set<string>();

  for (const claim of claims) {
    if (claim.support_status !== 'unsupported' && claim.support_status !== 'partially_supported') {
      continue;
    }
    const key = `${claim.support_status}:${claim.claim_text}`.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    const bestEvidence = findBestSupportingEvidence(claim.claim_text, researchPack);
    const supportingEvidenceIds = bestEvidence?.evidence ? [bestEvidence.evidence.id] : [];
    const supportingSourceUrls = bestEvidence?.evidence?.source_url ? [bestEvidence.evidence.source_url] : [];
    const recommendedActions: Array<'delete' | 'narrow' | 're_attribute' | 'replace_with_supported_evidence'> =
      claim.support_status === 'unsupported'
        ? ['delete', 'replace_with_supported_evidence', 'narrow', 're_attribute']
        : ['narrow', 're_attribute', 'replace_with_supported_evidence', 'delete'];

    directives.push({
      claim_text: compactPromptText(claim.claim_text, 280),
      support_status: claim.support_status,
      recommended_actions: recommendedActions,
      supporting_evidence_ids: supportingEvidenceIds,
      supporting_source_urls: supportingSourceUrls,
      reason:
        claim.support_status === 'unsupported'
          ? 'Claim has no reliable evidence match in current pack and should be removed or replaced with attributable support.'
          : 'Claim has only partial overlap and should be narrowed and re-attributed to matched evidence.',
    });

    if (directives.length >= 14) {
      break;
    }
  }

  return directives;
}

function buildParagraphRepairTargets(
  content: string,
  unsupportedClaims: ClaimMapEntry[],
  partiallySupportedClaims: ClaimMapEntry[],
  researchPack: ResearchPack
): RevisionRepairPacket['paragraph_repair_targets'] {
  const knownUrls = new Set(researchPack.sources.map((source) => source.url));
  const anchorTokens = new Set(
    getPriorityEvidenceForDraft(researchPack, 16).flatMap((item) =>
      Array.from(tokenizeForOverlap(`${item.claim} ${item.excerpt}`))
    )
  );
  const unsupportedFragments = unsupportedClaims
    .map((entry) => normalizeClaimFragment(entry.claim_text))
    .filter((fragment) => fragment.length >= 24);
  const partialFragments = partiallySupportedClaims
    .map((entry) => normalizeClaimFragment(entry.claim_text))
    .filter((fragment) => fragment.length >= 24);

  const targets: RevisionRepairPacket['paragraph_repair_targets'] = [];
  const dedupe = new Set<string>();
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (/^#{1,6}\s+/.test(paragraph)) {
      continue;
    }

    const lower = paragraph.toLowerCase();
    const urls = extractUrlsFromText(paragraph);
    const knownParagraphUrls = urls.filter((url) => knownUrls.has(url));
    const hasKnownUrl = knownParagraphUrls.length > 0;
    const hasEvidenceId = /\bE\d{3}\b/.test(paragraph);
    const hasAnchorOverlap = hasEvidenceAnchorOverlap(paragraph, anchorTokens);
    const claimLike = isClaimLikeParagraph(paragraph);
    const hitsUnsupported = unsupportedFragments.some((fragment) => lower.includes(fragment));
    const hitsPartial = partialFragments.some((fragment) => lower.includes(fragment));

    let issue: RevisionRepairPacket['paragraph_repair_targets'][number]['issue'] | null = null;
    let recommendedActions: RevisionRepairPacket['paragraph_repair_targets'][number]['recommended_actions'] = [
      'narrow',
      're_attribute',
      'split',
    ];
    if (hitsUnsupported) {
      issue = 'unsupported_fragment';
      recommendedActions = ['delete', 'replace_with_supported_evidence', 'narrow', 're_attribute', 'split'];
    } else if (hitsPartial) {
      issue = 'partial_fragment';
      recommendedActions = ['narrow', 're_attribute', 'replace_with_supported_evidence', 'split', 'delete'];
    } else if (claimLike && !hasKnownUrl && !hasEvidenceId && !hasAnchorOverlap) {
      issue = 'broad_without_anchor';
      recommendedActions = ['delete', 'narrow', 're_attribute', 'split', 'replace_with_supported_evidence'];
    }

    if (!issue) {
      continue;
    }

    const bestEvidence = findBestSupportingEvidence(paragraph, researchPack);
    const supportingSourceUrls = [
      ...knownParagraphUrls,
      ...(bestEvidence?.evidence?.source_url ? [bestEvidence.evidence.source_url] : []),
    ].filter((url, position, array) => array.indexOf(url) === position);
    const supportingEvidenceIds = bestEvidence?.evidence?.id ? [bestEvidence.evidence.id] : [];
    const excerpt = compactPromptText(paragraph.replace(/\s+/g, ' ').trim(), 220);
    const dedupeKey = `${issue}:${excerpt.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);

    targets.push({
      paragraph_index: index,
      paragraph_excerpt: excerpt,
      issue,
      recommended_actions: recommendedActions,
      supporting_source_urls: supportingSourceUrls.slice(0, 3),
      supporting_evidence_ids: supportingEvidenceIds,
    });

    if (targets.length >= 12) {
      break;
    }
  }

  return targets;
}

function applyClaimTargetedDeterministicRevision(content: string, packet: RevisionRepairPacket): string {
  const unsupportedFragments = packet.unsupported_claims
    .map((entry) => normalizeClaimFragment(entry.claim_text))
    .filter(Boolean);
  const partialFragments = packet.partially_supported_claims
    .map((entry) => normalizeClaimFragment(entry.claim_text))
    .filter(Boolean);
  const knownUrls = new Set(packet.known_source_urls);
  const anchorTokens = new Set(
    packet.evidence_anchors.flatMap((anchor) =>
      Array.from(tokenizeForOverlap(`${anchor.claim} ${anchor.excerpt} ${anchor.source_title}`))
    )
  );
  const revisedParagraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const repaired: string[] = [];
  for (let index = 0; index < revisedParagraphs.length; index += 1) {
    const paragraph = revisedParagraphs[index];
    if (/^#{1,6}\s+/.test(paragraph)) {
      repaired.push(paragraph);
      continue;
    }

    const target = findParagraphRepairTarget(index, paragraph, packet.paragraph_repair_targets);
    const tightened = tightenRevisionParagraphToEvidenceUnits(
      paragraph,
      unsupportedFragments,
      partialFragments,
      knownUrls,
      anchorTokens,
      packet.evidence_anchors,
      target
    );
    repaired.push(...tightened);
  }

  return dedupeParagraphs(repaired.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
}

function findParagraphRepairTarget(
  paragraphIndex: number,
  paragraph: string,
  targets: RevisionRepairPacket['paragraph_repair_targets']
): RevisionRepairPacket['paragraph_repair_targets'][number] | undefined {
  const direct = targets.find((target) => target.paragraph_index === paragraphIndex);
  if (direct) {
    return direct;
  }
  const normalized = paragraph.toLowerCase().replace(/\s+/g, ' ').trim();
  return targets.find((target) => {
    const excerpt = target.paragraph_excerpt.toLowerCase().replace(/\s+/g, ' ').trim();
    return excerpt.length >= 32 && normalized.includes(excerpt.slice(0, Math.min(100, excerpt.length)));
  });
}

function assessSentenceAgainstPacketAnchors(
  sentence: string,
  signals: SentenceGroundingSignals,
  anchors: RevisionRepairPacket['evidence_anchors']
): SentenceEvidenceAssessment {
  const sentenceTokens = tokenizeForOverlap(sentence);
  let best:
    | {
        score: number;
        claim: string;
        source_url: string;
        source_title: string;
      }
    | undefined;

  for (const anchor of anchors) {
    const anchorTokens = tokenizeForOverlap(`${anchor.claim} ${anchor.excerpt}`);
    if (sentenceTokens.size === 0 || anchorTokens.size === 0) {
      continue;
    }
    const overlap = intersectCount(sentenceTokens, anchorTokens);
    if (overlap === 0) {
      continue;
    }
    const score = overlap / Math.min(sentenceTokens.size, anchorTokens.size);
    if (!best || score > best.score) {
      best = {
        score,
        claim: anchor.claim,
        source_url: anchor.source_url,
        source_title: anchor.source_title,
      };
    }
  }

  const bestScore = best?.score ?? 0;
  const strongSupport =
    signals.has_evidence_id ||
    bestScore >= STRONG_SENTENCE_EVIDENCE_SCORE ||
    (signals.has_anchor_overlap && bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE);
  const weakUrlOnly = signals.claim_like && signals.has_known_url && !signals.has_evidence_id && !strongSupport;
  const salvageableByRewrite =
    signals.claim_like &&
    !strongSupport &&
    bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE &&
    hasConcreteSpecificityCue(sentence) &&
    Boolean(best?.source_url) &&
    Boolean(best?.claim);
  const salvageableUrlOnly =
    weakUrlOnly &&
    bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE &&
    hasConcreteSpecificityCue(sentence) &&
    Boolean(best?.source_url);

  return {
    strong_support: strongSupport,
    weak_url_only: weakUrlOnly,
    salvageable_url_only: salvageableUrlOnly,
    salvageable_by_rewrite: salvageableByRewrite,
    best_score: Number(bestScore.toFixed(3)),
    best_claim: best?.claim,
    best_source_url: best?.source_url,
    best_source_title: best?.source_title,
  };
}

function tightenRevisionParagraphToEvidenceUnits(
  paragraph: string,
  unsupportedFragments: string[],
  partialFragments: string[],
  knownUrls: Set<string>,
  anchorTokens: Set<string>,
  evidenceAnchors: RevisionRepairPacket['evidence_anchors'],
  target?: RevisionRepairPacket['paragraph_repair_targets'][number]
): string[] {
  const sentences = splitIntoSentences(paragraph);
  if (sentences.length === 0) {
    return [];
  }

  const kept: Array<{ text: string; claim_like: boolean }> = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const signals = getSentenceGroundingSignals(sentence, knownUrls, anchorTokens);
    const assessment = assessSentenceAgainstPacketAnchors(sentence, signals, evidenceAnchors);
    const hitsUnsupported = unsupportedFragments.some((fragment) => fragment.length >= 24 && lower.includes(fragment));
    const hitsPartial = partialFragments.some((fragment) => fragment.length >= 24 && lower.includes(fragment));

    if (hitsUnsupported && !assessment.strong_support) {
      continue;
    }
    if (target?.issue === 'broad_without_anchor' && signals.claim_like && !assessment.strong_support) {
      continue;
    }
    if (signals.claim_like && !assessment.strong_support) {
      if (!assessment.salvageable_by_rewrite) {
        continue;
      }
    }

    let next = sentence;
    if ((hitsPartial || assessment.salvageable_by_rewrite) && assessment.best_claim) {
      const rewritten = buildNarrowEvidenceSentence(
        assessment.best_claim,
        assessment.best_source_title,
        assessment.best_source_url
      );
      if (rewritten) {
        next = rewritten;
      }
    }

    if (signals.claim_like || hitsUnsupported || hitsPartial) {
      next = softenAbsoluteLanguage(next);
    }

    if (!signals.has_known_url && assessment.strong_support) {
      const sourceUrl = target?.supporting_source_urls[0] || assessment.best_source_url;
      if (sourceUrl) {
        next = appendInlineSourceCitation(next, sourceUrl);
      }
    }

    const normalized = next.replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) {
      kept.push({ text: normalized, claim_like: signals.claim_like });
    }
  }

  if (kept.length === 0) {
    return [];
  }

  const grouped: string[] = [];
  let current: string[] = [];
  let currentHasClaim = false;
  const flushCurrent = () => {
    if (current.length > 0) {
      grouped.push(current.join(' ').trim());
      current = [];
      currentHasClaim = false;
    }
  };

  for (const item of kept) {
    if (item.claim_like) {
      if (currentHasClaim) {
        flushCurrent();
      }
      current.push(item.text);
      currentHasClaim = true;
      continue;
    }

    if (!currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    if (currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    current.push(item.text);
  }
  flushCurrent();

  return grouped.filter((item) => item.length >= 35);
}

function normalizeClaimFragment(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 90);
}

function hasEvidenceAnchorOverlap(paragraph: string, anchorTokens: Set<string>): boolean {
  if (anchorTokens.size === 0) return false;
  const paragraphTokens = tokenizeForOverlap(paragraph);
  if (paragraphTokens.size === 0) return false;
  return intersectCount(paragraphTokens, anchorTokens) >= 2;
}

function softenAbsoluteLanguage(paragraph: string): string {
  return paragraph
    .replace(/\b(always|never|guarantees|prove|proves|definitely|undeniably|certainly)\b/gi, (token) =>
      softenToken(token)
    )
    .replace(/\b(will)\b/gi, 'may')
    .replace(/\b(led to|caused)\b/gi, 'was associated with');
}

function lowercaseFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function evaluatePreAuthorSourceSufficiency(
  validatedSources: ValidatedSource[],
  researchPack: ResearchPack
): PreAuthorSourceSufficiencyGate {
  const configuredMinimumTotalSources = readRuntimeIntEnv('PIPELINE_PRE_AUTHOR_MIN_TOTAL_SOURCES', 3, 1, 12);
  const configuredMinimumTotalEvidenceItems = readRuntimeIntEnv('PIPELINE_PRE_AUTHOR_MIN_EVIDENCE_ITEMS', 6, 1, 40);
  const configuredMinimumUniqueDomains = readRuntimeIntEnv('PIPELINE_PRE_AUTHOR_MIN_UNIQUE_DOMAINS', 2, 1, 10);
  const configuredMinimumSourceTypeDiversity = readRuntimeIntEnv('PIPELINE_PRE_AUTHOR_MIN_SOURCE_TYPE_DIVERSITY', 1, 1, 6);
  const configuredMinimumKeyQuestionCoverageRatio = readRuntimeFloatEnv(
    'PIPELINE_PRE_AUTHOR_MIN_KEY_QUESTION_COVERAGE',
    0.5,
    0.1,
    1
  );
  const configuredMinimumHighCredibilitySources = readRuntimeIntEnv(
    'PIPELINE_PRE_AUTHOR_MIN_HIGH_CREDIBILITY_SOURCES',
    2,
    1,
    8
  );
  const configuredMaximumWeakSourceShare = readRuntimeFloatEnv('PIPELINE_PRE_AUTHOR_MAX_WEAK_SOURCE_SHARE', 0.5, 0.1, 0.9);

  const totalSources = validatedSources.length;
  const totalEvidenceItems = researchPack.source_coverage_summary.total_evidence_items;
  const uniqueDomains = new Set(validatedSources.map((source) => safeDomain(source.url))).size;
  const sourceTypeDiversity = new Set(validatedSources.map((source) => (source.source_type || 'unknown').toLowerCase())).size;
  const keyQuestionsTotal = researchPack.key_questions.length || 1;
  const keyQuestionsCovered = researchPack.grouped_findings_by_question.filter((group) => group.findings.length > 0).length;
  const keyQuestionCoverageRatio = Number((keyQuestionsCovered / keyQuestionsTotal).toFixed(2));
  const primaryLikeSources = validatedSources.filter((source) =>
    ['primary', 'government', 'academic', 'data'].includes(source.source_type)
  ).length;
  const strongSources = validatedSources.filter((source) =>
    source.credibility_score >= 5 || ['primary', 'government', 'academic', 'data'].includes(source.source_type)
  ).length;
  const moderateSources = validatedSources.filter((source) => source.credibility_score >= 3 && source.credibility_score < 5).length;
  const weakSources = Math.max(0, totalSources - strongSources - moderateSources);
  const highCredibilitySources = validatedSources.filter((source) => source.credibility_score >= 4).length;
  const averageRelevanceScore =
    totalSources > 0
      ? Number((validatedSources.reduce((sum, source) => sum + (source.relevance_score || 0), 0) / totalSources).toFixed(2))
      : 0;
  const weakSourceShare = totalSources > 0 ? weakSources / totalSources : 1;

  const topic = String((researchPack as { topic?: string }).topic || '').trim();
  const highRiskTopic = isHighRiskTopic(topic);
  const trustedStraightNewsOrOfficialSources = validatedSources.filter((source) => {
    const normalizedSourceType = String(source.source_type || 'unknown').toLowerCase();
    return (
      Number(source.credibility_score || 0) >= 4 &&
      /^(news|primary|government|academic|data)$/i.test(normalizedSourceType)
    );
  }).length;

  const hasSingleStrongPrimaryAnchor =
    !highRiskTopic &&
    totalSources === 1 &&
    primaryLikeSources >= 1 &&
    trustedStraightNewsOrOfficialSources >= 1 &&
    totalEvidenceItems >= 6 &&
    uniqueDomains >= 1 &&
    highCredibilitySources >= 1 &&
    keyQuestionCoverageRatio >= 0.35 &&
    averageRelevanceScore >= 6.5;

  const minimumTotalSources = hasSingleStrongPrimaryAnchor
    ? 1
    : configuredMinimumTotalSources;
  const minimumTotalEvidenceItems = hasSingleStrongPrimaryAnchor
    ? Math.max(configuredMinimumTotalEvidenceItems, 6)
    : configuredMinimumTotalEvidenceItems;
  const minimumUniqueDomains = hasSingleStrongPrimaryAnchor
    ? 1
    : configuredMinimumUniqueDomains;
  const minimumSourceTypeDiversity = configuredMinimumSourceTypeDiversity;
  const minimumKeyQuestionCoverageRatio = hasSingleStrongPrimaryAnchor
    ? Math.max(configuredMinimumKeyQuestionCoverageRatio, 0.35)
    : configuredMinimumKeyQuestionCoverageRatio;
  const minimumHighCredibilitySources = hasSingleStrongPrimaryAnchor
    ? 1
    : configuredMinimumHighCredibilitySources;
  const maximumWeakSourceShare = hasSingleStrongPrimaryAnchor
    ? 0.5
    : configuredMaximumWeakSourceShare;
  const minimumAverageRelevanceScore = hasSingleStrongPrimaryAnchor ? 6.5 : 5.5;

  const failureReasons: string[] = [];
  if (totalSources < minimumTotalSources) {
    failureReasons.push(`Validated sources below minimum (${totalSources} < ${minimumTotalSources}).`);
  }
  if (totalEvidenceItems < minimumTotalEvidenceItems) {
    failureReasons.push(`Evidence items below minimum (${totalEvidenceItems} < ${minimumTotalEvidenceItems}).`);
  }
  if (uniqueDomains < minimumUniqueDomains) {
    failureReasons.push(`Unique source domains below minimum (${uniqueDomains} < ${minimumUniqueDomains}).`);
  }
  if (sourceTypeDiversity < minimumSourceTypeDiversity) {
    failureReasons.push(`Source-type diversity below minimum (${sourceTypeDiversity} < ${minimumSourceTypeDiversity}).`);
  }
  if (keyQuestionCoverageRatio < minimumKeyQuestionCoverageRatio) {
    failureReasons.push(
      `Key-question evidence coverage below minimum (${keyQuestionCoverageRatio.toFixed(2)} < ${minimumKeyQuestionCoverageRatio}).`
    );
  }
  if (highCredibilitySources < minimumHighCredibilitySources) {
    failureReasons.push(
      `High-credibility sources below minimum (${highCredibilitySources} < ${minimumHighCredibilitySources}).`
    );
  }
  if (weakSourceShare > maximumWeakSourceShare) {
    failureReasons.push(`Weak-source share above maximum (${weakSourceShare.toFixed(2)} > ${maximumWeakSourceShare}).`);
  }
  if (averageRelevanceScore < minimumAverageRelevanceScore) {
    failureReasons.push(`Average relevance too low (${averageRelevanceScore} < ${minimumAverageRelevanceScore}).`);
  }

  return {
    gate: 'pre_author_source_sufficiency',
    valid: failureReasons.length === 0,
    total_sources: totalSources,
    total_evidence_items: totalEvidenceItems,
    unique_domains: uniqueDomains,
    source_type_diversity: sourceTypeDiversity,
    key_question_coverage_ratio: keyQuestionCoverageRatio,
    primary_like_sources: primaryLikeSources,
    strong_sources: strongSources,
    moderate_sources: moderateSources,
    weak_sources: weakSources,
    high_credibility_sources: highCredibilitySources,
    average_relevance_score: averageRelevanceScore,
    minimum_total_sources: minimumTotalSources,
    minimum_total_evidence_items: minimumTotalEvidenceItems,
    minimum_unique_domains: minimumUniqueDomains,
    minimum_source_type_diversity: minimumSourceTypeDiversity,
    minimum_key_question_coverage_ratio: minimumKeyQuestionCoverageRatio,
    minimum_high_credibility_sources: minimumHighCredibilitySources,
    maximum_weak_source_share: maximumWeakSourceShare,
    failure_reasons: failureReasons,
  };
}

function evaluateSourceQuality(researchPack: ResearchPack): {
  review: SourceQualityReviewArtifact;
  gate: SourceQualityGateResult;
} {
  const entries: SourceQualityEntry[] = researchPack.sources.map((source) => {
    const domain = safeDomain(source.url);
    const tier = classifySourceQualityTier(source.type, source.credibility, domain);
    const rationale = buildSourceTierRationale(source.type, source.credibility, tier, domain);
    return {
      url: source.url,
      title: source.title,
      domain,
      source_type: source.type,
      credibility: source.credibility,
      evidence_count: source.evidence_count,
      tier,
      rationale,
    };
  });

  const totalEvidence = researchPack.evidence_items.length || 1;
  const weakEvidenceCount = entries
    .filter((entry) => entry.tier === 'weak')
    .reduce((sum, entry) => sum + entry.evidence_count, 0);
  const strongEvidenceCount = entries
    .filter((entry) => entry.tier === 'strong')
    .reduce((sum, entry) => sum + entry.evidence_count, 0);
  const primaryLikeEvidenceCount = entries
    .filter((entry) => isPrimaryLikeSource(entry.source_type, entry.domain))
    .reduce((sum, entry) => sum + entry.evidence_count, 0);
  const weakEvidenceShare = weakEvidenceCount / totalEvidence;
  const strongEvidenceShare = strongEvidenceCount / totalEvidence;
  const primaryLikeEvidenceShare = primaryLikeEvidenceCount / totalEvidence;
  const uniqueDomains = new Set(entries.map((entry) => entry.domain).filter(Boolean));
  const sourceTypeMix: Record<string, number> = {};
  for (const entry of entries) {
    sourceTypeMix[entry.source_type] = (sourceTypeMix[entry.source_type] || 0) + 1;
  }

  const strongSources = entries.filter((entry) => entry.tier === 'strong').length;
  const moderateSources = entries.filter((entry) => entry.tier === 'moderate').length;
  const weakSources = entries.filter((entry) => entry.tier === 'weak').length;
  const primaryLikeSources = entries.filter((entry) => isPrimaryLikeSource(entry.source_type, entry.domain)).length;
  const topicRequiresPrimaryLike = topicNeedsPrimaryLikeAnchors(researchPack.topic);

  const concerns: string[] = [];
  if (entries.length > 0 && weakSources === entries.length) {
    concerns.push('All retained sources are weak quality classes.');
  }
  if (weakEvidenceShare > 0.5) {
    concerns.push(`Weak sources account for a high evidence share (${weakEvidenceShare.toFixed(2)}).`);
  }
  if (strongSources === 0 && moderateSources < 2) {
    concerns.push('No strong sources and fewer than two moderate sources are present.');
  }
  if (uniqueDomains.size < Math.min(3, Math.max(2, entries.length))) {
    concerns.push('Source-domain diversity is limited for this run.');
  }
  if (primaryLikeSources === 0) {
    concerns.push('No primary-like/official source types were identified in validated sources.');
  }
  if (topicRequiresPrimaryLike && primaryLikeEvidenceShare < 0.25) {
    concerns.push(
      `Topic appears guidance/reference-oriented but primary-like evidence share is low (${primaryLikeEvidenceShare.toFixed(2)}).`
    );
  }

  const lowRiskSingleSourceFallbackEnabled = !isHighRiskTopic(researchPack.topic) && entries.length === 1;
  const minUniqueDomains = lowRiskSingleSourceFallbackEnabled ? 1 : entries.length >= 4 ? 3 : 2;
  const minStrongOrModerateSources = lowRiskSingleSourceFallbackEnabled ? 1 : entries.length >= 4 ? 3 : 2;
  const allowedWeakEvidenceShare = 0.55;
  const minPrimaryLikeEvidenceShare = topicRequiresPrimaryLike ? 0.25 : 0;
  const failureReasons: string[] = [];

  if (entries.length < (lowRiskSingleSourceFallbackEnabled ? 1 : 2)) {
    failureReasons.push(
      lowRiskSingleSourceFallbackEnabled
        ? 'No validated sources remain after filtering.'
        : 'Fewer than 2 validated sources remain after filtering.'
    );
  }
  if (uniqueDomains.size < minUniqueDomains) {
    failureReasons.push(
      `Insufficient source-domain diversity (${uniqueDomains.size} < ${minUniqueDomains}).`
    );
  }
  if (strongSources + moderateSources < minStrongOrModerateSources) {
    failureReasons.push(
      `Too few strong/moderate sources (${strongSources + moderateSources} < ${minStrongOrModerateSources}).`
    );
  }
  if (strongSources === 0 && weakSources > 0 && weakSources >= moderateSources) {
    failureReasons.push('Weak source classes dominate without any strong source anchor.');
  }
  if (weakEvidenceShare > allowedWeakEvidenceShare) {
    failureReasons.push(
      `Weak-source evidence share exceeds threshold (${weakEvidenceShare.toFixed(2)} > ${allowedWeakEvidenceShare}).`
    );
  }
  if (topicRequiresPrimaryLike && primaryLikeSources === 0) {
    failureReasons.push('Guidance/reference topic is missing primary-like source anchors.');
  }
  if (minPrimaryLikeEvidenceShare > 0 && primaryLikeEvidenceShare < minPrimaryLikeEvidenceShare) {
    failureReasons.push(
      `Primary-like evidence share below minimum (${primaryLikeEvidenceShare.toFixed(2)} < ${minPrimaryLikeEvidenceShare}).`
    );
  }

  return {
    review: {
      stage: 'source_quality_review',
      entries,
      summary: {
        total_sources: entries.length,
        strong_sources: strongSources,
        moderate_sources: moderateSources,
        weak_sources: weakSources,
        unique_domains: uniqueDomains.size,
        source_type_mix: sourceTypeMix,
        weak_evidence_share: Number(weakEvidenceShare.toFixed(3)),
        strong_evidence_share: Number(strongEvidenceShare.toFixed(3)),
        primary_like_evidence_share: Number(primaryLikeEvidenceShare.toFixed(3)),
        primary_like_sources: primaryLikeSources,
      },
      concerns,
    },
    gate: {
      gate: 'source_quality_required',
      valid: failureReasons.length === 0,
      total_sources: entries.length,
      strong_sources: strongSources,
      moderate_sources: moderateSources,
      weak_sources: weakSources,
      unique_domains: uniqueDomains.size,
      weak_evidence_share: Number(weakEvidenceShare.toFixed(3)),
      strong_evidence_share: Number(strongEvidenceShare.toFixed(3)),
      primary_like_evidence_share: Number(primaryLikeEvidenceShare.toFixed(3)),
      allowed_weak_evidence_share: allowedWeakEvidenceShare,
      minimum_primary_like_evidence_share: minPrimaryLikeEvidenceShare,
      minimum_unique_domains: minUniqueDomains,
      minimum_strong_or_moderate_sources: minStrongOrModerateSources,
      failure_reasons: failureReasons,
    },
  };
}

function classifySourceQualityTier(sourceType: string, credibility: number, domain: string): SourceQualityTier {
  const normalized = sourceType.toLowerCase();
  if (isOfficialReferenceDomain(domain) && credibility >= 3) {
    return 'strong';
  }
  if (isCommunityOrSecondaryDomain(domain)) {
    return 'weak';
  }
  if (credibility >= 4 && /^(primary|government|academic|data)$/.test(normalized)) {
    return 'strong';
  }
  if (credibility >= 4 && /^(industry|news)$/.test(normalized)) {
    return 'moderate';
  }
  if (credibility === 3 && /^(primary|government|academic|data|industry|news)$/.test(normalized)) {
    return 'moderate';
  }
  return 'weak';
}

function buildSourceTierRationale(sourceType: string, credibility: number, tier: SourceQualityTier, domain: string): string[] {
  const notes = [`Type=${sourceType}`, `Credibility=${credibility}/5`];
  if (isOfficialReferenceDomain(domain)) {
    notes.push('Official/reference domain detected.');
  }
  if (isCommunityOrSecondaryDomain(domain)) {
    notes.push('Community/secondary domain detected; treated cautiously.');
  }
  if (tier === 'strong') {
    notes.push('Classed as strong due to authoritative type + high credibility.');
  } else if (tier === 'moderate') {
    notes.push('Classed as moderate due to acceptable credibility and source class.');
  } else {
    notes.push('Classed as weak due to low credibility and/or weaker source class for core grounding.');
  }
  return notes;
}

function isPrimaryLikeSource(sourceType: string, domain: string): boolean {
  return /^(primary|government|academic|data)$/i.test(sourceType) || isOfficialReferenceDomain(domain);
}

function topicNeedsPrimaryLikeAnchors(topic: string): boolean {
  return /\b(best practices|guide|reference|options|how to|patterns|overview|playbook)\b/i.test(topic);
}

function isOfficialReferenceDomain(domain: string): boolean {
  return /(?:typescriptlang\.org|developer\.mozilla\.org|web\.dev|nodejs\.org|react\.dev|docs\.microsoft\.com|learn\.microsoft\.com|w3\.org|python\.org|go\.dev|rust-lang\.org|kubernetes\.io|postgresql\.org)$/i.test(domain)
    || /\.(gov|edu)$/i.test(domain);
}

function isCommunityOrSecondaryDomain(domain: string): boolean {
  return /(?:medium\.com|dev\.to|stackoverflow\.com|quora\.com|reddit\.com|substack\.com|hashnode\.com|blogspot\.com|wordpress\.com)$/i.test(domain);
}

function runChiefEditorPass(
  draft: ArticleDraft,
  researchPack: ResearchPack,
  trustPolicyReview: TrustPolicyReviewArtifact,
  claimMapGate: ClaimMapGateResult,
  sourceQualityGate: SourceQualityGateResult,
  minimumSourceCitations: number
): { artifact: ChiefEditorArtifact; pass: EditorPass } {
  const rationale: string[] = [];
  const informationalNotes: string[] = [];

  if (trustPolicyReview.risky_phrases_softened.length > 0) {
    rationale.push(
      `Trust/policy editor softened ${trustPolicyReview.risky_phrases_softened.length} phrase(s) before final publish checks.`
    );
  }
  if (!claimMapGate.valid) {
    informationalNotes.push('Claim-map repair is still required before publish.');
  }
  if (!sourceQualityGate.valid) {
    informationalNotes.push('Source-quality gate previously flagged issues earlier in the pipeline.');
  }
  if (draft.sources_cited.length < minimumSourceCitations) {
    informationalNotes.push(`Draft currently cites ${draft.sources_cited.length} source URL(s); publish gate will enforce the required minimum.`);
  }
  rationale.push(
    `Final editorial summary only: ${researchPack.evidence_items.length} evidence item(s), ${draft.word_count} words, ${draft.sources_cited.length} cited source URL(s).`
  );

  return {
    artifact: {
      stage: 'chief_editor',
      decision: 'publish',
      rationale,
      blocking_issues: [],
      reviewed_stages: ['author', 'structural_editor', 'fact_source_checker', 'trust_policy_editor', 'reader_editor'],
    },
    pass: {
      pass_number: 4,
      stage: 'chief_editor',
      changes_made: informationalNotes.length > 0 ? informationalNotes : ['Recorded final editorial summary without adding another blocking LLM-style gate.'],
      quality_score: 9,
      approved: true,
      notes: 'Chief editor stage reduced to a non-blocking editorial summary.',
    },
  };
}

function buildClaimMapFromStabilizedDraft(content: string, researchPack: ResearchPack): ClaimMapArtifact {
  const knownUrls = new Set(researchPack.sources.map((source) => source.url));
  const evidenceById = new Map(researchPack.evidence_items.map((item) => [item.id, item]));
  const candidates = extractClaimCandidateSentences(content);
  const entries: ClaimMapEntry[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const claimText = candidates[i];
    const claimTokens = tokenizeForOverlap(claimText);
    const specificity = assessClaimSpecificity(claimText, claimTokens.size);
    const urlMatches = extractUrlsFromText(claimText).filter((url) => knownUrls.has(url));
    const match = findBestSupportingEvidence(claimText, researchPack);
    const likelyOpinion = isLikelyOpinionOrAnalysis(claimText);

    let supportStatus: ClaimSupportStatus;
    let groundingSignal: ClaimMapEntry['grounding_signal'] = 'none';
    let weaknessOrUncertaintyNote: string | undefined;
    const supportingEvidenceIds: string[] = [];
    const supportingSourceUrls: string[] = [...urlMatches];
    const score = match?.score ?? 0;
    const hasEvidenceUrlMatch = Boolean(match && knownUrls.has(match.evidence.source_url));

    if (match && score >= 0.42 && specificity !== 'low' && (urlMatches.length > 0 || hasEvidenceUrlMatch)) {
      supportStatus = 'supported';
      groundingSignal = 'evidence_match';
      supportingEvidenceIds.push(match.evidence.id);
      if (!supportingSourceUrls.includes(match.evidence.source_url)) {
        supportingSourceUrls.push(match.evidence.source_url);
      }
    } else if (match && score >= 0.28) {
      supportStatus = 'partially_supported';
      groundingSignal = 'evidence_match';
      supportingEvidenceIds.push(match.evidence.id);
      if (!supportingSourceUrls.includes(match.evidence.source_url)) {
        supportingSourceUrls.push(match.evidence.source_url);
      }
      weaknessOrUncertaintyNote = 'Claim only partially overlaps available evidence; wording may still be broader than source support.';
    } else if (urlMatches.length > 0 && (match?.score ?? 0) >= 0.2) {
      supportStatus = 'partially_supported';
      groundingSignal = 'source_url_only';
      weaknessOrUncertaintyNote = 'Claim includes a known source URL, but claim-level evidence overlap is weak.';
    } else if (likelyOpinion) {
      supportStatus = 'opinion_or_analysis';
      groundingSignal = 'opinion_pattern';
      weaknessOrUncertaintyNote = 'This is treated as opinion/analysis language rather than a fully verifiable factual claim.';
    } else {
      supportStatus = 'unsupported';
      weaknessOrUncertaintyNote = 'No sufficient evidence overlap or source link was found for this claim in the current research pack.';
    }

    // If URL is present and known but no evidence-id match, map evidence IDs by URL.
    if (supportingEvidenceIds.length === 0 && supportingSourceUrls.length > 0) {
      for (const evidenceItem of researchPack.evidence_items) {
        if (supportingSourceUrls.includes(evidenceItem.source_url) && !supportingEvidenceIds.includes(evidenceItem.id)) {
          supportingEvidenceIds.push(evidenceItem.id);
        }
      }
      if (supportStatus === 'unsupported' && supportingEvidenceIds.length > 0 && (match?.score ?? 0) >= 0.2) {
        supportStatus = 'partially_supported';
        groundingSignal = 'source_url_only';
        weaknessOrUncertaintyNote = 'Mapped by source URL but claim-level support remains incomplete.';
      }
    }

    // Keep only evidence ids that still exist in pack.
    const filteredEvidenceIds = supportingEvidenceIds.filter((id) => evidenceById.has(id));

    entries.push({
      id: `CM${String(i + 1).padStart(3, '0')}`,
      claim_text: claimText,
      support_status: supportStatus,
      matching_score: Number(score.toFixed(3)),
      claim_specificity: specificity,
      grounding_signal: groundingSignal,
      supporting_evidence_ids: filteredEvidenceIds,
      supporting_source_urls: supportingSourceUrls,
      weakness_or_uncertainty_note: weaknessOrUncertaintyNote,
    });
  }

  const summary = {
    total_claims: entries.length,
    supported: entries.filter((entry) => entry.support_status === 'supported').length,
    partially_supported: entries.filter((entry) => entry.support_status === 'partially_supported').length,
    unsupported: entries.filter((entry) => entry.support_status === 'unsupported').length,
    opinion_or_analysis: entries.filter((entry) => entry.support_status === 'opinion_or_analysis').length,
  };

  return {
    stage: 'claim_map',
    entries,
    summary,
    derived_from: 'final_stabilized_draft',
  };
}

function evaluateClaimMapGate(claimMap: ClaimMapArtifact): ClaimMapGateResult {
  const failureReasons: string[] = [];
  const totalClaims = claimMap.summary.total_claims;
  const factualClaims = claimMap.summary.supported + claimMap.summary.partially_supported + claimMap.summary.unsupported;
  const weakClaims = claimMap.summary.partially_supported + claimMap.summary.unsupported;
  const allowedWeakClaims = Math.max(2, Math.ceil(totalClaims * 0.5));
  const unsupportedClaims = claimMap.summary.unsupported;
  const allowedUnsupportedClaims = Math.max(1, Math.floor(totalClaims * 0.15));
  const supportedFactualRatio = factualClaims > 0 ? claimMap.summary.supported / factualClaims : 0;
  const minimumSupportedFactualRatio = 0.25;

  if (!claimMap || claimMap.stage !== 'claim_map') {
    failureReasons.push('Claim map artifact missing or invalid.');
  }
  if (totalClaims === 0) {
    failureReasons.push('Claim map is empty; no concrete claims were mapped from final article content.');
  }
  if (totalClaims > 0 && unsupportedClaims > allowedUnsupportedClaims) {
    failureReasons.push(
      `Unsupported claims exceed threshold (${unsupportedClaims} > ${allowedUnsupportedClaims}).`
    );
  }
  if (totalClaims > 0 && weakClaims > allowedWeakClaims) {
    failureReasons.push(`Weakly grounded claims exceed threshold (${weakClaims} > ${allowedWeakClaims}).`);
  }
  if (factualClaims >= 4 && claimMap.summary.supported === 0) {
    failureReasons.push('No factual claims reached fully supported status.');
  }
  if (factualClaims >= 6 && claimMap.summary.supported < 2) {
    failureReasons.push('Too few fully supported factual claims survived for reliable publish-grade output.');
  }
  if (factualClaims > 0 && supportedFactualRatio < minimumSupportedFactualRatio) {
    failureReasons.push(
      `Supported factual-claim ratio below minimum (${supportedFactualRatio.toFixed(2)} < ${minimumSupportedFactualRatio}).`
    );
  }

  return {
    gate: 'claim_map_required',
    valid: failureReasons.length === 0,
    total_claims: totalClaims,
    factual_claims: factualClaims,
    weak_claims: weakClaims,
    allowed_weak_claims: allowedWeakClaims,
    supported_factual_ratio: Number(supportedFactualRatio.toFixed(3)),
    minimum_supported_factual_ratio: minimumSupportedFactualRatio,
    unsupported_claims: unsupportedClaims,
    allowed_unsupported_claims: allowedUnsupportedClaims,
    failure_reasons: failureReasons,
  };
}

function extractClaimCandidateSentences(content: string): string[] {
  const withoutCode = content.replace(/```[\s\S]*?```/g, ' ');
  const withoutHeadings = withoutCode
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const rawSentences = withoutHeadings
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$1 ($2)')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 45 && sentence.length <= 280);

  const blacklist = /(generated|foseer article intelligence pipeline|word count|sources:|evidence items:|^\s*[-*]\s*\*\*)/i;
  const candidates: Array<{ text: string; score: number }> = [];
  const seen = new Set<string>();

  for (const sentence of rawSentences) {
    if (blacklist.test(sentence)) continue;
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const tokenCount = tokenizeForOverlap(sentence).size;
    const specificity = assessClaimSpecificity(sentence, tokenCount);
    const hasUrl = /https?:\/\//i.test(sentence);
    const isLikelyChecklist = /\b(best practices?|key best practices?|to ensure|consider these)\b/i.test(sentence);
    const score =
      (specificity === 'high' ? 3 : specificity === 'medium' ? 2 : 1) +
      (hasUrl ? 2 : 0) +
      (isLikelyChecklist ? -1 : 0);

    candidates.push({ text: sentence, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((item) => item.text);
}

function findBestSupportingEvidence(
  claimText: string,
  researchPack: ResearchPack
): { evidence: ResearchPack['evidence_items'][number]; score: number } | null {
  const claimTokens = tokenizeForOverlap(claimText);
  if (claimTokens.size === 0) {
    return null;
  }

  let best: { evidence: ResearchPack['evidence_items'][number]; score: number } | null = null;
  for (const evidence of researchPack.evidence_items) {
    const evidenceTokens = tokenizeForOverlap(`${evidence.claim} ${evidence.excerpt}`);
    if (evidenceTokens.size === 0) continue;
    const overlapCount = intersectCount(claimTokens, evidenceTokens);
    if (overlapCount === 0) continue;
    const score = overlapCount / Math.min(claimTokens.size, evidenceTokens.size);
    if (!best || score > best.score) {
      best = { evidence, score };
    }
  }
  return best;
}

function tokenizeForOverlap(text: string): Set<string> {
  const stopwords = new Set([
    'the', 'and', 'that', 'this', 'with', 'from', 'have', 'will', 'into', 'your', 'about',
    'they', 'their', 'there', 'were', 'been', 'also', 'than', 'then', 'when', 'what', 'where',
    'which', 'while', 'using', 'used', 'should', 'could', 'would', 'many', 'more', 'most',
    'some', 'such', 'over', 'under', 'into', 'onto', 'within', 'without', 'across', 'after',
    'before', 'during', 'because', 'through', 'often', 'likely', 'may', 'might'
  ]);

  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/[^\s\)]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stopwords.has(token));

  return new Set(tokens);
}

function assessClaimSpecificity(text: string, tokenCount: number): 'high' | 'medium' | 'low' {
  const hasNumberOrPercent = /\b\d+(\.\d+)?(%|x|ms|s|m|h)?\b/.test(text);
  const hasNamedEntityCue = /\b(TypeScript|JavaScript|Node\.js|React|CSS|API|HTTP|V8|ECMAScript)\b/i.test(text);
  const hasTimeCue = /\b(202\d|today|recent|latest|version|release)\b/i.test(text);

  let score = 0;
  if (tokenCount >= 12) score += 2;
  else if (tokenCount >= 8) score += 1;
  if (hasNumberOrPercent) score += 1;
  if (hasNamedEntityCue) score += 1;
  if (hasTimeCue) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function intersectCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s\)]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function isLikelyOpinionOrAnalysis(text: string): boolean {
  return /\b(should|could|may|might|recommend|consider|best practice|best practices|in many cases|for teams|it can help|often|typically|depending on|you can|use |implement |avoid )\b/i.test(text);
}

function softenToken(token: string): string {
  const map: Record<string, string> = {
    always: 'often',
    never: 'rarely',
    guarantees: 'can improve',
    prove: 'suggest',
    proves: 'suggests',
    definitely: 'likely',
    undeniably: 'strongly',
  };
  const lower = token.toLowerCase();
  const replacement = map[lower] || token;
  return token[0] === token[0].toUpperCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

function findUnsupportedUrls(content: string, researchPack: ResearchPack): string[] {
  const known = new Set(researchPack.sources.map((source) => source.url));
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s\)]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(content)) !== null) {
    const url = match[0];
    if (!known.has(url) && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function buildSyntheticValidatedSources(urls: string[]): ValidatedSource[] {
  const uniqueUrls = Array.from(new Set(urls.filter((url) => /^https?:\/\//i.test(url)))).slice(0, 10);
  return uniqueUrls.map((url, index) => {
    const domain = safeDomain(url);
    const sourceType = classifySyntheticSourceType(domain);
    const credibility = sourceType === 'primary' ? 5 : sourceType === 'government' ? 5 : sourceType === 'academic' ? 5 : 4;
    return {
      title: domain || `Source ${index + 1}`,
      url,
      source_type: sourceType,
      credibility_score: credibility,
      relevance_score: 8,
      validation_notes: ['Synthetic offline validation source generated from replay artifact URL list.'],
    } as unknown as ValidatedSource;
  });
}

function buildSyntheticResearchPackFromDraft(
  topic: string,
  topicId: string,
  keyQuestions: string[],
  draftContent: string,
  validatedSources: ValidatedSource[]
): ResearchPack {
  const evidenceItems = buildSyntheticEvidenceItemsFromDraft(draftContent, validatedSources);
  const groupedFindings = keyQuestions.map((question, index) => {
    const findings = evidenceItems
      .filter((_, evidenceIndex) => evidenceIndex % keyQuestions.length === index)
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        claim: item.claim,
        source_title: item.source,
        source_url: item.source_url,
        confidence: item.confidence,
      }));
    return {
      question,
      confidence_level: findings.length >= 2 ? 'high' : findings.length === 1 ? 'medium' : 'low',
      findings,
    };
  });

  const sources = validatedSources.map((source) => {
    const evidenceCount = evidenceItems.filter((item) => item.source_url === source.url).length;
    return {
      title: source.title || safeDomain(source.url) || 'Source',
      url: source.url,
      type: (source.source_type || 'news').toLowerCase(),
      credibility: Math.max(1, Math.min(5, Number(source.credibility_score || 3))),
      evidence_count: evidenceCount,
    };
  });

  const draftAngles = groupedFindings
    .filter((group) => group.findings.length > 0)
    .slice(0, 6)
    .map((group) => ({
      angle: compactPromptText(group.question, 120),
      rationale: compactPromptText(group.findings[0]?.claim || `Evidence linked to ${group.question}`, 180),
    }));

  return {
    topic,
    topic_id: topicId,
    key_questions: keyQuestions,
    evidence_items: evidenceItems,
    sources,
    grouped_findings_by_question: groupedFindings,
    draft_angles: draftAngles,
    source_coverage_summary: {
      total_sources: sources.length,
      total_evidence_items: evidenceItems.length,
      covered_questions: groupedFindings.filter((group) => group.findings.length > 0).length,
    },
  } as unknown as ResearchPack;
}

function buildSyntheticEvidenceItemsFromDraft(
  draftContent: string,
  validatedSources: ValidatedSource[]
): ResearchPack['evidence_items'] {
  const urls = validatedSources.map((source) => source.url);
  const sentences = splitIntoClaimLikeSentences(draftContent).slice(0, 16);
  const fallbackSentence = 'Available source material indicates ongoing developments relevant to the topic.';
  const basis = sentences.length > 0 ? sentences : [fallbackSentence, fallbackSentence, fallbackSentence, fallbackSentence];

  return basis.map((sentence, index) => {
    const sourceUrl = urls[index % Math.max(1, urls.length)] || 'https://example.com/source';
    const sourceTitle = validatedSources[index % Math.max(1, validatedSources.length)]?.title || safeDomain(sourceUrl) || 'Source';
    return {
      id: `E${String(index + 1).padStart(3, '0')}`,
      claim: compactPromptText(sentence, 220),
      excerpt: compactPromptText(sentence, 280),
      source_url: sourceUrl,
      source: sourceTitle,
      confidence: index < 6 ? 'high' : index < 10 ? 'medium' : 'low',
    };
  }) as unknown as ResearchPack['evidence_items'];
}

function evidenceConfidenceScore(value: string | undefined): number {
  const normalized = (value || '').toLowerCase().trim();
  if (normalized === 'high') return 9;
  if (normalized === 'medium') return 6.5;
  if (normalized === 'low') return 4;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.min(10, numeric));
  }
  return 5;
}

function splitIntoClaimLikeSentences(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40)
    .filter((sentence) => !/^#{1,6}\s+/.test(sentence))
    .filter((sentence) => !/^[-*]\s+/.test(sentence));
}

function classifySyntheticSourceType(domain: string): string {
  if (/\.(gov|mil)$/i.test(domain)) return 'government';
  if (/\.(edu)$/i.test(domain)) return 'academic';
  if (/docs\.|developer\.|official|support\./i.test(domain)) return 'primary';
  return 'news';
}

/**
 * Format sources list for final article.
 */
function formatSourcesList(sources: string[]): string {
  if (sources.length === 0) {
    return '*No specific URLs cited in article.*';
  }

  return sources.map((url, i) => `${i + 1}. ${url}`).join('\n');
}

function polishGeneratedDraft(
  content: string,
  title: string,
  researchPack: ResearchPack,
  articleType: CanonicalArticleType
): string {
  let text = content.replace(/\r\n/g, '\n').trim();
  text = text.replace(/^---\n[\s\S]*?\n---\n*/m, '').trim();
  text = normalizeDraftBody(text, title);
  text = text.replace(/This article explores[^.]*\.\s*/gi, '');
  text = shapeDraftBeforeEditorialStages(text, researchPack, articleType);
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function normalizeDraftBody(content: string, title: string): string {
  let text = content.trim();
  const escapedTitle = escapeRegex(title.trim());
  const headingRegex = new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, 'i');
  text = text.replace(headingRegex, '');
  text = text.replace(/^\*Generated:[^\n]*\n?/i, '');
  text = text.replace(/^\*Word count:[^\n]*\n?/i, '');
  text = text.replace(/^\*Evidence items:[^\n]*\n?/i, '');
  text = text.replace(/^---\n+/, '');
  text = removeResidualDraftArtifacts(text);
  return text.trim();
}

function removeResidualDraftArtifacts(content: string): string {
  let text = content;
  text = text.replace(/\bIn analysis terms,\s*/gi, '');
  text = text.replace(/^\s*Source\s*\((https?:\/\/[^\s)]+)\)\s*$/gim, '');
  text = text.replace(/\bSource\s*\((https?:\/\/[^\s)]+)\)/gi, '');
  text = text.replace(/\[Source\]\((https?:\/\/[^\s)]+)\)/gi, '');
  text = text.replace(/\bAccording to available reporting,\s*/gi, '');
  text = text.replace(/\bsrc=\S+/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function shapeDraftBeforeEditorialStages(
  content: string,
  researchPack: ResearchPack,
  articleType: CanonicalArticleType
): string {
  const genericPatterns = [
    /\b(it is important to note that|in today's world|it goes without saying)\b/i,
    /\b(best practices include)\b/i,
    /\b(ensure (that )?you|you should always|always make sure)\b/i,
    /\b(in conclusion,?)\b/i,
  ];
  const knownUrls = new Set(researchPack.sources.map((source) => source.url));
  const anchorTokens = new Set(
    getPriorityEvidenceForDraft(researchPack, 16).flatMap((item) =>
      Array.from(tokenizeForOverlap(`${item.claim} ${item.excerpt}`))
    )
  );

  const cleanedParagraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .filter((paragraph) => {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      if (normalized.length < 40) return false;
      const hasGenericPhrase = genericPatterns.some((pattern) => pattern.test(normalized));
      const hasEvidenceId = /\bE\d{3}\b/.test(normalized);
      const urls = extractUrlsFromText(normalized);
      const hasKnownUrl = urls.some((url) => knownUrls.has(url));
      const hasAnchorOverlap = hasEvidenceAnchorOverlap(normalized, anchorTokens);
      const isChecklistHeading = /^[-*]\s*\*\*[^*]+\*\*:/i.test(normalized);
      const claimLike = isClaimLikeParagraph(normalized);

      if (isChecklistHeading && !hasKnownUrl && !hasEvidenceId) return false;
      if (hasGenericPhrase && !hasKnownUrl && !hasEvidenceId) return false;
      if (claimLike && !hasKnownUrl && !hasEvidenceId && !hasAnchorOverlap && /best practices|should|must|always|never|all teams|every team/i.test(normalized)) {
        return false;
      }
      return true;
    });

  let shaped = cleanedParagraphs.join('\n\n');
  shaped = applyEvidenceBoundParagraphShaping(shaped, knownUrls, anchorTokens, researchPack);

  if (articleType === 'analysis') {
    shaped = shaped.replace(/\bclearly\b/gi, 'on balance');
    shaped = shaped.replace(/\bproves\b/gi, 'suggests');
  }
  if (articleType === 'report') {
    shaped = shaped.replace(/\bshould\b/gi, 'can');
  }

  return shaped.trim();
}

function applyEvidenceBoundParagraphShaping(
  content: string,
  knownUrls: Set<string>,
  anchorTokens: Set<string>,
  researchPack: ResearchPack
): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const revised: string[] = [];
  for (const paragraph of paragraphs) {
    if (/^#{1,6}\s+/.test(paragraph)) {
      revised.push(paragraph);
      continue;
    }

    const tightened = tightenParagraphToEvidenceUnits(paragraph, knownUrls, anchorTokens, researchPack);
    revised.push(...tightened);
  }

  return dedupeParagraphs(revised.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
}

function applyPreClaimMapSourceUrlOnlyHardening(content: string, researchPack: ResearchPack): string {
  const knownUrls = new Set(researchPack.sources.map((source) => source.url));
  const anchorTokens = new Set(
    getPriorityEvidenceForDraft(researchPack, 16).flatMap((item) =>
      Array.from(tokenizeForOverlap(`${item.claim} ${item.excerpt}`))
    )
  );

  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const hardened: string[] = [];

  for (const paragraph of paragraphs) {
    if (/^#{1,6}\s+/.test(paragraph)) {
      hardened.push(paragraph);
      continue;
    }
    const revised = hardenParagraphForPreClaimMap(paragraph, knownUrls, anchorTokens, researchPack);
    hardened.push(...revised);
  }

  return dedupeParagraphs(hardened.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
}

function hardenParagraphForPreClaimMap(
  paragraph: string,
  knownUrls: Set<string>,
  anchorTokens: Set<string>,
  researchPack: ResearchPack
): string[] {
  const sentences = splitIntoSentences(paragraph);
  if (sentences.length === 0) {
    return [];
  }

  const kept: Array<{ text: string; claim_like: boolean }> = [];
  for (const sentence of sentences) {
    const signals = getSentenceGroundingSignals(sentence, knownUrls, anchorTokens);
    const assessment = assessSentenceAgainstResearchPack(sentence, signals, researchPack);
    const synthesisCandidate =
      isClaimMapCandidateLikeSentence(sentence) &&
      (isLikelyUnsupportedSynthesisResidue(sentence) || isBroadSynthesisStyleSentence(sentence)) &&
      signals.claim_like;
    const synthesisNeedsStrictHandling =
      synthesisCandidate &&
      !isSynthesisCandidateFactualSafe(sentence, signals, assessment);
    const retainAsFactual =
      assessment.strong_support &&
      (signals.has_evidence_id || assessment.best_score >= PRECLAIM_FACTUAL_MIN_MATCH_SCORE) &&
      !synthesisNeedsStrictHandling;

    if (!signals.claim_like) {
      if (synthesisCandidate) {
        if (assessment.salvageable_by_rewrite && assessment.best_claim) {
          const rewritten = buildNarrowEvidenceSentence(
            assessment.best_claim,
            assessment.best_source_title,
            assessment.best_source_url
          );
          const rewrittenNormalized = rewritten.replace(/\s+/g, ' ').trim();
          if (rewrittenNormalized.length > 0) {
            kept.push({ text: rewrittenNormalized, claim_like: true });
            continue;
          }
        }
        if (assessment.best_claim || assessment.best_source_title || assessment.best_score >= 0.2) {
          const analysisSentence = buildOpinionFramedAnalysisSentence(
            sentence,
            assessment.best_claim,
            assessment.best_source_title
          );
          const analysisNormalized = analysisSentence.replace(/\s+/g, ' ').trim();
          if (analysisNormalized.length > 0) {
            kept.push({ text: analysisNormalized, claim_like: false });
          }
        }
        continue;
      }

      let next = sentence;
      if (!signals.has_known_url && /\b(always|never|guarantees|proves|definitely|undeniably)\b/i.test(next)) {
        next = softenAbsoluteLanguage(next);
      }
      const normalized = next.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        kept.push({ text: normalized, claim_like: false });
      }
      continue;
    }

    if (synthesisNeedsStrictHandling) {
      if (assessment.best_claim) {
        const rewritten = buildNarrowEvidenceSentence(
          assessment.best_claim,
          assessment.best_source_title,
          assessment.best_source_url
        );
        const normalized = rewritten.replace(/\s+/g, ' ').trim();
        if (normalized.length > 0) {
          kept.push({ text: normalized, claim_like: true });
          continue;
        }
      }

      const analysisSentence = buildOpinionFramedAnalysisSentence(
        sentence,
        assessment.best_claim,
        assessment.best_source_title
      );
      const analysisNormalized = analysisSentence.replace(/\s+/g, ' ').trim();
      if (analysisNormalized.length > 0) {
        kept.push({ text: analysisNormalized, claim_like: false });
      }
      continue;
    }

    if (retainAsFactual) {
      let next = softenAbsoluteLanguage(sentence);
      if (!signals.has_known_url && assessment.best_source_url && knownUrls.has(assessment.best_source_url)) {
        next = appendInlineSourceCitation(next, assessment.best_source_url);
      }
      const normalized = next.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        kept.push({ text: normalized, claim_like: true });
      }
      continue;
    }

    if (assessment.salvageable_by_rewrite && assessment.best_claim) {
      const rewritten = buildNarrowEvidenceSentence(
        assessment.best_claim,
        assessment.best_source_title,
        assessment.best_source_url
      );
      const normalized = rewritten.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        kept.push({ text: normalized, claim_like: true });
      }
      continue;
    }

    const weakUrlOnly = assessment.weak_url_only || (signals.has_known_url && !retainAsFactual);
    const preserveAsAnalysis = weakUrlOnly || (isLikelyOpinionOrAnalysis(sentence) && Boolean(assessment.best_source_url));
    if (preserveAsAnalysis) {
      const analysisSentence = buildOpinionFramedAnalysisSentence(
        sentence,
        assessment.best_claim,
        assessment.best_source_title
      );
      const normalized = analysisSentence.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) {
        kept.push({ text: normalized, claim_like: false });
      }
    }
  }

  if (kept.length === 0) {
    return [];
  }

  const grouped: string[] = [];
  let current: string[] = [];
  let currentHasClaim = false;
  const flushCurrent = () => {
    if (current.length > 0) {
      grouped.push(current.join(' ').trim());
      current = [];
      currentHasClaim = false;
    }
  };

  for (const item of kept) {
    if (item.claim_like) {
      if (currentHasClaim) {
        flushCurrent();
      }
      current.push(item.text);
      currentHasClaim = true;
      continue;
    }

    if (!currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    if (currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    current.push(item.text);
  }
  flushCurrent();

  return grouped.filter((item) => item.length >= 35);
}

function isSynthesisCandidateFactualSafe(
  sentence: string,
  signals: SentenceGroundingSignals,
  assessment: SentenceEvidenceAssessment
): boolean {
  if (!signals.claim_like) {
    return false;
  }
  if (!assessment.best_claim || assessment.best_claim.length < 40) {
    return false;
  }
  if (assessment.best_score < 0.34) {
    return false;
  }
  if (!hasConcreteSpecificityCue(sentence)) {
    return false;
  }
  return signals.has_evidence_id || signals.has_known_url || signals.has_attribution;
}

function buildOpinionFramedAnalysisSentence(
  sentence: string,
  bestClaim: string | undefined,
  sourceTitle: string | undefined
): string {
  // Keep analysis fallback evidence-bound: if we do not have a strong matched claim,
  // drop the sentence instead of preserving speculative residue.
  if (!bestClaim || bestClaim.length < 40) {
    return '';
  }

  const base = bestClaim
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$1')
    .replace(/\(https?:\/\/[^\s\)]+\)/g, '')
    .replace(/https?:\/\/[^\s\)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) {
    return '';
  }

  let core = softenAbsoluteLanguage(base)
    .replace(/^((according to|reported by|data from|analysis from|figures from|statement from|filing from)\s+[^,]+,\s*)/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  core = compactPromptText(core, 160).replace(/[.!?]+$/g, '').trim();
  if (!core) {
    return '';
  }

  const sourceLabel = sourceTitle ? sourceTitle.replace(/\s+/g, ' ').trim() : 'available reporting';
  const framed = `According to ${sourceLabel}, ${lowercaseFirst(core)}.`;
  return compactPromptText(framed, 220);
}

interface SentenceGroundingSignals {
  claim_like: boolean;
  has_known_url: boolean;
  has_evidence_id: boolean;
  has_anchor_overlap: boolean;
  has_attribution: boolean;
}

interface SentenceEvidenceAssessment {
  strong_support: boolean;
  weak_url_only: boolean;
  salvageable_url_only: boolean;
  salvageable_by_rewrite: boolean;
  best_score: number;
  best_claim?: string;
  best_source_url?: string;
  best_source_title?: string;
}

const STRONG_SENTENCE_EVIDENCE_SCORE = 0.26;
const SALVAGE_SENTENCE_EVIDENCE_SCORE = 0.2;
const PRECLAIM_FACTUAL_MIN_MATCH_SCORE = 0.28;

function assessSentenceAgainstResearchPack(
  sentence: string,
  signals: SentenceGroundingSignals,
  researchPack: ResearchPack
): SentenceEvidenceAssessment {
  const best = findBestSupportingEvidence(sentence, researchPack);
  const bestScore = best?.score ?? 0;
  const strongSupport =
    signals.has_evidence_id ||
    bestScore >= STRONG_SENTENCE_EVIDENCE_SCORE ||
    (signals.has_anchor_overlap && bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE);
  const weakUrlOnly = signals.claim_like && signals.has_known_url && !signals.has_evidence_id && !strongSupport;
  const salvageableByRewrite =
    signals.claim_like &&
    !strongSupport &&
    bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE &&
    hasConcreteSpecificityCue(sentence) &&
    Boolean(best?.evidence?.source_url) &&
    Boolean(best?.evidence?.claim);
  const salvageableUrlOnly =
    weakUrlOnly &&
    bestScore >= SALVAGE_SENTENCE_EVIDENCE_SCORE &&
    hasConcreteSpecificityCue(sentence) &&
    Boolean(best?.evidence?.source_url);

  return {
    strong_support: strongSupport,
    weak_url_only: weakUrlOnly,
    salvageable_url_only: salvageableUrlOnly,
    salvageable_by_rewrite: salvageableByRewrite,
    best_score: Number(bestScore.toFixed(3)),
    best_claim: best?.evidence?.claim,
    best_source_url: best?.evidence?.source_url,
    best_source_title: best?.evidence?.source,
  };
}

function buildNarrowEvidenceSentence(
  claim: string,
  sourceTitle: string | undefined,
  sourceUrl: string | undefined
): string {
  if (!claim) return '';
  const narrowed = compactPromptText(claim.replace(/\s+/g, ' ').trim(), 220);
  const sourceLabel = sourceTitle ? sourceTitle.replace(/\s+/g, ' ').trim() : 'the cited source';
  if (sourceUrl) {
    return `According to ${sourceLabel}, ${lowercaseFirst(narrowed)}.`;
  }
  return `According to ${sourceLabel}, ${lowercaseFirst(narrowed)}.`;
}

function tightenParagraphToEvidenceUnits(
  paragraph: string,
  knownUrls: Set<string>,
  anchorTokens: Set<string>,
  researchPack: ResearchPack
): string[] {
  const sentences = splitIntoSentences(paragraph);
  if (sentences.length === 0) {
    return [];
  }

  const kept: Array<{ text: string; claim_like: boolean }> = [];
  for (const sentence of sentences) {
    const signals = getSentenceGroundingSignals(sentence, knownUrls, anchorTokens);
    const assessment = assessSentenceAgainstResearchPack(sentence, signals, researchPack);
    if (signals.claim_like && !assessment.strong_support) {
      if (!assessment.salvageable_by_rewrite) {
        continue;
      }
    }

    let next = sentence;
    if (signals.claim_like && assessment.salvageable_by_rewrite && assessment.best_claim) {
      const rewritten = buildNarrowEvidenceSentence(
        assessment.best_claim,
        assessment.best_source_title,
        assessment.best_source_url
      );
      if (rewritten) {
        next = rewritten;
      }
    }

    if (signals.claim_like) {
      next = softenAbsoluteLanguage(next);
      if (!signals.has_known_url && assessment.strong_support) {
        const sourceUrl = assessment.best_source_url;
        if (sourceUrl && knownUrls.has(sourceUrl)) {
          next = appendInlineSourceCitation(next, sourceUrl);
        }
      }
    } else if (!signals.has_known_url && /\b(always|never|guarantees|proves|definitely|undeniably)\b/i.test(next)) {
      next = softenAbsoluteLanguage(next);
    }

    const normalized = next.replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) {
      kept.push({ text: normalized, claim_like: signals.claim_like });
    }
  }

  if (kept.length === 0) {
    return [];
  }

  // Keep factual points tight: one core factual sentence per paragraph (with optional nearby context sentence).
  const grouped: string[] = [];
  let current: string[] = [];
  let currentHasClaim = false;

  const flushCurrent = () => {
    if (current.length > 0) {
      grouped.push(current.join(' ').trim());
      current = [];
      currentHasClaim = false;
    }
  };

  for (const item of kept) {
    if (item.claim_like) {
      if (currentHasClaim) {
        flushCurrent();
      }
      current.push(item.text);
      currentHasClaim = true;
      continue;
    }

    if (!currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    if (currentHasClaim && current.length >= 2) {
      flushCurrent();
    }
    current.push(item.text);
  }
  flushCurrent();

  return grouped.filter((item) => item.length >= 40);
}

function splitIntoSentences(paragraph: string): string[] {
  const normalized = paragraph
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$1 ($2)')
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"\(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function getSentenceGroundingSignals(
  sentence: string,
  knownUrls: Set<string>,
  anchorTokens: Set<string>
): SentenceGroundingSignals {
  const urls = extractUrlsFromText(sentence);
  const claimLike = isClaimLikeSentence(sentence);
  return {
    claim_like: claimLike,
    has_known_url: urls.some((url) => knownUrls.has(url)),
    has_evidence_id: /\bE\d{3}\b/.test(sentence),
    has_anchor_overlap: hasEvidenceAnchorOverlap(sentence, anchorTokens),
    has_attribution: /\b(according to|reported by|data from|analysis from|figures from|statement from|filing from)\b/i.test(sentence),
  };
}

function isClaimLikeSentence(sentence: string): boolean {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (normalized.length < 45) return false;
  return /\b(is|are|was|were|will|can|could|should|must|reported|showed|shows|indicates|suggests|increased|decreased|rose|fell|expects|forecast)\b/i.test(
    normalized
  );
}

function isClaimMapCandidateLikeSentence(sentence: string): boolean {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (normalized.length < 45 || normalized.length > 320) return false;
  if (/^[-*]\s/.test(normalized)) return false;
  if (/^\(?source\b/i.test(normalized)) return false;
  return true;
}

function isLikelyUnsupportedSynthesisResidue(sentence: string): boolean {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (normalized.length < 45) return false;
  return /\b(raises questions|raises concerns|underscores|serves as|call to action|this includes|ongoing challenges|prompts (urgent )?discussions|implications for|as .* (approaches|near)s|without corrective measures|necessity for|importance of vigilance|reminder of|growing scrutiny)\b/i.test(
    normalized
  );
}

function isBroadSynthesisStyleSentence(sentence: string): boolean {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (normalized.length < 55) return false;
  const broadCue = /\b(significant|substantial|major|broad|widespread|far[- ]reaching|long[- ]term|global|regional|systemic|across sectors|across industries|across markets|overall)\b/i.test(
    normalized
  );
  const causalCue = /\b(therefore|thus|as a result|which means|leading to|resulting in|driving)\b/i.test(normalized);
  return broadCue || causalCue;
}

function hasConcreteSpecificityCue(text: string): boolean {
  return /\b(\d{1,4}|%|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|202\d)\b/i.test(
    text
  );
}

function appendInlineSourceCitation(sentence: string, sourceUrl: string): string {
  if (!sourceUrl || /\(https?:\/\/[^\s\)]+\)/i.test(sentence) || sentence.includes(sourceUrl)) {
    return sentence;
  }
  const trimmed = sentence.trim();
  const sourceDomain = safeDomain(sourceUrl);
  if (!sourceDomain) {
    return trimmed;
  }
  if (trimmed.toLowerCase().includes(sourceDomain.toLowerCase())) {
    return trimmed;
  }
  const trailing = trimmed.match(/[.!?]$/)?.[0] || '';
  const base = trailing ? trimmed.slice(0, -1).trimEnd() : trimmed;
  return `${base} (${sourceDomain})${trailing || '.'}`;
}

function isClaimLikeParagraph(paragraph: string): boolean {
  const normalized = paragraph.replace(/\s+/g, ' ').trim();
  if (normalized.length < 80) {
    return false;
  }
  if (/^[-*]\s/.test(normalized)) {
    return false;
  }
  return /\b(is|are|was|were|will|can|could|should|must|reported|showed|shows|indicates|suggests|increased|decreased|rose|fell|expects|forecast)\b/i.test(
    normalized
  );
}

function buildArticleTypeDraftingRules(articleType: CanonicalArticleType): string[] {
  if (articleType === 'analysis') {
    return [
      'Frame sections as trade-offs and implications, not generic recommendations.',
      'Contrast at least two evidence-backed perspectives when sources support it.',
      'Use measured language and explicitly mark uncertainty where evidence is mixed.',
    ];
  }
  if (articleType === 'report') {
    return [
      'Lead with concrete developments and chronology supported by source evidence.',
      'Keep context tight and tied to what changed, with source-linked specifics.',
      'Avoid evergreen how-to advice unless directly supported by cited reporting.',
    ];
  }
  return [
    'Teach from concrete evidence-backed examples before giving broad guidance.',
    'Define key terms only when needed, then move quickly to sourced specifics.',
    'Prefer short explanatory sections anchored to explicit source citations.',
  ];
}

function getPriorityEvidenceForDraft(researchPack: ResearchPack, limit: number): ResearchPack['evidence_items'] {
  const scored = researchPack.evidence_items
    .map((item) => ({
      item,
      score:
        (item.confidence === 'high' ? 3 : item.confidence === 'medium' ? 2 : 1) +
        (item.claim.length > 60 ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);

  return scored;
}

function bindImageFrontmatter(content: string, imagePath?: string): string {
  if (!imagePath) {
    return content;
  }
  if (!content.startsWith('---\n')) {
    return content;
  }
  const lines = content.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return content;
  }
  const frontmatterLines = lines.slice(1, endIndex);
  const imageLine = `image: ${imagePath}`;
  const hasImage = frontmatterLines.some((line) => line.trim().startsWith('image:'));
  const updated = hasImage
    ? frontmatterLines.map((line) => (line.trim().startsWith('image:') ? imageLine : line))
    : [...frontmatterLines, imageLine];
  return ['---', ...updated, '---', ...lines.slice(endIndex + 1)].join('\n');
}

function bindCategoryFrontmatter(content: string, category: string): string {
  if (!content.startsWith('---\n')) {
    return content;
  }
  const lines = content.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return content;
  }
  const frontmatterLines = lines.slice(1, endIndex);
  const categoryLine = `category: ${category}`;
  const hasCategory = frontmatterLines.some((line) => line.trim().startsWith('category:'));
  const updated = hasCategory
    ? frontmatterLines.map((line) => (line.trim().startsWith('category:') ? categoryLine : line))
    : [...frontmatterLines, categoryLine];
  return ['---', ...updated, '---', ...lines.slice(endIndex + 1)].join('\n');
}

// ============================================================================
// A. PUBLISH SAFETY GATE - Validate and sanitize content before write
// ============================================================================

interface PublishSafetyValidation {
  isSafe: boolean;
  issues: string[];
}

/**
 * Apply publish safety gate: sanitize broken MDX/HTML residue before write.
 * Removes truncated tags, source-snippet artifacts, malformed anchors, etc.
 */
function applyPublishSafetyGate(content: string): string {
  const text = String(content || '');
  if (!text.startsWith('---\n')) {
    return stripUnsafeInlineHtml(text);
  }

  const lines = text.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return stripUnsafeInlineHtml(text);
  }

  const frontmatter = lines.slice(0, endIndex + 1).join('\n');
  const body = lines.slice(endIndex + 1).join('\n');
  const safeBody = sanitizePublishedBody(stripUnsafeInlineHtml(body));
  return `${frontmatter}\n${safeBody}`.trimEnd();
}

/**
 * Validate content is safe for MDX publication.
 * Returns validation result with issues list if unsafe.
 */
function validatePublishSafety(content: string): PublishSafetyValidation {
  const issues: string[] = [];
  const text = String(content || '');
  const body = text.startsWith('---\n') ? text.replace(/^---\n[\s\S]*?\n---\n?/m, '') : text;

  if (/<\/?[a-z][^>\n]*>/i.test(body)) {
    issues.push('raw HTML remained in publish body');
  }

  if (/<[^>\n]*$/m.test(body)) {
    issues.push('dangling tag fragment remained in publish body');
  }

  if (/\[([^\]]*)\]\(\s*$/gm.test(body)) {
    issues.push('broken markdown link pattern remained in publish body');
  }

  if (/\udcff|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(body)) {
    issues.push('malformed unicode sequences detected');
  }

  return {
    isSafe: issues.length === 0,
    issues,
  };
}

// ============================================================================
// B. IMAGE RESOLUTION - Pexels -> source original image -> blue fallback
// ============================================================================

/**
 * Resolve article cover image using fallback chain:
 * 1. Pexels API (handled externally via fetch-pexels-image.js)
 * 2. Article/source original image (if provided)
 * 3. Blue fallback image (foseer-default-cover.svg)
 */
function resolveArticleImage(
  providedImage: string | undefined,
  articleId: string,
  category: string
): string {
  // If an image was explicitly provided and is valid, use it
  if (providedImage && providedImage.trim()) {
    const normalized = providedImage.trim();
    if (normalized.startsWith('~/') || normalized.startsWith('/')) {
      return normalized;
    }
    if (/^https?:\/\//i.test(normalized)) {
      // External URL - convert to local asset path pattern
      return `~/assets/images/posts/${articleId}/cover.jpg`;
    }
    return normalized;
  }
  
  // Default fallback to blue fallback image
  // This is the "blue fallback" - the foseer-default-cover.svg in src/assets/images/posts/fallback/
  return '~/assets/images/posts/fallback/foseer-default-cover.svg';
}

// ============================================================================
// D. SAFE FILENAME HANDLING - Avoid hard failure on existing files
// ============================================================================

/**
 * Generate a safe deterministic filename.
 * If file exists and allow_overwrite is false, adds a safe suffix.
 */
function generateSafeFilename(
  baseFilename: string,
  outputDir: string,
  allowOverwrite?: boolean
): string {
  const filename = baseFilename;
  const outputPath = path.join(outputDir, filename);
  
  if (allowOverwrite || !fs.existsSync(outputPath)) {
    return filename;
  }
  
  // Generate deterministic suffix based on timestamp
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace(/T/, '_');
  const ext = path.extname(filename);
  const name = path.basename(filename, ext);
  
  // Add safe suffix: name-TIMESTAMP.ext
  const safeFilename = `${name}_${timestamp}${ext}`;
  
  // Ensure uniqueness with counter if needed
  let counter = 1;
  let finalFilename = safeFilename;
  while (fs.existsSync(path.join(outputDir, finalFilename)) && counter < 100) {
    finalFilename = `${name}_${timestamp}_v${counter}${ext}`;
    counter += 1;
  }
  
  console.log(`[publish] filename collision avoided: ${filename} -> ${finalFilename}`);
  return finalFilename;
}

// ============================================================================
// D. MOJIBAKE NORMALIZATION - Clean unicode before slug generation
// ============================================================================

/**
 * Normalize mojibake and malformed unicode in text.
 * Used before slug generation to prevent garbage characters.
 */
function normalizeUnicodeForSlug(text: string): string {
  let normalized = String(text || '');
  
  // Replace replacement character
  normalized = normalized.replace(/\uFFFD/g, '');
  
  // Remove orphaned surrogate pairs
  normalized = normalized.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '');
  normalized = normalized.replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
  
  // Normalize to NFC form for consistent character representation
  try {
    normalized = normalized.normalize('NFC');
  } catch {
    // Ignore normalization errors
  }
  
  // Remove non-printable control characters except common whitespace
  normalized = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  
  return normalized.trim();
}

interface TaxonomyPublishLog {
  article_id: string;
  article_type: CanonicalArticleType;
  section_id?: SectionId;
  topic_id?: TopicId;
  source: 'explicit' | 'inferred';
}

function logTaxonomyPublish(payload: TaxonomyPublishLog): void {
  console.log(`[taxonomy] publish_taxonomy_assigned ${JSON.stringify({
    article_id: payload.article_id,
    article_type: payload.article_type,
    section_id: payload.section_id,
    topic_id: payload.topic_id,
    source: payload.source,
  })}`);
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeUrlForMatch(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function mapOriginClassToDomainClass(
  sourceOriginClass: 'official' | 'licensed_publisher' | 'fallback_search' | undefined
): 'official' | 'licensed_publisher' | 'fallback_search' | 'unknown' {
  if (sourceOriginClass === 'official') return 'official';
  if (sourceOriginClass === 'licensed_publisher') return 'licensed_publisher';
  if (sourceOriginClass === 'fallback_search') return 'fallback_search';
  return 'unknown';
}

function resolveExtractionPolicyThresholds(topic: string): {
  minAcceptedSources: number;
  minIndependentDomains: number;
} {
  if (isHighRiskTopic(topic)) {
    return {
      minAcceptedSources: 2,
      minIndependentDomains: 2,
    };
  }

  return {
    minAcceptedSources: 1,
    minIndependentDomains: 1,
  };
}

function isHighRiskTopic(topic: string): boolean {
  const text = String(topic || '').toLowerCase();
  return /\b(death|killed|violence|attack|war|arrest|arrested|accusation|charged|indicted|sanction|lawsuit|legal exposure|recall|outbreak|health advisory|safety warning|market-moving|bank run|default|fraud)\b/.test(
    text
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Estimate tokens used.
 */
function estimateTokens(researchPack: ResearchPack, draft: ArticleDraft): number {
  const promptTokens =
    researchPack.evidence_items.length * 10 +
    researchPack.key_questions.length * 5 +
    draft.content.length / 4;

  const completionTokens = draft.content.length / 4;

  return Math.round(promptTokens + completionTokens);
}

/**
 * Format article runtime result as markdown.
 */
export function formatArticleRuntimeResult(result: ArticleRuntimeResult): string {
  const sourceAdmissionSection = result.source_admission_summary
    ? `
## Source Admission Summary
- **Candidate URLs Considered**: ${result.source_admission_summary.considered_urls}
- **Admitted Before Extraction**: ${result.source_admission_summary.admitted_sources}
- **Rejected Before Extraction**: ${result.source_admission_summary.rejected_before_extraction}
- **Unique Domains (Admitted)**: ${result.source_admission_summary.unique_domains}
- **Role Mix**: ${Object.entries(result.source_admission_summary.role_mix)
    .map(([role, count]) => `${role}:${count}`)
    .join(', ') || 'none'}
`
    : '';

  const extractionQualitySection = result.extraction_quality_summary
    ? `
## Extraction Quality Gate
- **Considered**: ${result.extraction_quality_summary.considered_count}
- **Accepted**: ${result.extraction_quality_summary.accepted_count}
- **Rejected**: ${result.extraction_quality_summary.rejected_count}
- **Unique Domains (Accepted)**: ${result.extraction_quality_summary.unique_domains_accepted}
- **Retry Attempted**: ${result.extraction_quality_summary.retry_attempted ? 'yes' : 'no'}
- **Policy Compliant**: ${result.extraction_quality_summary.policy_compliant ? 'yes' : 'no'}
- **Policy Failures**: ${result.extraction_quality_summary.policy_failures.join('; ') || 'none'}
`
    : '';

  const cleanEvidenceSection = result.clean_evidence_pack_summary
    ? `
## Clean Evidence Pack
- **Sources**: ${result.clean_evidence_pack_summary.sources}
- **Evidence Blocks**: ${result.clean_evidence_pack_summary.evidence_blocks}
- **Unique Domains**: ${result.clean_evidence_pack_summary.unique_domains}
- **Primary / Reporting / Context**: ${result.clean_evidence_pack_summary.primary_sources} / ${result.clean_evidence_pack_summary.reporting_sources} / ${result.clean_evidence_pack_summary.context_sources}
- **Claim Map Input**: clean evidence pack only
`
    : '';

  const extractionRejectionsSection = result.extraction_rejected_sources?.length
    ? `
## Rejected Extraction Sources
${result.extraction_rejected_sources
  .slice(0, 10)
  .map((item) => `- ${item.source_url} :: ${item.reason}`)
  .join('\n')}
`
    : '';

  const modelTraceSection = result.model_api_trace?.length
    ? `
## Model/API Trace
${result.model_api_trace
  .map(
    (entry) =>
      `- ${entry.stage_name} :: api=${entry.provider_api}, model=${entry.model}, attempt=${entry.attempt}, success=${entry.success ? 'yes' : 'no'}, usage=${entry.usage_available ? (entry.total_tokens || 0) : `est:${entry.estimated_total_tokens || 0}`} tokens${entry.error ? `, error=${entry.error}` : ''}`
  )
  .join('\n')}
`
    : `
## Model/API Trace
- none recorded
`;

  return `---
topic_id: ${result.topic_id}
article_id: ${result.article_id}
generation_timestamp: ${result.generation_timestamp}
author_name: ${result.draft.author_name}
author_persona_id: ${result.draft.author_persona_id}
routed_article_type: ${result.draft.routed_article_type}
total_tokens_used: ${result.total_tokens_used}
exact_total_tokens_used: ${result.token_usage_summary.exact_total_tokens}
estimated_total_tokens_used: ${result.token_usage_summary.estimated_total_tokens}
evidence_items_used: ${result.draft.evidence_used.length}
sources_cited: ${result.draft.sources_cited.length}
editor_passes: ${result.editor_passes.length}
---

# Article Runtime: ${result.topic_id}

## Summary
- **Article ID**: ${result.article_id}
- **Generated**: ${result.generation_timestamp}
- **Author**: ${result.draft.author_name} (${result.draft.author_persona_id})
- **Routed Article Type**: ${result.draft.routed_article_type}
- **Word Count**: ${result.draft.word_count}
- **Evidence Used**: ${result.draft.evidence_used.length} items
- **Sources Cited**: ${result.draft.sources_cited.length} URLs
- **Editor Passes**: ${result.editor_passes.length}
- **Pre-Author Source Gate**: ${result.pre_author_source_gate.valid ? 'pass' : 'fail'}
- **Source Quality Gate**: ${result.source_quality_gate.valid ? 'pass' : 'fail'}
- **Claim Map Gate**: ${result.claim_map_gate.valid ? 'pass' : 'fail'}
- **Chief Editor Decision**: ${result.chief_editor_review.decision}
- **Tokens Used**: ~${result.total_tokens_used}
- **Exact Tokens (API usage)**: ${result.token_usage_summary.exact_total_tokens}
- **Estimated Tokens**: ${result.token_usage_summary.estimated_total_tokens}
- **Token Usage Complete Across Calls**: ${result.token_usage_summary.usage_available_for_all_calls ? 'yes' : 'no'}

${sourceAdmissionSection}
${extractionQualitySection}
${cleanEvidenceSection}
${extractionRejectionsSection}
${modelTraceSection}

## Pre-Author Source Sufficiency
- **Total Sources**: ${result.pre_author_source_gate.total_sources} (min ${result.pre_author_source_gate.minimum_total_sources})
- **Total Evidence Items**: ${result.pre_author_source_gate.total_evidence_items} (min ${result.pre_author_source_gate.minimum_total_evidence_items})
- **Unique Domains**: ${result.pre_author_source_gate.unique_domains} (min ${result.pre_author_source_gate.minimum_unique_domains})
- **Source-Type Diversity**: ${result.pre_author_source_gate.source_type_diversity} (min ${result.pre_author_source_gate.minimum_source_type_diversity})
- **Key-Question Coverage Ratio**: ${result.pre_author_source_gate.key_question_coverage_ratio} (min ${result.pre_author_source_gate.minimum_key_question_coverage_ratio})
- **Primary-Like Sources**: ${result.pre_author_source_gate.primary_like_sources}
- **Strong / Moderate / Weak**: ${result.pre_author_source_gate.strong_sources} / ${result.pre_author_source_gate.moderate_sources} / ${result.pre_author_source_gate.weak_sources}
- **High-Credibility Sources**: ${result.pre_author_source_gate.high_credibility_sources} (min ${result.pre_author_source_gate.minimum_high_credibility_sources})
- **Average Relevance**: ${result.pre_author_source_gate.average_relevance_score}
- **Weak-Source Share Max**: ${result.pre_author_source_gate.maximum_weak_source_share}
- **Gate Result**: ${result.pre_author_source_gate.valid ? 'pass' : 'fail'}
- **Failure Reasons**: ${result.pre_author_source_gate.failure_reasons.join('; ') || 'none'}

## Source-Quality Review
- **Total Sources**: ${result.source_quality_review.summary.total_sources}
- **Strong / Moderate / Weak**: ${result.source_quality_review.summary.strong_sources} / ${result.source_quality_review.summary.moderate_sources} / ${result.source_quality_review.summary.weak_sources}
- **Unique Domains**: ${result.source_quality_review.summary.unique_domains}
- **Primary-Like Sources**: ${result.source_quality_review.summary.primary_like_sources}
- **Weak Evidence Share**: ${result.source_quality_review.summary.weak_evidence_share}
- **Strong Evidence Share**: ${result.source_quality_review.summary.strong_evidence_share}
- **Primary-Like Evidence Share**: ${result.source_quality_review.summary.primary_like_evidence_share}
- **Gate Result**: ${result.source_quality_gate.valid ? 'pass' : 'fail'}

## Structural Editor Artifact
- **Fallback Used**: ${result.structural_review.fallback_used}
- **Repetition Removed**: ${result.structural_review.removed_repetition_count}
- **Improvements**: ${result.structural_review.improvements_applied.join('; ') || 'none'}

## Fact / Source Checker Artifact
- **Weak Claims Softened**: ${result.fact_source_review.weak_claims_softened.length}
- **Unsupported URLs Removed**: ${result.fact_source_review.unsupported_urls_removed.length}
- **Summary**: ${result.fact_source_review.revisions_summary.join('; ') || 'none'}

## Trust / Policy Editor Artifact
- **Risky Phrases Softened**: ${result.trust_policy_review.risky_phrases_softened.length}
- **Policy-Sensitive Revisions**: ${result.trust_policy_review.policy_sensitive_revisions.length}
- **Summary**: ${result.trust_policy_review.trust_notes.join('; ') || 'none'}

## Claim Map Artifact
- **Total Claims**: ${result.claim_map.summary.total_claims}
- **Factual Claims**: ${result.claim_map_gate.factual_claims}
- **Supported**: ${result.claim_map.summary.supported}
- **Partially Supported**: ${result.claim_map.summary.partially_supported}
- **Unsupported**: ${result.claim_map.summary.unsupported}
- **Opinion/Analysis**: ${result.claim_map.summary.opinion_or_analysis}
- **Weak Claims**: ${result.claim_map_gate.weak_claims} / ${result.claim_map_gate.allowed_weak_claims}
- **Supported Factual Ratio**: ${result.claim_map_gate.supported_factual_ratio} (min ${result.claim_map_gate.minimum_supported_factual_ratio})
- **Gate Result**: ${result.claim_map_gate.valid ? 'pass' : 'fail'}

## Chief Editor Artifact
- **Decision**: ${result.chief_editor_review.decision}
- **Blocking Issues**: ${result.chief_editor_review.blocking_issues.length}
- **Rationale**: ${result.chief_editor_review.rationale.join('; ') || 'none'}

## Editor Notes
${result.editor_passes.map((p) => `- Pass ${p.pass_number}: ${p.notes} (Quality: ${p.quality_score}/10)`).join('\n')}

---

${result.final_article}
`;
}

export function writeEditorialStageArtifacts(
  result: ArticleRuntimeResult,
  outputDir: string = getRunOutputsDir()
): EditorialArtifactPaths {
  fs.mkdirSync(outputDir, { recursive: true });

  const sourceQualityPath = path.join(outputDir, `${result.article_id}-source-quality-review.md`);
  const structuralPath = path.join(outputDir, `${result.article_id}-structural-review.md`);
  const factPath = path.join(outputDir, `${result.article_id}-fact-source-review.md`);
  const trustPath = path.join(outputDir, `${result.article_id}-trust-policy-review.md`);
  const claimMapPath = path.join(outputDir, `${result.article_id}-claim-map.md`);
  const chiefPath = path.join(outputDir, `${result.article_id}-chief-editor-review.md`);

  const sourceQualityMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: source_quality_review
gate_valid: ${result.source_quality_gate.valid}
total_sources: ${result.source_quality_review.summary.total_sources}
strong_sources: ${result.source_quality_review.summary.strong_sources}
moderate_sources: ${result.source_quality_review.summary.moderate_sources}
weak_sources: ${result.source_quality_review.summary.weak_sources}
unique_domains: ${result.source_quality_review.summary.unique_domains}
weak_evidence_share: ${result.source_quality_review.summary.weak_evidence_share}
strong_evidence_share: ${result.source_quality_review.summary.strong_evidence_share}
primary_like_evidence_share: ${result.source_quality_review.summary.primary_like_evidence_share}
---

# Source-Quality Review: ${result.article_id}

## Gate Summary
- Gate: ${result.source_quality_gate.gate}
- Valid: ${result.source_quality_gate.valid}
- Strong/Moderate/Weak: ${result.source_quality_gate.strong_sources}/${result.source_quality_gate.moderate_sources}/${result.source_quality_gate.weak_sources}
- Unique Domains: ${result.source_quality_gate.unique_domains} (minimum ${result.source_quality_gate.minimum_unique_domains})
- Weak Evidence Share: ${result.source_quality_gate.weak_evidence_share} (max ${result.source_quality_gate.allowed_weak_evidence_share})
- Strong Evidence Share: ${result.source_quality_gate.strong_evidence_share}
- Primary-Like Evidence Share: ${result.source_quality_gate.primary_like_evidence_share} (minimum ${result.source_quality_gate.minimum_primary_like_evidence_share})
- Minimum Strong/Moderate Sources: ${result.source_quality_gate.minimum_strong_or_moderate_sources}

## Failure Reasons
${result.source_quality_gate.failure_reasons.map((item) => `- ${item}`).join('\n') || '- none'}

## Concerns
${result.source_quality_review.concerns.map((item) => `- ${item}`).join('\n') || '- none'}

## Source Entries
${result.source_quality_review.entries
  .map(
    (entry) => `- ${entry.title}
  - URL: ${entry.url}
  - Domain: ${entry.domain || 'unknown'}
  - Type/Credibility/Tier: ${entry.source_type} / ${entry.credibility}/5 / ${entry.tier}
  - Evidence Count: ${entry.evidence_count}
  - Rationale: ${entry.rationale.join('; ')}`
  )
  .join('\n') || '- none'}
`;

  const structuralMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: structural_editor
fallback_used: ${result.structural_review.fallback_used}
removed_repetition_count: ${result.structural_review.removed_repetition_count}
---

# Structural Review: ${result.article_id}

## Improvements Applied
${result.structural_review.improvements_applied.map((item) => `- ${item}`).join('\n') || '- none'}

## Clarity Notes
${result.structural_review.clarity_notes.map((item) => `- ${item}`).join('\n') || '- none'}
`;

  const factMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: fact_source_checker
weak_claims_softened: ${result.fact_source_review.weak_claims_softened.length}
unsupported_urls_removed: ${result.fact_source_review.unsupported_urls_removed.length}
---

# Fact / Source Review: ${result.article_id}

## Weak Claims Softened
${result.fact_source_review.weak_claims_softened.map((item) => `- ${item}`).join('\n') || '- none'}

## Unsupported URLs Removed
${result.fact_source_review.unsupported_urls_removed.map((item) => `- ${item}`).join('\n') || '- none'}

## Revisions Summary
${result.fact_source_review.revisions_summary.map((item) => `- ${item}`).join('\n') || '- none'}
`;

  const trustMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: trust_policy_editor
risky_phrases_softened: ${result.trust_policy_review.risky_phrases_softened.length}
policy_sensitive_revisions: ${result.trust_policy_review.policy_sensitive_revisions.length}
---

# Trust / Policy Review: ${result.article_id}

## Risky Phrases Softened
${result.trust_policy_review.risky_phrases_softened.map((item) => `- ${item}`).join('\n') || '- none'}

## Policy-Sensitive Revisions
${result.trust_policy_review.policy_sensitive_revisions.map((item) => `- ${item}`).join('\n') || '- none'}

## Trust Notes
${result.trust_policy_review.trust_notes.map((item) => `- ${item}`).join('\n') || '- none'}
`;

  const claimMapMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: claim_map
total_claims: ${result.claim_map.summary.total_claims}
supported: ${result.claim_map.summary.supported}
partially_supported: ${result.claim_map.summary.partially_supported}
unsupported: ${result.claim_map.summary.unsupported}
opinion_or_analysis: ${result.claim_map.summary.opinion_or_analysis}
gate_valid: ${result.claim_map_gate.valid}
allowed_unsupported_claims: ${result.claim_map_gate.allowed_unsupported_claims}
---

# Claim Map: ${result.article_id}

## Gate Summary
- Gate: ${result.claim_map_gate.gate}
- Valid: ${result.claim_map_gate.valid}
- Total Claims: ${result.claim_map_gate.total_claims}
- Factual Claims: ${result.claim_map_gate.factual_claims}
- Weak Claims: ${result.claim_map_gate.weak_claims}
- Allowed Weak Claims: ${result.claim_map_gate.allowed_weak_claims}
- Supported Factual Ratio: ${result.claim_map_gate.supported_factual_ratio}
- Minimum Supported Factual Ratio: ${result.claim_map_gate.minimum_supported_factual_ratio}
- Unsupported Claims: ${result.claim_map_gate.unsupported_claims}
- Allowed Unsupported Claims: ${result.claim_map_gate.allowed_unsupported_claims}

## Failure Reasons
${result.claim_map_gate.failure_reasons.map((item) => `- ${item}`).join('\n') || '- none'}

## Claims
${result.claim_map.entries
  .map(
    (entry) => `### ${entry.id}
- Claim: ${entry.claim_text}
- Support Status: ${entry.support_status}
- Matching Score: ${entry.matching_score}
- Claim Specificity: ${entry.claim_specificity}
- Grounding Signal: ${entry.grounding_signal}
- Supporting Evidence IDs: ${entry.supporting_evidence_ids.join(', ') || 'none'}
- Supporting Source URLs: ${entry.supporting_source_urls.join(', ') || 'none'}
- Weakness/Uncertainty Note: ${entry.weakness_or_uncertainty_note || 'none'}`
  )
  .join('\n\n') || 'No claims mapped.'}
`;

  const chiefMd = `---
article_id: ${result.article_id}
topic_id: ${result.topic_id}
stage: chief_editor
decision: ${result.chief_editor_review.decision}
blocking_issues: ${result.chief_editor_review.blocking_issues.length}
---

# Chief Editor Review: ${result.article_id}

## Decision
- ${result.chief_editor_review.decision}

## Rationale
${result.chief_editor_review.rationale.map((item) => `- ${item}`).join('\n') || '- none'}

## Blocking Issues
${result.chief_editor_review.blocking_issues.map((item) => `- ${item}`).join('\n') || '- none'}

## Reviewed Stages
${result.chief_editor_review.reviewed_stages.map((item) => `- ${item}`).join('\n')}
`;

  fs.writeFileSync(sourceQualityPath, sourceQualityMd, 'utf-8');
  fs.writeFileSync(structuralPath, structuralMd, 'utf-8');
  fs.writeFileSync(factPath, factMd, 'utf-8');
  fs.writeFileSync(trustPath, trustMd, 'utf-8');
  fs.writeFileSync(claimMapPath, claimMapMd, 'utf-8');
  fs.writeFileSync(chiefPath, chiefMd, 'utf-8');

  return {
    source_quality_review_path: sourceQualityPath,
    structural_review_path: structuralPath,
    fact_source_review_path: factPath,
    trust_policy_review_path: trustPath,
    claim_map_path: claimMapPath,
    chief_editor_review_path: chiefPath,
  };
}

function isRetryableOpenAiStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('abort') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  );
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1000 * (attempt + 1), 3000);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readRuntimeIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? `${fallback}`, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function readRuntimeFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = Number.parseFloat(raw ?? `${fallback}`);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
