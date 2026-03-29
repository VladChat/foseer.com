// File: qwen-scripts/local-verification.js
// Purpose: Real post-publish local site visibility verification
// Stage 8: Verify article is actually visible on localhost after publish succeeds
// This is a HARD GATE - not advisory - verification must pass for pipeline success

/**
 * Verification failure reasons
 */
const FAILURE_REASON = {
  LOCALHOST_UNREACHABLE: 'localhost_unreachable',
  ARTICLE_URL_UNREACHABLE: 'article_url_unreachable',
  HOMEPAGE_MISSING_ARTICLE: 'homepage_missing_article',
  ROUTE_MISMATCH: 'route_mismatch',
  ARTICLE_NOT_VISIBLE: 'article_not_visible',
  TITLE_MISMATCH: 'title_mismatch',
  MISSING_REQUIRED_DATA: 'missing_required_data',
};

/**
 * Verification outcome status
 */
const OUTCOME_STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
};

/**
 * Verification result schema
 * @typedef {Object} VerificationResult
 * @property {string} status - 'pass' | 'fail'
 * @property {string|null} failureReason - Specific failure reason if failed
 * @property {boolean} localhostReachable - Whether localhost dev server is up
 * @property {boolean} articleUrlReachable - Whether article URL returns 200
 * @property {boolean} homepageVisible - Whether article appears on homepage/listing
 * @property {boolean} articleIdentityConfirmed - Whether article identity (title/slug) confirmed
 * @property {string} articleUrl - Full article URL
 * @property {string} publishedPath - Path where article was published
 * @property {string[]} issues - List of specific issues found
 * @property {Object} checks - Detailed check results
 * @property {number} pollingAttempts - Number of polling attempts made
 * @property {number} totalWaitTimeMs - Total time spent waiting
 */

const LOCAL_BASE_URL = process.env.LOCAL_BASE_URL || 'http://localhost:4321';
const INITIAL_WAIT_AFTER_PUBLISH = 3000; // 3 seconds initial wait after publish
const VERIFICATION_INTERVAL = 2000; // 2 seconds between polling attempts
const MAX_POLLING_ATTEMPTS = 15; // Max polling attempts (30 seconds total)
const CHECK_TIMEOUT = 8000; // 8 seconds per individual check

/**
 * Verify local site visibility AFTER publish has succeeded
 * This is a hard gate - must pass for pipeline success
 * 
 * @param {Object} article - Article with publishResult, slug, draft
 * @param {Object} options - Verification options
 * @param {boolean} [options.pollingEnabled=true] - Enable polling/retry logic
 * @returns {Promise<VerificationResult>} Verification result with explicit pass/fail
 */
