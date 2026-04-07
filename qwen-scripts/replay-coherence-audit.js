// File: qwen-scripts/replay-coherence-audit.js
// Purpose: Replay the latest 15 published articles through the new coherence gate
// to measure before/after improvement. Does NOT publish outputs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src/data/post');

import { evaluatePreDraftCoherence, applyCoherenceRepair } from './utils/pre-draft-coherence-gate.js';

// ============================================================
// Fixed replay test set: the latest 15 published articles
// ============================================================
const REPLAY_ARTICLES = [
  '2026-04-06-poga-ar-investigated-for-running-red-light-at-tour-of-flande.mdx',
  '2026-04-06-how-recorded-music-emerged-stronger-from-the-digital-storm.mdx',
  '2026-04-06-what-openai-s-latest-funding-remarks-reveal-about-the-ai-rac.mdx',
  '2026-04-06-the-drama-tests-how-far-a-glossy-twist-can-carry-weighty-the.mdx',
  '2026-04-06-how-firm-is-the-ipledge-rems-assessing-the-near-term-outlook.mdx',
  '2026-04-06-writers-guild-reaches-surprise-tentative-deal-with-tv-and-fi.mdx',
  '2026-04-06-what-artemis-ii-s-new-far-side-moon-photo-signals-about-nasa.mdx',
  '2026-04-06-ucla-s-first-ncaa-women-s-title-and-what-their-79-51-rout-re.mdx',
  '2026-04-06-trump-warns-iran-to-reopen-strait-of-hormuz-by-tuesday-or-fa.mdx',
  '2026-04-06-screenwriters-union-hollywood-studios-reach-four-year-tentat.mdx',
  '2026-04-06-leeds-edge-west-ham-on-penalties-after-a-comeback-that-chang.mdx',
  '2026-04-06-pope-leo-xiv-urges-hope-and-dialogue-in-first-easter-mass-as.mdx',
  '2026-04-06-iowa-state-star-audi-crooks-enters-transfer-portal-amid-mass.mdx',
  '2026-04-06-bernardo-silva-nears-man-city-exit-as-club-signals-story-s-e.mdx',
  '2026-04-05-trump-s-college-sports-order-tests-federal-leverage-over-cam.mdx',
];

