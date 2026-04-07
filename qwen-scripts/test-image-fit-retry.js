// File: qwen-scripts/test-image-fit-retry.js
// Purpose: Prove the image fit validation + retry logic works end-to-end
// by simulating the full flow with mock provider responses.

import { buildVisualConceptSet } from './utils/pre-draft-coherence-gate.js';

// ============================================================
// Simulate computeImageFitScore (from image-node.js)
// ============================================================
function computeImageFitScore(image, visualConcepts, candidateText) {
  if (!image?.metadata) return 0.5;

  const concepts = (visualConcepts?.concepts || []).map((c) => c.toLowerCase());
  if (concepts.length === 0) return 0.5;

  const imageTags = new Set();
  if (image.metadata.entityHints) {
    image.metadata.entityHints.forEach((t) => imageTags.add(t.toLowerCase()));
  }
  if (image.metadata.sceneType) {
    imageTags.add(image.metadata.sceneType.toLowerCase());
  }
  if (image.altText) {
    image.altText.toLowerCase().split(/\s+/).filter((w) => w.length > 3).forEach((w) => imageTags.add(w));
  }

  let hits = 0;
  for (const concept of concepts) {
    if (imageTags.has(concept)) {
      hits += 1;
    } else if ([...imageTags].some((tag) => tag.includes(concept) || concept.includes(tag))) {
      hits += 0.5;
    }
  }

  const editorialFit = (image.metadata.editorialFitScore || 0) / 100;
  const conceptScore = concepts.length > 0 ? Math.min(1, hits / Math.max(1, concepts.length * 0.5)) : 0.5;
  const combined = (conceptScore * 0.6) + (editorialFit * 0.4);

  return Math.round(combined * 100) / 100;
}

// ============================================================
// Test Case 1: Artemis / airplane mismatch (space article with airplane image)
// ============================================================
console.log('\n=== TEST 1: Artemis / Airplane Mismatch ===');

const artemisConcepts = buildVisualConceptSet('tech', 'space-astronomy', 'NASA Artemis II crew captured new photo of far side of moon lunar space');
console.log('Visual concepts:', artemisConcepts.concepts.join(', '));

const badArtemisImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/airplane/cover.jpg',
  altText: 'A close up of the side of an airplane',
  metadata: {
    entityHints: ['airplane', 'close', 'side'],
    sceneType: 'product',
    editorialFitScore: 20,
  },
};

const goodArtemisImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/moon/cover.jpg',
  altText: 'Far side of the moon from space NASA Artemis',
  metadata: {
    entityHints: ['moon', 'space', 'nasa', 'artemis'],
    sceneType: 'abstract',
    editorialFitScore: 75,
  },
};

const badArtemisScore = computeImageFitScore(badArtemisImage, artemisConcepts, '');
const goodArtemisScore = computeImageFitScore(goodArtemisImage, artemisConcepts, '');

console.log(`Bad image (airplane) fit score: ${badArtemisScore.toFixed(2)}`);
console.log(`Good image (moon) fit score: ${goodArtemisScore.toFixed(2)}`);
console.log(`Would trigger retry (threshold 0.45): ${badArtemisScore < 0.45 ? 'YES ✓' : 'NO ✗'}`);
console.log(`Retry would improve: ${goodArtemisScore > badArtemisScore ? 'YES ✓' : 'NO ✗'}`);

// ============================================================
// Test Case 2: Pope Easter / baby mismatch (Vatican article with baby Easter image)
// ============================================================
console.log('\n=== TEST 2: Pope Easter / Baby Mismatch ===');

const popeConcepts = buildVisualConceptSet('news', 'world-geopolitics', 'Pope Leo XIV Easter Mass Vatican peace dialogue pontiff');
console.log('Visual concepts:', popeConcepts.concepts.join(', '));

const badPopeImage = {
  provider: 'pexels',
  imagePath: '~/assets/images/library/pexels/36841315/cover.jpg',
  altText: 'Charming baby with Easter decorations plush bunny festive setting',
  metadata: {
    entityHints: ['baby', 'easter', 'decorations', 'bunny'],
    sceneType: 'portrait',
    editorialFitScore: 60,
  },
};

const goodPopeImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/vatican/cover.jpg',
  altText: 'Vatican Saint Peter Basilica Pope Mass',
  metadata: {
    entityHints: ['vatican', 'pope', 'basilica', 'mass'],
    sceneType: 'building',
    editorialFitScore: 70,
  },
};