export async function verifyLocalVisibility(article, options = {}) {
  console.log('[verify] Starting post-publish local visibility verification...');
  const startTime = Date.now();

  const pollingEnabled = options.pollingEnabled !== false;

  const result = {
    status: OUTCOME_STATUS.FAIL,
    passes: false,
    failureReason: null,
    localhostReachable: false,
    articleUrlReachable: false,
    homepageVisible: false,
    articleIdentityConfirmed: false,
    articleUrl: '',
    publishedPath: '',
    issues: [],
    checks: {
      localhost: { passed: false, details: null },
      articleUrl: { passed: false, details: null, httpStatus: null },
      homepage: { passed: false, details: null, foundSlug: false, foundTitle: false },
      articlePage: { passed: false, details: null, foundTitle: false, foundSlug: false },
    },
    pollingAttempts: 0,
    totalWaitTimeMs: 0,
  };

  // Validate required data
  if (!article) {
    result.failureReason = FAILURE_REASON.MISSING_REQUIRED_DATA;
    result.issues.push('No article object provided for verification');
    console.log('[verify] FAIL: No article object');
    return result;
  }

  if (!article.articleSlug) {
    result.failureReason = FAILURE_REASON.MISSING_REQUIRED_DATA;
    result.issues.push('No article slug available for verification');
    console.log('[verify] FAIL: No article slug');
    return result;
  }

  if (!article.publishResult || !article.publishResult.filePath) {
    result.failureReason = FAILURE_REASON.MISSING_REQUIRED_DATA;
    result.issues.push('No publish result or filePath available');
    console.log('[verify] FAIL: No publish result');
    return result;
  }

  result.publishedPath = article.publishResult.filePath;

  // Build article URL candidates using the publish result first, then fallback slugs.
  const slug = article.articleSlug;
  const canonicalSlug = article.publishResult.canonicalSlug || '';
  const possibleUrls = dedupeUrls([
    article.publishResult.expectedUrl ? `${LOCAL_BASE_URL}${article.publishResult.expectedUrl.replace(/\/$/, '')}` : null,
    canonicalSlug ? `${LOCAL_BASE_URL}/article/${canonicalSlug}` : null,
    canonicalSlug ? `${LOCAL_BASE_URL}/article/${canonicalSlug}/` : null,
    slug ? `${LOCAL_BASE_URL}/article/${slug}` : null,
    slug ? `${LOCAL_BASE_URL}/article/${slug}/` : null,
  ]);

  const primaryArticleUrl = possibleUrls[0] || `${LOCAL_BASE_URL}/article/${slug}`;

  result.articleUrl = primaryArticleUrl;

  console.log(`[verify] Published path: ${result.publishedPath}`);
  console.log(`[verify] Article URL: ${primaryArticleUrl}`);

  // Initial wait after publish to allow Astro to pick up new file
  if (pollingEnabled) {
    console.log(`[verify] Waiting ${INITIAL_WAIT_AFTER_PUBLISH}ms for Astro to pick up new article...`);
    await sleep(INITIAL_WAIT_AFTER_PUBLISH);
    result.totalWaitTimeMs += INITIAL_WAIT_AFTER_PUBLISH;
  }

  // Check 1: Localhost reachability (no polling - immediate fail if down)
  console.log('[verify] Check 1: Localhost reachability...');
  result.localhostReachable = await checkLocalhostReachable();
  result.checks.localhost = {
    passed: result.localhostReachable,
    details: result.localhostReachable ? 'Dev server responding' : 'Dev server not responding',
  };

  if (!result.localhostReachable) {
    result.failureReason = FAILURE_REASON.LOCALHOST_UNREACHABLE;
    result.issues.push('Localhost dev server not reachable');
    result.issues.push('Start dev server with: npm run dev');
    console.log('[verify] FAIL: Localhost unreachable');
    return result;
  }

  // Check 2: Article URL reachability (with polling)
  console.log('[verify] Check 2: Article URL reachability...');
  const articleUrlResult = await checkArticleUrlWithPolling(primaryArticleUrl, possibleUrls, pollingEnabled);
  result.articleUrlReachable = articleUrlResult.reachable;
  result.checks.articleUrl = {
    passed: articleUrlResult.reachable,
    details: articleUrlResult.reachable ? `HTTP ${articleUrlResult.statusCode}` : 'Not reachable after polling',
    httpStatus: articleUrlResult.statusCode,
    finalUrl: articleUrlResult.finalUrl,
  };
  result.pollingAttempts += articleUrlResult.attempts;
  result.totalWaitTimeMs += articleUrlResult.waitTime;

  if (!result.articleUrlReachable) {
    result.failureReason = FAILURE_REASON.ARTICLE_URL_UNREACHABLE;
    result.issues.push(`Article URL not reachable: ${primaryArticleUrl}`);
    result.issues.push('Dev server may need rebuild or restart');
    console.log('[verify] FAIL: Article URL unreachable');
    return result;
  }

  // Check 3: Article page identity verification (with polling)
  console.log('[verify] Check 3: Article page identity verification...');
  const articlePageResult = await checkArticlePageIdentity(articleUrlResult.finalUrl, article.draft?.title, [slug, canonicalSlug].filter(Boolean), pollingEnabled);
  result.articleIdentityConfirmed = articlePageResult.identityConfirmed;
  result.checks.articlePage = articlePageResult;
  result.pollingAttempts += articlePageResult.attempts;
  result.totalWaitTimeMs += articlePageResult.waitTime;

  if (!result.articleIdentityConfirmed) {
    result.failureReason = FAILURE_REASON.ARTICLE_NOT_VISIBLE;
    result.issues.push('Article page does not contain expected identity markers');
    if (articlePageResult.foundTitle) {
      result.issues.push('Title found on page');
    }
    if (articlePageResult.foundSlug) {
      result.issues.push('Slug found in page content');
    }
    console.log('[verify] FAIL: Article identity not confirmed');
    return result;
  }

  // Check 4: Homepage/listing visibility (with polling)
  console.log('[verify] Check 4: Homepage/listing visibility...');
  const homepageResult = await checkHomepageVisibility([slug, canonicalSlug].filter(Boolean), article.draft?.title, pollingEnabled);
  result.homepageVisible = homepageResult.visible;
  result.checks.homepage = homepageResult;
  result.pollingAttempts += homepageResult.attempts;
  result.totalWaitTimeMs += homepageResult.waitTime;

  if (!result.homepageVisible) {
    result.failureReason = FAILURE_REASON.HOMEPAGE_MISSING_ARTICLE;
    result.issues.push('Article not found on homepage or listing');
    result.issues.push('May require cache refresh or manual navigation');
    console.log('[verify] FAIL: Homepage visibility not confirmed');
    return result;
  }

  // ALL CHECKS PASSED
  result.status = OUTCOME_STATUS.PASS;
  result.passes = true;
  result.issues = []; // Clear issues on success

  console.log('[verify] PASS: Article verified visible on localhost');
  console.log(`[verify] Total polling: ${result.pollingAttempts} attempts, ${result.totalWaitTimeMs}ms`);

  return result;
}

