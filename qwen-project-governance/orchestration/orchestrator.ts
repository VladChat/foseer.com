// File: qwen-project-governance/orchestration/orchestrator.ts
// Purpose: Minimal orchestration connecting intake -> duplicate guard -> brief -> research pack -> claim/decision -> publisher
// Input: Topic candidate file
// Output: Published article in src/data/post/ + pipeline artifacts

import * as fs from 'fs';
import * as path from 'path';

// Import from pipeline modules
import { scoreTopic, parseTopicCandidate, formatRankedTopic, type ScoringFactors } from '../intake/topic_intake.js';
import { decideNewOrUpdate, parseInventory, formatDecision as formatGuardDecision, normalizeTopic } from '../duplicate-guard/duplicate_guard.js';
import { buildBrief, formatBrief, type Brief } from '../brief-builder/brief_builder.js';
import { buildResearchPack, formatResearchPack, type ResearchPack } from '../research-pack-builder/research_pack_builder.js';
import { buildClaimMap, makeDecision, formatClaimMap, formatDecision } from '../claim-decision-flow/claim_decision_flow.js';
import { formatPublishedArticle, formatInventoryEntry, isApproved, type ArticleDraft, type EditorialDecision } from '../publisher/publisher.js';

export interface OrchestrationResult {
  success: boolean;
  topicId: string;
  articleId: string | null;
  stages: {
    intake: boolean;
    duplicateGuard: boolean;
    briefBuilder: boolean;
    researchPackBuilder: boolean;
    claimDecision: boolean;
    publisher: boolean;
  };
  outputPaths: string[];
  logs: string[];
}

/**
 * Run full pipeline orchestration for one topic.
 */