// ============================================================
// Known audit verdicts from the previous manual audit
// ============================================================
const KNOWN_VERDICTS = {
  '2026-04-06-poga-ar-investigated-for-running-red-light-at-tour-of-flande.mdx': {
    title: "Pogačar investigated for running red light at Tour of Flanders",
    original_section: 'tech',
    original_topic: 'cybersecurity',
    correct_section: 'sports',
    image_verdict: 'PASS (cycling photo)',
    tag_verdict: 'FAIL ("Cybersecurity" for cycling)',
  },
  '2026-04-06-how-recorded-music-emerged-stronger-from-the-digital-storm.mdx': {
    title: "How Recorded Music Emerged Stronger From the Digital Storm",
    original_section: 'culture',
    original_topic: 'film-tv',
    correct_section: 'culture',
    image_verdict: 'PASS (vinyl records)',
    tag_verdict: 'PARTIAL ("Film & TV" for music)',
  },
  '2026-04-06-what-openai-s-latest-funding-remarks-reveal-about-the-ai-rac.mdx': {
    title: "What OpenAI's latest funding remarks reveal about the AI race",
    original_section: 'tech',
    original_topic: 'ai-big-tech',
    correct_section: 'tech',
    image_verdict: 'FAIL (airplane for AI)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-the-drama-tests-how-far-a-glossy-twist-can-carry-weighty-the.mdx': {
    title: "'The Drama' tests how far a glossy twist can carry weighty themes",
    original_section: 'culture',
    original_topic: 'film-tv',
    correct_section: 'culture',
    image_verdict: 'PARTIAL (generic drama sign)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-how-firm-is-the-ipledge-rems-assessing-the-near-term-outlook.mdx': {
    title: "How Firm Is the iPLEDGE REMS? Assessing the Near-Term Outlook",
    original_section: 'health',
    original_topic: 'pharma-fda',
    correct_section: 'health',
    image_verdict: 'FAIL (pediatric dental for pharma)',
    tag_verdict: 'PARTIAL ("Strategy" meaningless)',
  },
  '2026-04-06-writers-guild-reaches-surprise-tentative-deal-with-tv-and-fi.mdx': {
    title: "Writers Guild Reaches Surprise Tentative Deal With TV and Film Producers",
    original_section: 'culture',
    original_topic: 'film-tv',
    correct_section: 'culture',
    image_verdict: 'FAIL (generic B&W portrait)',
    tag_verdict: 'PASS (thin)',
  },
  '2026-04-06-what-artemis-ii-s-new-far-side-moon-photo-signals-about-nasa.mdx': {
    title: "What Artemis II's new far-side Moon photo signals about NASA's next move",
    original_section: 'tech',
    original_topic: 'space-astronomy',
    correct_section: 'tech',
    image_verdict: 'FAIL (airplane for space)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-ucla-s-first-ncaa-women-s-title-and-what-their-79-51-rout-re.mdx': {
    title: "UCLA's first NCAA women's title, and what their 79-51 rout really changed",
    original_section: 'sports',
    original_topic: 'major-leagues',
    correct_section: 'sports',
    image_verdict: 'PASS (basketball)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-trump-warns-iran-to-reopen-strait-of-hormuz-by-tuesday-or-fa.mdx': {
    title: "Trump warns Iran to reopen Strait of Hormuz by Tuesday or face 'hell'",
    original_section: 'news',
    original_topic: 'world-geopolitics',
    correct_section: 'news',
    image_verdict: 'FAIL (hallway for Iran)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-screenwriters-union-hollywood-studios-reach-four-year-tentat.mdx': {
    title: "Screenwriters Union, Hollywood Studios Reach Four-Year Tentative Deal",
    original_section: 'business',
    original_topic: 'economy-markets',
    correct_section: 'culture',
    image_verdict: 'FAIL (generic group photo)',
    tag_verdict: 'PARTIAL ("Economy & Markets" for Hollywood labor)',
  },
  '2026-04-06-leeds-edge-west-ham-on-penalties-after-a-comeback-that-chang.mdx': {
    title: "Leeds Edge West Ham on Penalties After a Comeback That Changed Nothing",
    original_section: 'sports',
    original_topic: 'major-leagues',
    correct_section: 'sports',
    image_verdict: 'FAIL (woman catching ball for football)',
    tag_verdict: 'FAIL ("NBA" for soccer)',
  },
  '2026-04-06-pope-leo-xiv-urges-hope-and-dialogue-in-first-easter-mass-as.mdx': {
    title: "Pope Leo XIV urges hope and dialogue in first Easter Mass as pontiff",
    original_section: 'news',
    original_topic: 'world-geopolitics',
    correct_section: 'news',
    image_verdict: 'FAIL (baby Easter for papal Mass)',
    tag_verdict: 'PARTIAL ("Diplomacy" stretch)',
  },
  '2026-04-06-iowa-state-star-audi-crooks-enters-transfer-portal-amid-mass.mdx': {
    title: "Iowa State Star Audi Crooks Enters Transfer Portal Amid Mass Exodus",
    original_section: 'sports',
    original_topic: 'transfers-business',
    correct_section: 'sports',
    image_verdict: 'FAIL (globe for basketball)',
    tag_verdict: 'PASS',
  },
  '2026-04-06-bernardo-silva-nears-man-city-exit-as-club-signals-story-s-e.mdx': {
    title: "Bernardo Silva Nears Man City Exit as Club Signals Story's 'End'",
    original_section: 'business',
    original_topic: 'travel-consumer-issues',
    correct_section: 'sports',
    image_verdict: 'FAIL (neon bar for soccer)',
    tag_verdict: 'FAIL ("Travel & Consumer Issues" for soccer)',
  },
  '2026-04-05-trump-s-college-sports-order-tests-federal-leverage-over-cam.mdx': {
    title: "Trump's College Sports Order Tests Federal Leverage Over Campus Athletics",
    original_section: 'sports',
    original_topic: 'transfers-business',
    correct_section: 'news',
    image_verdict: 'FAIL (COVID-19 for college sports)',
    tag_verdict: 'PASS',
  },
};

// ============================================================
// Parse MDX frontmatter to reconstruct a candidate object
// ============================================================
function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const data = {};
  for (const line of fm.split('\n')) {
    const match = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (match) data[match[1]] = match[2].trim();
  }

  // Parse sources
  const sources = [];
  const sourceBlocks = raw.match(/sources:\r?\n((?:\s+- .+\r?\n)*)/);
  if (sourceBlocks) {
    const sourceLines = sourceBlocks[1].split('\n').filter(l => l.trim());
    let currentSource = {};
    for (const line of sourceLines) {
      const trimmed = line.trim().replace(/^- /, '');
      if (trimmed.startsWith('title:')) {
        if (Object.keys(currentSource).length > 0) sources.push(currentSource);
        currentSource = { title: trimmed.replace('title: ', '').replace(/"/g, '') };
      } else if (trimmed.startsWith('url:')) {
        currentSource.url = trimmed.replace('url: ', '').replace(/"/g, '');
      } else if (trimmed.startsWith('domain:')) {
        currentSource.domain = trimmed.replace('domain: ', '').replace(/"/g, '');
      }
    }
    if (Object.keys(currentSource).length > 0) sources.push(currentSource);
  }

  // Parse tags
  const tags = [];
  const tagBlock = raw.match(/tags:\r?\n((?:\s+- .+\r?\n)*)/);
  if (tagBlock) {
    const tagLines = tagBlock[1].split('\n').filter(l => l.trim());
    for (const line of tagLines) {
      const tag = line.trim().replace(/^- /, '').replace(/"/g, '');
      if (tag) tags.push(tag);
    }
  }

  return { data, sources, tags, body: raw.replace(fmMatch[0], '').trim() };
}

function buildCandidateFromArticle(filename, parsed) {
  const { data, sources, tags, body } = parsed;

  // Extract key text from the body for coherence checking
  const bodyLines = body.split('\n').filter(l => l.trim() && !l.startsWith('##'));
  const bodySummary = bodyLines.slice(0, 5).join(' ').substring(0, 500);

  return {
    brief: {
      title: data.title || '',
      summary: data.excerpt || '',
      whatHappened: bodySummary,
      section_id: data.section_id || null,
      topic_id: data.topic_id || null,
      articleType: data.article_type || 'report',
    },
    sourcePack: {
      section_id: data.section_id || null,
      topic_id: data.topic_id || null,
      sources: sources,
    },
    placement: {
      section_id: data.section_id || null,
      topic_id: data.topic_id || null,
    },
    canonicalPublishPayload: {
      tagging: { tags },
      placement: {
        section_id: data.section_id || null,
        topic_id: data.topic_id || null,
      },
    },
  };
}

// ============================================================
// Run replay
// ============================================================
function runReplay() {
  console.log('=== COHERENCE GATE REPLAY TEST ===');
  console.log(`Test set: ${REPLAY_ARTICLES.length} articles\n`);

  const results = [];

  for (const filename of REPLAY_ARTICLES) {
    const filePath = path.join(POSTS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.log(`SKIP: ${filename} (file not found)`);
      continue;
    }

    const parsed = parseFrontmatter(filePath);
    if (!parsed) {
      console.log(`SKIP: ${filename} (no frontmatter)`);
      continue;
    }

    const candidate = buildCandidateFromArticle(filename, parsed);
    const known = KNOWN_VERDICTS[filename];

    // Run coherence gate
    const coherenceResult = evaluatePreDraftCoherence(candidate, {});

    // Determine outcome
    let outcome = 'unchanged acceptable';
    const originalSectionCorrect = known?.correct_section === candidate.brief.section_id;
    const originalTagCorrect = known?.tag_verdict === 'PASS';
    const originalImageCorrect = known?.image_verdict === 'PASS';

    if (coherenceResult.action === 'reject') {
      outcome = 'rejected earlier';
    } else if (coherenceResult.action === 'repair') {
      outcome = 'repaired earlier';
    } else if (!originalSectionCorrect && coherenceResult.sectionCheck?.score >= 0.5) {
      outcome = 'improved';
    } else if (!originalTagCorrect && coherenceResult.tagCheck?.pass) {
      outcome = 'improved';
    } else if (originalSectionCorrect && originalTagCorrect && coherenceResult.action === 'pass') {
      outcome = 'unchanged acceptable';
    } else if (coherenceResult.action === 'pass' && coherenceResult.warnings.length > 0) {
      outcome = 'unchanged problematic';
    }

    results.push({
      filename,
      title: known?.title || candidate.brief.title,
      original_section: candidate.brief.section_id,
      original_topic: candidate.brief.topic_id,
      correct_section: known?.correct_section,
      coherence_action: coherenceResult.action,
      coherence_section_score: coherenceResult.sectionCheck?.score?.toFixed(2) || 'N/A',
      domain_mismatch: coherenceResult.domainMismatch?.isMismatch ? `detected=${coherenceResult.domainMismatch.detectedDomain} (${(coherenceResult.domainMismatch.confidence * 100).toFixed(0)}%)` : 'none',
      tag_errors: coherenceResult.tagCheck?.errors || [],
      image_plan: coherenceResult.imagePlan?.concepts?.slice(0, 3) || [],
      warnings: coherenceResult.warnings,
      known_image_verdict: known?.image_verdict,
      known_tag_verdict: known?.tag_verdict,
      outcome,
      explanation: buildExplanation(coherenceResult, known, candidate),
    });

    console.log(`${outcome.toUpperCase().padEnd(22)} | ${candidate.brief.title.substring(0, 60).padEnd(62)} | section=${candidate.brief.section_id.padEnd(10)} topic=${candidate.brief.topic_id.padEnd(25)} | score=${coherenceResult.sectionCheck?.score?.toFixed(2) || 'N/A'}`);
  }

  // Summary
  console.log('\n=== REPLAY SUMMARY ===');
  const counts = { improved: 0, 'unchanged acceptable': 0, 'unchanged problematic': 0, 'rejected earlier': 0, 'repaired earlier': 0 };
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  console.log(`Improved:            ${counts.improved}`);
  console.log(`Unchanged acceptable: ${counts['unchanged acceptable']}`);
  console.log(`Unchanged problematic: ${counts['unchanged problematic']}`);
  console.log(`Rejected earlier:    ${counts['rejected earlier']}`);
  console.log(`Repaired earlier:    ${counts['repaired earlier']}`);
  console.log(`Total:               ${results.length}`);

  // Section/topic fixes detected
  console.log('\n=== SECTION/TOPIC FIXES DETECTED ===');
  const fixes = results.filter(r => r.coherence_action === 'repair' || r.coherence_action === 'reject');
  for (const f of fixes) {
    console.log(`  ${f.title}`);
    console.log(`    Original: ${f.original_section}/${f.original_topic}`);
    console.log(`    Coherence: ${f.coherence_action} (score=${f.coherence_section_score})`);
    if (f.domain_mismatch !== 'none') {
      console.log(`    Mismatch: ${f.domain_mismatch}`);
    }
    if (f.tag_errors.length > 0) {
      console.log(`    Tag errors: ${f.tag_errors.join('; ')}`);
    }
  }

  return results;
}

function buildExplanation(coherenceResult, known, candidate) {
  const parts = [];

  if (coherenceResult.action === 'reject') {
    parts.push(`Rejected by coherence gate: ${coherenceResult.reasons.join('; ')}`);
  } else if (coherenceResult.action === 'repair') {
    parts.push(`Repaired: section suggested=${coherenceResult.repairs?.suggested_section_id}`);
  }

  if (coherenceResult.domainMismatch?.isMismatch) {
    const dm = coherenceResult.domainMismatch;
    parts.push(`Domain mismatch detected: content signals "${dm.detectedDomain}" but placed in "${dm.proposedSection}"`);
  }

  if (coherenceResult.tagCheck?.errors?.length > 0) {
    parts.push(`Tag coherence issues: ${coherenceResult.tagCheck.errors.join('; ')}`);
  }

  if (coherenceResult.action === 'pass' && !coherenceResult.domainMismatch?.isMismatch && coherenceResult.tagCheck?.pass !== false) {
    if (known?.correct_section === candidate.brief.section_id) {
      parts.push('Original placement was correct, coherence gate confirms');
    } else {
      parts.push('Coherence gate did not catch the original placement error');
    }
  }

  return parts.join('. ');
}

// Run
const results = runReplay();

// Write results to file for reference
const outputPath = path.resolve(PROJECT_ROOT, 'qwen-data', 'coherence-replay-results.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
console.log(`\nResults written to: ${outputPath}`);