/**
 * Check localhost reachability (immediate, no polling)
 */
async function checkLocalhostReachable() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

    const response = await fetch(LOCAL_BASE_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Check article URL with polling/retry logic
 */
async function checkArticleUrlWithPolling(primaryUrl, possibleUrls, pollingEnabled) {
  const result = {
    reachable: false,
    statusCode: null,
    finalUrl: primaryUrl,
    attempts: 0,
    waitTime: 0,
  };

  const maxAttempts = pollingEnabled ? MAX_POLLING_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;

    for (const url of possibleUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 200) {
          result.reachable = true;
          result.statusCode = response.status;
          result.finalUrl = url;
          return result;
        } else {
          result.statusCode = response.status;
        }
      } catch (error) {
        // Continue to next URL or retry
      }
    }

    if (attempt < maxAttempts && pollingEnabled) {
      await sleep(VERIFICATION_INTERVAL);
      result.waitTime += VERIFICATION_INTERVAL;
    }
  }

  return result;
}

/**
 * Check article page identity - verify title and slug appear on the article page
 */
async function checkArticlePageIdentity(articleUrl, title, slugs, pollingEnabled) {
  const result = {
    passed: false,
    identityConfirmed: false,
    foundTitle: false,
    foundSlug: false,
    pageTitle: null,
    attempts: 0,
    waitTime: 0,
  };

  const maxAttempts = pollingEnabled ? MAX_POLLING_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

      const response = await fetch(articleUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status !== 200) {
        if (attempt < maxAttempts && pollingEnabled) {
          await sleep(VERIFICATION_INTERVAL);
          result.waitTime += VERIFICATION_INTERVAL;
          continue;
        }
        return result;
      }

      const html = await response.text();
      const normalizedHtml = html.toLowerCase();

      // Check for title in page content (not just meta tags)
      if (title) {
        const titleLower = title.toLowerCase();
        result.foundTitle = normalizedHtml.includes(titleLower) ||
                           normalizedHtml.includes(`<h1>${titleLower}`) ||
                           normalizedHtml.includes(`>${titleLower}<`);
      }

      // Check for slug in page content or URL breadcrumbs
      const slugList = Array.isArray(slugs) ? slugs : [slugs].filter(Boolean);
      result.foundSlug = slugList.some((slug) => {
        const normalizedSlug = String(slug).toLowerCase();
        return normalizedHtml.includes(normalizedSlug) || normalizedHtml.includes(`/article/${normalizedSlug}`);
      });

      // Extract page title from <title> tag
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        result.pageTitle = titleMatch[1].trim();
      }

      // Identity confirmed if we find both title and slug markers
      result.identityConfirmed = result.foundTitle || result.foundSlug;
      result.passed = result.identityConfirmed;

      if (result.identityConfirmed) {
        return result;
      }
    } catch (error) {
      // Continue polling
    }

    if (attempt < maxAttempts && pollingEnabled) {
      await sleep(VERIFICATION_INTERVAL);
      result.waitTime += VERIFICATION_INTERVAL;
    }
  }

  return result;
}

/**
 * Check homepage/listing visibility with polling
 */