export async function runPipeline(
  topicCandidatePath: string,
  inventoryPath: string,
  outputDir: string,
  artifactsDir: string
): Promise<OrchestrationResult> {
  const logs: string[] = [];
  const outputPaths: string[] = [];
  const stages = {
    intake: false,
    duplicateGuard: false,
    briefBuilder: false,
    researchPackBuilder: false,
    claimDecision: false,
    publisher: false,
  };

  let topicId = '';
  let articleId: string | null = null;

  try {
    // ========== STAGE 1: TOPIC INTAKE ==========
    logs.push('[STAGE 1] Topic Intake: Starting...');
    const candidateMarkdown = fs.readFileSync(topicCandidatePath, 'utf-8');
    const candidate = parseTopicCandidate(candidateMarkdown);
    topicId = candidate.topic_id;

    // Score the topic
    const scoringFactors: ScoringFactors = {
      audience_relevance: 8,
      evidence_availability: 7,
      timeliness: 8,
      differentiation: 6,
    };
    const rankedTopic = scoreTopic(candidate, scoringFactors);

    // Write ranked topic artifact
    const rankedTopicPath = path.join(artifactsDir, `${topicId}_ranked_topic.md`);
    fs.writeFileSync(rankedTopicPath, formatRankedTopic(rankedTopic));
    outputPaths.push(rankedTopicPath);
    logs.push(`[STAGE 1] Topic Intake: Complete. Output: ${rankedTopicPath}`);
    stages.intake = true;

    // ========== STAGE 2: DUPLICATE GUARD ==========
    logs.push('[STAGE 2] Duplicate Guard: Starting...');
    const inventoryMarkdown = fs.readFileSync(inventoryPath, 'utf-8');
    const inventory = parseInventory(inventoryMarkdown);

    // Enrich ranked topic for duplicate guard
    const enrichedRankedTopic = {
      ...rankedTopic,
      topic_title: candidate.topic_title,
      core_subjects: candidate.topic_title.toLowerCase().split(' ').filter(w => w.length > 3),
      entities: [],
      is_time_bound: scoringFactors.timeliness >= 7,
    };

    const guardDecision = decideNewOrUpdate(enrichedRankedTopic, inventory);

    // Write duplicate guard decision artifact
    const guardDecisionPath = path.join(artifactsDir, `${topicId}_guard_decision.md`);
    fs.writeFileSync(guardDecisionPath, formatGuardDecision(guardDecision));
    outputPaths.push(guardDecisionPath);
    logs.push(`[STAGE 2] Duplicate Guard: Complete. Decision: ${guardDecision.decision_type}`);
    stages.duplicateGuard = true;

    if (guardDecision.decision_type === 'reject') {
      logs.push('[PIPELINE] Topic rejected as duplicate. Stopping.');
      return {
        success: false,
        topicId,
        articleId: null,
        stages,
        outputPaths,
        logs,
      };
    }

    articleId = guardDecision.assigned_article_id || guardDecision.target_article_id;

    // ========== STAGE 3: BRIEF BUILDER ==========
    logs.push('[STAGE 3] Brief Builder: Starting...');
    const brief = buildBrief(
      { ...rankedTopic, topic_title: candidate.topic_title },
      guardDecision
    );

    // Write brief artifact
    const briefPath = path.join(artifactsDir, `${topicId}_brief.md`);
    fs.writeFileSync(briefPath, formatBrief(brief));
    outputPaths.push(briefPath);
    logs.push(`[STAGE 3] Brief Builder: Complete. Article ID: ${brief.article_id}`);
    stages.briefBuilder = true;

    // ========== STAGE 4: RESEARCH PACK BUILDER ==========
    logs.push('[STAGE 4] Research Pack Builder: Starting...');
    const researchPack = buildResearchPack(brief);

    // Write research pack artifact
    const researchPackPath = path.join(artifactsDir, `${topicId}_research_pack.md`);
    fs.writeFileSync(researchPackPath, formatResearchPack(researchPack));
    outputPaths.push(researchPackPath);
    logs.push(`[STAGE 4] Research Pack Builder: Complete. ${researchPack.source_list.length} sources, ${researchPack.evidence_items.length} evidence items`);
    stages.researchPackBuilder = true;

    // ========== STAGE 5: CLAIM MAP / DECISION ==========
    logs.push('[STAGE 5] Claim Map / Decision: Starting...');
    const claimMap = buildClaimMap(researchPack);
    const decision = makeDecision(claimMap);

    // Write claim map artifact
    const claimMapPath = path.join(artifactsDir, `${topicId}_claim_map.md`);
    fs.writeFileSync(claimMapPath, formatClaimMap(claimMap));
    outputPaths.push(claimMapPath);

    // Write decision artifact
    const decisionPath = path.join(artifactsDir, `${topicId}_editorial_decision.md`);
    fs.writeFileSync(decisionPath, formatDecision(decision));
    outputPaths.push(decisionPath);
    logs.push(`[STAGE 5] Claim Map / Decision: Complete. Decision: ${decision.decision}, Next: ${decision.next_action}`);
    stages.claimDecision = true;

    // ========== STAGE 6: PUBLISHER ==========
    logs.push('[STAGE 6] Publisher: Starting...');

    // Check if approved for publication
    const editorialDecision: EditorialDecision = {
      article_id: articleId!,
      decision: decision.decision,
      next_action: decision.next_action,
    };

    if (!isApproved(editorialDecision)) {
      logs.push(`[STAGE 6] Publisher: Article not approved (${decision.decision}). Skipping publication.`);
      stages.publisher = false;
      return {
        success: false,
        topicId,
        articleId,
        stages,
        outputPaths,
        logs,
      };
    }

    // Create article draft from research pack (simplified for orchestration demo)
    const articleDraft: ArticleDraft = {
      topic_id: topicId,
      article_id: articleId!,
      draft_version: 1,
      author: 'Foseer Editorial',
      created: new Date().toISOString().split('T')[0],
      status: 'approved',
      content: generateArticleContent(brief, researchPack),
    };

    // Format and write published article
    const { filename, content } = formatPublishedArticle(
      articleDraft,
      candidate.topic_title,
      brief.article_angle.substring(0, 160)
    );

    const publishedPath = path.join(outputDir, filename);
    fs.writeFileSync(publishedPath, content);
    outputPaths.push(publishedPath);
    logs.push(`[STAGE 6] Publisher: Complete. Published: ${publishedPath}`);
    stages.publisher = true;

    // Update article inventory
    updateInventory(inventoryPath, articleId!, topicId, candidate.topic_title, filename);
    logs.push('[STAGE 6] Publisher: Article inventory updated');

    logs.push(`[PIPELINE] Complete. Topic ${topicId} -> Article ${articleId}`);

    return {
      success: true,
      topicId,
      articleId,
      stages,
      outputPaths,
      logs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logs.push(`[ERROR] Pipeline failed: ${errorMessage}`);
    return {
      success: false,
      topicId,
      articleId,
      stages,
      outputPaths,
      logs,
    };
  }
}

/**
 * Generate simple article content from brief and research pack.
 */
function generateArticleContent(brief: Brief, researchPack: ResearchPack): string {
  const questions = brief.key_questions.map((q, i) => {
    const evidence = researchPack.evidence_items[i];
    return `## ${q}\n\n${evidence?.excerpt || 'Content to be written based on research.'}\n`;
  }).join('\n');

  return `## Introduction\n\n${brief.article_angle}\n\n${questions}\n## Conclusion\n\nThis article was generated through the Foseer article intelligence pipeline.`;
}

function ensureExpandedInventoryHeader(lines: string[]): string[] {
  const expectedHeader = '| Article ID | Topic ID | Title | Created | Last Updated | Status | Section | Article Type | Primary Topic | Key Entities | Search Keywords | Canonical URL |';
  const expectedSeparator = '|------------|----------|-------|---------|--------------|--------|---------|--------------|---------------|--------------|-----------------|---------------|';

  const headerIndex = lines.findIndex((line) => line.includes('| Article ID'));
  if (headerIndex < 0) return lines;

  lines[headerIndex] = expectedHeader;
  if (headerIndex + 1 < lines.length && lines[headerIndex + 1].includes('|---')) {
    lines[headerIndex + 1] = expectedSeparator;
  }

  return lines.map((line, index) => {
    if (index <= headerIndex + 1) return line;
    if (!line.trim().startsWith('|')) return line;
    if (/^\|(?:\s*[-:]+\s*\|)+$/.test(line.trim())) return line;

    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells.length >= 12) return line;
    while (cells.length < 12) cells.push('');
    return `| ${cells.join(' | ')} |`;
  });
}