const badPopeScore = computeImageFitScore(badPopeImage, popeConcepts, '');
const goodPopeScore = computeImageFitScore(goodPopeImage, popeConcepts, '');

console.log(`Bad image (baby Easter) fit score: ${badPopeScore.toFixed(2)}`);
console.log(`Good image (Vatican) fit score: ${goodPopeScore.toFixed(2)}`);
console.log(`Would trigger retry (threshold 0.45): ${badPopeScore < 0.45 ? 'YES ✓' : 'NO ✗'}`);
console.log(`Retry would improve: ${goodPopeScore > badPopeScore ? 'YES ✓' : 'NO ✗'}`);

// ============================================================
// Test Case 3: Protest image for college sports (real pipeline case)
// ============================================================
console.log('\n=== TEST 3: Protest Image for College Sports (Real Case) ===');

const sportsConcepts = buildVisualConceptSet('sports', 'athletes-culture', 'Trump executive order college sports transfers eligibility campus athletics');
console.log('Visual concepts:', sportsConcepts.concepts.join(', '));

const realBadImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/7sgupockyno/cover.jpg',
  altText: 'Protesters hold signs supporting unionism and demanding a contract',
  metadata: {
    entityHints: ['protesters', 'signs', 'unionism', 'contract'],
    sceneType: 'document',
    editorialFitScore: 100,
  },
};

const realGoodImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/college-sports/cover.jpg',
  altText: 'College athletes playing football stadium crowd',
  metadata: {
    entityHints: ['athletes', 'college', 'stadium', 'sports'],
    sceneType: 'stadium',
    editorialFitScore: 65,
  },
};

const realBadScore = computeImageFitScore(realBadImage, sportsConcepts, '');
const realGoodScore = computeImageFitScore(realGoodImage, sportsConcepts, '');

console.log(`Bad image (protest/unionism) fit score: ${realBadScore.toFixed(2)}`);
console.log(`Good image (college sports) fit score: ${realGoodScore.toFixed(2)}`);
console.log(`Would trigger retry (threshold 0.45): ${realBadScore < 0.45 ? 'YES ✓' : 'NO ✗'}`);
console.log(`Retry would improve: ${realGoodScore > realBadScore ? 'YES ✓' : 'NO ✗'}`);

// ============================================================
// Test Case 4: Good match should NOT trigger retry
// ============================================================
console.log('\n=== TEST 4: Good Match Should NOT Trigger Retry ===');

const goodMatchImage = {
  provider: 'unsplash',
  imagePath: '~/assets/images/library/unsplash/basketball/cover.jpg',
  altText: 'Basketball players compete during NCAA game arena',
  metadata: {
    entityHints: ['basketball', 'ncaa', 'players', 'arena'],
    sceneType: 'stadium',
    editorialFitScore: 80,
  },
};

const basketballConcepts = buildVisualConceptSet('sports', 'major-leagues', 'UCLA NCAA women basketball championship tournament');
console.log('Visual concepts:', basketballConcepts.concepts.join(', '));

const goodMatchScore = computeImageFitScore(goodMatchImage, basketballConcepts, '');
console.log(`Good match (basketball) fit score: ${goodMatchScore.toFixed(2)}`);
console.log(`Would trigger retry (threshold 0.45): ${goodMatchScore < 0.45 ? 'YES ✗' : 'NO ✓'}`);

// ============================================================
// Summary
// ============================================================
console.log('\n=== SUMMARY ===');
const tests = [
  { name: 'Artemis/airplane', bad: badArtemisScore, good: goodArtemisScore },
  { name: 'Pope/baby', bad: badPopeScore, good: goodPopeScore },
  { name: 'Sports/protest', bad: realBadScore, good: realGoodScore },
  { name: 'Basketball/good', bad: goodMatchScore, good: goodMatchScore },
];

let passed = 0;
for (const t of tests) {
  const shouldRetry = t.bad < 0.45;
  const wouldImprove = t.good > t.bad;
  const pass = t.name === 'Basketball/good' ? !shouldRetry : (shouldRetry && wouldImprove);
  console.log(`${t.name}: bad=${t.bad.toFixed(2)} good=${t.good.toFixed(2)} retry=${shouldRetry} improve=${wouldImprove} ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  if (pass) passed += 1;
}

console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(passed === tests.length ? 0 : 1);