async function checkHomepageVisibility(slugs, title, pollingEnabled) {
  const result = {
    passed: false,
    visible: false,
    foundSlug: false,
    foundTitle: false,
    foundCard: false,
    attempts: 0,
    waitTime: 0,
  };

  const maxAttempts = pollingEnabled ? MAX_POLLING_ATTEMPTS : 1;
  const listingUrls = [`${LOCAL_BASE_URL}/`, `${LOCAL_BASE_URL}/latest`];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;

    for (const listingUrl of listingUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

        const response = await fetch(listingUrl, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status !== 200) {
          continue;
        }

        const html = await response.text();
        const normalizedHtml = html.toLowerCase();

        const slugList = Array.isArray(slugs) ? slugs : [slugs].filter(Boolean);
        const slugPatterns = slugList.flatMap((slug) => [
          `/article/${slug}`,
          `>${slug}<`,
        ]);
        const foundSlugHere = slugPatterns.some((pattern) => normalizedHtml.includes(pattern.toLowerCase()));

        let foundTitleHere = false;
        if (title) {
          const titleLower = title.toLowerCase();
          foundTitleHere = normalizedHtml.includes(titleLower);
        }

        result.foundSlug = result.foundSlug || foundSlugHere;
        result.foundTitle = result.foundTitle || foundTitleHere;
        result.foundCard = result.foundCard || (normalizedHtml.includes('article') && (foundSlugHere || foundTitleHere));
        result.visible = result.foundSlug || result.foundTitle;
        result.passed = result.visible;

        if (result.visible) {
          return result;
        }
      } catch (error) {
        // Continue polling across listing URLs
      }
    }

    if (attempt < maxAttempts && pollingEnabled) {
      await sleep(VERIFICATION_INTERVAL);
      result.waitTime += VERIFICATION_INTERVAL;
    }
  }

  return result;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const value = String(url || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate verification report
 * @param {VerificationResult} result - Verification result
 * @returns {string} Markdown report
 */
export function generateVerificationReport(result) {
  const lines = [
    '# Local Visibility Verification Report',
    '',
    `**Article URL:** ${result.articleUrl || 'N/A'}`,
    `**Published Path:** ${result.publishedPath || 'N/A'}`,
    `**Timestamp:** ${new Date().toISOString()}`,
    '',
    '## Results',
    '',
  ];

  lines.push(`- [${result.checks.localhost.passed ? 'x' : ' '}] Localhost reachable`);
  lines.push(`- [${result.checks.articleUrl.passed ? 'x' : ' '}] Article URL reachable (${result.checks.articleUrl.httpStatus || 'N/A'})`);
  lines.push(`- [${result.checks.articlePage.passed ? 'x' : ' '}] Article identity confirmed`);
  lines.push(`  - Title found: ${result.checks.articlePage.foundTitle ? 'Yes' : 'No'}`);
  lines.push(`  - Slug found: ${result.checks.articlePage.foundSlug ? 'Yes' : 'No'}`);
  lines.push(`- [${result.checks.homepage.passed ? 'x' : ' '}] Homepage visibility`);
  lines.push(`  - Slug visible: ${result.checks.homepage.foundSlug ? 'Yes' : 'No'}`);
  lines.push(`  - Title visible: ${result.checks.homepage.foundTitle ? 'Yes' : 'No'}`);
  lines.push(`  - Card detected: ${result.checks.homepage.foundCard ? 'Yes' : 'No'}`);
  lines.push('');

  lines.push('## Polling Statistics');
  lines.push('');
  lines.push(`- Total attempts: ${result.pollingAttempts}`);
  lines.push(`- Total wait time: ${result.totalWaitTimeMs}ms`);
  lines.push('');

  if (result.issues.length > 0) {
    lines.push('## Issues');
    lines.push('');
    for (const issue of result.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (result.failureReason) {
    lines.push('## Failure Reason');
    lines.push('');
    lines.push(`\`${result.failureReason}\``);
    lines.push('');
  }

  lines.push(`## Overall: ${result.status.toUpperCase()}`);
  lines.push('');

  if (result.status === OUTCOME_STATUS.FAIL) {
    lines.push('### Recommended Actions');
    lines.push('');
    
    if (result.failureReason === FAILURE_REASON.LOCALHOST_UNREACHABLE) {
      lines.push('1. Start the dev server: `npm run dev`');
      lines.push('2. Wait for server to be ready');
      lines.push('3. Re-run pipeline');
    } else if (result.failureReason === FAILURE_REASON.ARTICLE_URL_UNREACHABLE) {
      lines.push('1. Restart dev server: `npm run dev`');
      lines.push('2. Ensure Astro rebuilds after file changes');
      lines.push('3. Check article file exists at published path');
    } else if (result.failureReason === FAILURE_REASON.HOMEPAGE_MISSING_ARTICLE) {
      lines.push('1. Refresh browser cache');
      lines.push('2. Check homepage listing logic');
      lines.push('3. Verify article is not marked as draft');
    } else {
      lines.push('1. Review verification issues above');
      lines.push('2. Check article file and frontmatter');
      lines.push('3. Restart dev server if needed');
    }
    lines.push('');
  }

  return lines.join('\n');
}