/**
 * Update article inventory with new published article.
 */
function updateInventory(inventoryPath: string, articleId: string, topicId: string, title: string, filename: string): void {
  const normalized = normalizeTopic(title);
  const newEntry = formatInventoryEntry(articleId, topicId, title, filename, {
    primary_topic: title,
    key_entities: normalized.entities,
    search_keywords: normalized.core_subjects,
  });

  const inventoryMarkdown = fs.readFileSync(inventoryPath, 'utf-8');
  const lines = ensureExpandedInventoryHeader(inventoryMarkdown.split('\n'));

  // Find the line after the header separator
  const separatorIndex = lines.findIndex(line => line.includes('|---'));
  if (separatorIndex >= 0) {
    lines.splice(separatorIndex + 1, 0, newEntry);
    fs.writeFileSync(inventoryPath, lines.join('\n'));
  }
}

/**
 * Format orchestration log for operations-log.md
 */
export function formatOrchestrationLog(result: OrchestrationResult): string {
  const stagesCompleted = Object.entries(result.stages)
    .filter(([_, passed]) => passed)
    .map(([name]) => name)
    .join(', ');

  return `
Orchestration Run Summary:
- Topic ID: ${result.topicId}
- Article ID: ${result.articleId || 'N/A'}
- Success: ${result.success}
- Stages Completed: ${stagesCompleted}
- Output Files: ${result.outputPaths.length}
- Logs:
${result.logs.map(l => `  ${l}`).join('\n')}
`;
}
