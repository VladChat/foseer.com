// File: qwen-scripts/compile-tag-registry.js
// Purpose: Build the canonical controlled-vocabulary tag registry from taxonomy and approved tag definitions.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const TAXONOMY_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/contracts/taxonomy-registry.json');
const TAG_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/contracts/tag-registry.json');

const TOPIC_THEME_MAP = {
  'us-politics': ['congress', 'white-house', 'supreme-court', 'federal-policy', 'election-law'],
  'world-geopolitics': ['diplomacy', 'military-conflict', 'border-security'],
  'law-crime': ['criminal-investigation'],
  'climate-extreme-weather': ['wildfire', 'hurricane', 'flooding', 'heat-wave'],
  'society-social-trends': ['labor-strike', 'education-policy'],
  'economy-markets': ['inflation', 'interest-rates', 'jobs-report', 'stock-market', 'wall-street'],
  'companies-deals': ['earnings', 'merger', 'bankruptcy', 'layoffs'],
  'consumer-money': ['consumer-debt', 'credit-cards'],
  'housing-real-estate': ['mortgage-rates', 'home-prices', 'rent', 'mortgages'],
  'crypto-bitcoin': ['bitcoin'],
  'travel-consumer-issues': ['airport-security', 'government-shutdown', 'travel-delays', 'airline-fees'],
  'ai-big-tech': ['artificial-intelligence', 'semiconductors', 'antitrust'],
  'consumer-tech': ['smartphones', 'wearables'],
  'cybersecurity': ['privacy', 'data-breach', 'ransomware'],
  'mobility-evs': ['electric-vehicles', 'charging-network', 'autonomous-driving'],
  'space-astronomy': ['rocket-launch', 'satellite'],
  'enterprise-platforms': ['cloud-computing', 'software-platforms'],
  'public-health': ['outbreak', 'hospital-system', 'medicare', 'health-insurance'],
  'medical-research': ['medical-study', 'clinical-trial', 'pediatric-care'],
  'pharma-fda': ['drug-approval', 'rare-disease', 'biotech', 'therapy-access'],
  'mental-health': ['depression', 'anxiety'],
  'wellness-fitness': ['nutrition', 'sleep', 'exercise'],
  'major-leagues': ['mlb', 'nba', 'baseball', 'basketball', 'nfl', 'nhl', 'soccer', 'media-rights', 'attendance'],
  'events-tournaments': ['playoffs', 'world-cup', 'olympics'],
  'transfers-business': ['trade-rumors', 'free-agency', 'franchise-value'],
  'athletes-culture': ['athlete-activism', 'fan-culture', 'trans-athlete-policy'],
  'film-tv': ['streaming', 'box-office', 'franchise', 'awards-season'],
  'music-celebrities': ['concert-tour', 'celebrity-scandal'],
  'internet-culture': ['viral-trend', 'meme-culture'],
  'creators-platforms': ['influencer-economy', 'creator-monetization', 'platform-moderation', 'youtube', 'tiktok', 'instagram', 'podcasting', 'social-media'],
};

const TOPIC_THEME_MAP_EXPANSION = {
  'us-politics': ['executive-orders', 'immigration-policy', 'budget-bill', 'voting-rights'],
  'world-geopolitics': ['sanctions', 'ceasefire', 'peace-talks', 'national-security'],
  'law-crime': ['court-ruling', 'sentencing', 'civil-rights', 'police-reform'],
  'climate-extreme-weather': ['climate-policy', 'emissions', 'drought', 'disaster-response'],
  'society-social-trends': ['cost-of-living', 'demographics', 'social-policy'],
  'economy-markets': ['recession-risk', 'treasury-yields', 'central-banks'],
  'companies-deals': ['ipo', 'corporate-governance', 'shareholder-activism'],
  'consumer-money': ['personal-finance', 'savings', 'household-budgets'],
  'housing-real-estate': ['housing-affordability', 'homebuilding', 'zoning-policy'],
  'crypto-bitcoin': ['ethereum', 'stablecoins', 'crypto-regulation', 'digital-assets'],
  'travel-consumer-issues': ['travel-disruption', 'consumer-protection', 'refunds'],
  'ai-big-tech': ['ai-regulation', 'model-safety', 'data-centers'],
  'consumer-tech': ['product-launch', 'app-economy', 'hardware'],
  'cybersecurity': ['cyber-espionage', 'critical-infrastructure', 'incident-response'],
  'mobility-evs': ['battery-supply-chain', 'ev-policy'],
  'space-astronomy': ['lunar-mission', 'commercial-space', 'space-policy'],
  'enterprise-platforms': ['saas', 'developer-tools', 'enterprise-security'],
  'public-health': ['vaccination', 'healthcare-access', 'public-health-emergency'],
  'medical-research': ['peer-reviewed-research', 'genomics'],
  'pharma-fda': ['drug-pricing', 'fda-advisory-committee'],
  'mental-health': ['addiction-recovery', 'youth-mental-health'],
  'wellness-fitness': ['preventive-care', 'longevity'],
  'major-leagues': ['coaching-changes', 'injuries', 'standings'],
  'events-tournaments': ['qualification-rules', 'host-city'],
  'transfers-business': ['salary-cap', 'sponsorship-deals'],
  'athletes-culture': ['player-safety', 'gender-eligibility'],
  'film-tv': ['tv-ratings', 'production-delays', 'adaptation'],
  'music-celebrities': ['music-industry', 'chart-performance', 'artist-rights'],
  'internet-culture': ['online-safety', 'platform-algorithms'],
  'creators-platforms': ['creator-rights', 'ad-revenue', 'subscription-models', 'platform-policy'],
};

const THEME_DEFINITIONS = [
  ['congress', 'Congress', ['Congress', 'House', 'Senate']],
  ['white-house', 'White House', ['White House']],
  ['supreme-court', 'Supreme Court', ['Supreme Court', 'High Court']],
  ['federal-policy', 'Federal Policy', ['federal policy']],
  ['election-law', 'Election Law', ['election law', 'ballot law']],
  ['diplomacy', 'Diplomacy', ['diplomacy', 'diplomatic']],
  ['military-conflict', 'Military Conflict', ['military conflict', 'armed conflict', 'battlefield']],
  ['border-security', 'Border Security', ['border security', 'border enforcement']],
  ['criminal-investigation', 'Criminal Investigation', ['criminal investigation', 'investigation']],
  ['wildfire', 'Wildfire', ['wildfire', 'wildfires']],
  ['hurricane', 'Hurricane', ['hurricane', 'storm surge']],
  ['flooding', 'Flooding', ['flooding', 'flood']],
  ['heat-wave', 'Heat Wave', ['heat wave', 'heatwave']],
  ['labor-strike', 'Labor Strike', ['labor strike', 'worker strike', 'walkout']],
  ['education-policy', 'Education Policy', ['education policy', 'school policy']],
  ['inflation', 'Inflation', ['inflation']],
  ['interest-rates', 'Interest Rates', ['interest rates', 'rate cut', 'rate hike']],
  ['jobs-report', 'Jobs Report', ['jobs report', 'employment report']],
  ['stock-market', 'Stock Market', ['stock market', 'stocks']],
  ['earnings', 'Earnings', ['earnings', 'quarterly results']],
  ['merger', 'Merger', ['merger', 'acquisition', 'takeover']],
  ['bankruptcy', 'Bankruptcy', ['bankruptcy']],
  ['layoffs', 'Layoffs', ['layoffs', 'job cuts']],
  ['consumer-debt', 'Consumer Debt', ['consumer debt', 'household debt']],
  ['credit-cards', 'Credit Cards', ['credit cards', 'credit card']],
  ['mortgage-rates', 'Mortgage Rates', ['mortgage rates', 'home loan rates']],
  ['home-prices', 'Home Prices', ['home prices', 'house prices']],
  ['rent', 'Rent', ['rent', 'rents', 'rental costs']],
  ['bitcoin', 'Bitcoin', ['bitcoin']],
  ['airport-security', 'Airport Security', ['airport security', 'tsa', 'aviation security']],
  ['government-shutdown', 'Government Shutdown', ['government shutdown', 'shutdown']],
  ['travel-delays', 'Travel Delays', ['travel delays', 'flight delays', 'airport delays']],
  ['airline-fees', 'Airline Fees', ['airline fees', 'baggage fees', 'ticket fees']],
  ['artificial-intelligence', 'Artificial Intelligence', ['artificial intelligence', 'generative ai', 'ai']],
  ['semiconductors', 'Semiconductors', ['semiconductors', 'chips', 'chipmaking']],
  ['antitrust', 'Antitrust', ['antitrust', 'competition law']],
  ['privacy', 'Privacy', ['privacy', 'data privacy']],
  ['data-breach', 'Data Breach', ['data breach', 'data leak']],
  ['ransomware', 'Ransomware', ['ransomware']],
  ['smartphones', 'Smartphones', ['smartphones', 'smartphone']],
  ['wearables', 'Wearables', ['wearables', 'smartwatch']],
  ['electric-vehicles', 'Electric Vehicles', ['electric vehicles', 'electric vehicle', 'evs', 'ev']],
  ['charging-network', 'Charging Network', ['charging network', 'charger network']],
  ['autonomous-driving', 'Autonomous Driving', ['autonomous driving', 'self-driving', 'robotaxi']],
  ['rocket-launch', 'Rocket Launch', ['rocket launch', 'launch vehicle']],
  ['satellite', 'Satellite', ['satellite', 'satellites']],
  ['cloud-computing', 'Cloud Computing', ['cloud computing', 'cloud services']],
  ['software-platforms', 'Software Platforms', ['software platforms', 'software platform', 'developer platform']],
  ['outbreak', 'Outbreak', ['outbreak', 'epidemic']],
  ['hospital-system', 'Hospital System', ['hospital system', 'hospital systems']],
  ['medical-study', 'Medical Study', ['medical study', 'medical studies', 'new study']],
  ['clinical-trial', 'Clinical Trial', ['clinical trial', 'clinical trials']],
  ['pediatric-care', 'Pediatric Care', ['pediatric care', 'children', 'child patients']],
  ['drug-approval', 'Drug Approval', ['drug approval', 'fda approval', 'cleared by the fda']],
  ['rare-disease', 'Rare Disease', ['rare disease', 'orphan disease']],
  ['biotech', 'Biotech', ['biotech', 'biotechnology']],
  ['therapy-access', 'Therapy Access', ['therapy access', 'patient access', 'treatment access']],
  ['depression', 'Depression', ['depression']],
  ['anxiety', 'Anxiety', ['anxiety']],
  ['nutrition', 'Nutrition', ['nutrition', 'diet']],
  ['sleep', 'Sleep', ['sleep']],
  ['exercise', 'Exercise', ['exercise', 'workout', 'fitness routine']],
  ['mlb', 'MLB', ['mlb', 'major league baseball']],
  ['nba', 'NBA', ['nba', 'national basketball association']],
  ['nfl', 'NFL', ['nfl', 'national football league']],
  ['nhl', 'NHL', ['nhl', 'national hockey league']],
  ['soccer', 'Soccer', ['soccer', 'football club']],
  ['baseball', 'Baseball', ['baseball', 'major league baseball']],
  ['basketball', 'Basketball', ['basketball', 'pro basketball', 'national basketball association']],
  ['playoffs', 'Playoffs', ['playoffs', 'postseason']],
  ['world-cup', 'World Cup', ['world cup']],
  ['olympics', 'Olympics', ['olympics', 'olympic']],
  ['trade-rumors', 'Trade Rumors', ['trade rumors', 'trade talk']],
  ['free-agency', 'Free Agency', ['free agency', 'free agent']],
  ['media-rights', 'Media Rights', ['media rights', 'broadcast rights', 'tv rights']],
  ['attendance', 'Attendance', ['attendance', 'crowd size']],
  ['franchise-value', 'Franchise Value', ['franchise value', 'team valuation']],
  ['athlete-activism', 'Athlete Activism', ['athlete activism', 'player activism']],
  ['fan-culture', 'Fan Culture', ['fan culture', 'fandom']],
  ['trans-athlete-policy', 'Trans Athlete Policy', ['trans athlete', 'trans athletes', 'transgender athlete', 'transgender athletes', 'girls sports', 'women\'s sports', 'school sports']],
  ['streaming', 'Streaming', ['streaming']],
  ['box-office', 'Box Office', ['box office']],
  ['franchise', 'Franchise', ['franchise', 'franchise film']],
  ['awards-season', 'Awards Season', ['awards season', 'award season']],
  ['concert-tour', 'Concert Tour', ['concert tour', 'world tour']],
  ['celebrity-scandal', 'Celebrity Scandal', ['celebrity scandal', 'celebrity controversy']],
  ['viral-trend', 'Viral Trend', ['viral trend', 'viral trends']],
  ['meme-culture', 'Meme Culture', ['meme culture', 'memes']],
  ['influencer-economy', 'Influencer Economy', ['influencer economy', 'creator economy']],
  ['creator-monetization', 'Creator Monetization', ['creator monetization', 'creator revenue']],
  ['platform-moderation', 'Platform Moderation', ['platform moderation', 'content moderation']],
  ['youtube', 'YouTube', ['youtube']],
  ['tiktok', 'TikTok', ['tiktok', 'tik tok']],
  ['instagram', 'Instagram', ['instagram']],
  ['podcasting', 'Podcasting', ['podcasting', 'podcast']],
  ['wall-street', 'Wall Street', ['wall street', 'market opens', 'market open', 'pre-market', 'premarket']],
  ['mortgages', 'Mortgages', ['mortgages', 'mortgage']],
  ['medicare', 'Medicare', ['medicare']],
  ['health-insurance', 'Health Insurance', ['health insurance', 'insurance coverage', 'coverage loss', 'coverage']],
  ['social-media', 'Social Media', ['social media', 'social platform', 'social platforms']],
];

const THEME_DEFINITIONS_EXPANSION = [
  ['executive-orders', 'Executive Orders', ['executive order', 'executive orders']],
  ['immigration-policy', 'Immigration Policy', ['immigration policy', 'border policy', 'asylum policy']],
  ['budget-bill', 'Budget Bill', ['budget bill', 'spending bill', 'appropriations bill']],
  ['voting-rights', 'Voting Rights', ['voting rights', 'ballot access', 'voter access']],
  ['sanctions', 'Sanctions', ['sanctions', 'economic sanctions']],
  ['ceasefire', 'Ceasefire', ['ceasefire', 'cease-fire']],
  ['peace-talks', 'Peace Talks', ['peace talks', 'negotiations']],
  ['national-security', 'National Security', ['national security', 'security policy']],
  ['court-ruling', 'Court Ruling', ['court ruling', 'court decision', 'judgment']],
  ['sentencing', 'Sentencing', ['sentencing', 'sentence hearing']],
  ['civil-rights', 'Civil Rights', ['civil rights', 'rights lawsuit']],
  ['police-reform', 'Police Reform', ['police reform', 'law enforcement reform']],
  ['climate-policy', 'Climate Policy', ['climate policy', 'environmental policy']],
  ['emissions', 'Emissions', ['emissions', 'carbon emissions', 'greenhouse gas']],
  ['drought', 'Drought', ['drought', 'water shortage']],
  ['disaster-response', 'Disaster Response', ['disaster response', 'emergency response']],
  ['cost-of-living', 'Cost of Living', ['cost of living', 'living costs']],
  ['demographics', 'Demographics', ['demographics', 'population trends']],
  ['social-policy', 'Social Policy', ['social policy', 'social services policy']],
  ['recession-risk', 'Recession Risk', ['recession risk', 'economic slowdown']],
  ['treasury-yields', 'Treasury Yields', ['treasury yields', 'bond yields', '10-year yield']],
  ['central-banks', 'Central Banks', ['central bank', 'central banks', 'monetary policy']],
  ['ipo', 'IPO', ['ipo', 'initial public offering']],
  ['corporate-governance', 'Corporate Governance', ['corporate governance', 'board governance']],
  ['shareholder-activism', 'Shareholder Activism', ['shareholder activism', 'activist investor']],
  ['personal-finance', 'Personal Finance', ['personal finance', 'household finance']],
  ['savings', 'Savings', ['savings', 'saving rate']],
  ['household-budgets', 'Household Budgets', ['household budget', 'family budget']],
  ['housing-affordability', 'Housing Affordability', ['housing affordability', 'affordable housing']],
  ['homebuilding', 'Homebuilding', ['homebuilding', 'new home construction']],
  ['zoning-policy', 'Zoning Policy', ['zoning policy', 'zoning reform']],
  ['ethereum', 'Ethereum', ['ethereum', 'ether']],
  ['stablecoins', 'Stablecoins', ['stablecoin', 'stablecoins']],
  ['crypto-regulation', 'Crypto Regulation', ['crypto regulation', 'digital asset regulation']],
  ['digital-assets', 'Digital Assets', ['digital assets', 'token market']],
  ['travel-disruption', 'Travel Disruption', ['travel disruption', 'travel chaos']],
  ['consumer-protection', 'Consumer Protection', ['consumer protection', 'consumer rights']],
  ['refunds', 'Refunds', ['refunds', 'ticket refunds', 'travel refunds']],
  ['ai-regulation', 'AI Regulation', ['ai regulation', 'artificial intelligence regulation']],
  ['model-safety', 'Model Safety', ['model safety', 'ai safety']],
  ['data-centers', 'Data Centers', ['data center', 'data centers']],
  ['product-launch', 'Product Launch', ['product launch', 'device launch']],
  ['app-economy', 'App Economy', ['app economy', 'app marketplace']],
  ['hardware', 'Hardware', ['hardware', 'consumer hardware']],
  ['cyber-espionage', 'Cyber Espionage', ['cyber espionage', 'state-backed hacking']],
  ['critical-infrastructure', 'Critical Infrastructure', ['critical infrastructure', 'infrastructure cyberattack']],
  ['incident-response', 'Incident Response', ['incident response', 'breach response']],
  ['battery-supply-chain', 'Battery Supply Chain', ['battery supply chain', 'battery materials']],
  ['ev-policy', 'EV Policy', ['ev policy', 'electric vehicle policy']],
  ['lunar-mission', 'Lunar Mission', ['lunar mission', 'moon mission']],
  ['commercial-space', 'Commercial Space', ['commercial space', 'private space company']],
  ['space-policy', 'Space Policy', ['space policy', 'space regulation']],
  ['saas', 'SaaS', ['saas', 'software as a service']],
  ['developer-tools', 'Developer Tools', ['developer tools', 'dev tools']],
  ['enterprise-security', 'Enterprise Security', ['enterprise security', 'corporate security']],
  ['vaccination', 'Vaccination', ['vaccination', 'vaccine uptake']],
  ['healthcare-access', 'Healthcare Access', ['healthcare access', 'care access']],
  ['public-health-emergency', 'Public Health Emergency', ['public health emergency', 'health emergency']],
  ['peer-reviewed-research', 'Peer-Reviewed Research', ['peer-reviewed research', 'peer reviewed study']],
  ['genomics', 'Genomics', ['genomics', 'genetic study']],
  ['drug-pricing', 'Drug Pricing', ['drug pricing', 'medicine pricing']],
  ['fda-advisory-committee', 'FDA Advisory Committee', ['fda advisory committee', 'advisory panel']],
  ['addiction-recovery', 'Addiction Recovery', ['addiction recovery', 'substance use treatment']],
  ['youth-mental-health', 'Youth Mental Health', ['youth mental health', 'teen mental health']],
  ['preventive-care', 'Preventive Care', ['preventive care', 'preventive health']],
  ['longevity', 'Longevity', ['longevity', 'healthy aging']],
  ['coaching-changes', 'Coaching Changes', ['coaching change', 'coach firing', 'new coach']],
  ['injuries', 'Injuries', ['injury report', 'injuries']],
  ['standings', 'Standings', ['standings', 'league table']],
  ['qualification-rules', 'Qualification Rules', ['qualification rules', 'eligibility rules']],
  ['host-city', 'Host City', ['host city', 'host nation']],
  ['salary-cap', 'Salary Cap', ['salary cap', 'cap space']],
  ['sponsorship-deals', 'Sponsorship Deals', ['sponsorship deal', 'sponsorship deals']],
  ['player-safety', 'Player Safety', ['player safety', 'athlete safety']],
  ['gender-eligibility', 'Gender Eligibility', ['gender eligibility', 'eligibility policy']],
  ['tv-ratings', 'TV Ratings', ['tv ratings', 'viewership']],
  ['production-delays', 'Production Delays', ['production delays', 'release delay']],
  ['adaptation', 'Adaptation', ['adaptation', 'book adaptation', 'game adaptation']],
  ['music-industry', 'Music Industry', ['music industry', 'record industry']],
  ['chart-performance', 'Chart Performance', ['chart performance', 'music charts']],
  ['artist-rights', 'Artist Rights', ['artist rights', 'music rights']],
  ['online-safety', 'Online Safety', ['online safety', 'internet safety']],
  ['platform-algorithms', 'Platform Algorithms', ['platform algorithm', 'algorithmic feed']],
  ['creator-rights', 'Creator Rights', ['creator rights', 'creator protections']],
  ['ad-revenue', 'Ad Revenue', ['ad revenue', 'advertising revenue']],
  ['subscription-models', 'Subscription Models', ['subscription model', 'subscriber revenue']],
  ['platform-policy', 'Platform Policy', ['platform policy', 'platform rules']],
];

const SECTION_CATEGORY_THEME_DEFINITIONS = {
  news: ['news-category', 'News Category', ['news category', 'news desk']],
  business: ['business-category', 'Business Category', ['business category', 'business desk']],
  tech: ['tech-category', 'Tech Category', ['tech category', 'technology desk']],
  health: ['health-category', 'Health Category', ['health category', 'health desk']],
  sports: ['sports-category', 'Sports Category', ['sports category', 'sports desk']],
  culture: ['culture-category', 'Culture Category', ['culture category', 'culture desk']],
};

const ENTITY_DEFINITIONS = [
  ['fda', 'FDA', ['fda']],
  ['cdc', 'CDC', ['cdc']],
  ['nih', 'NIH', ['nih']],
  ['white-house-entity', 'White House', ['white house']],
  ['congress-entity', 'Congress', ['congress', 'senate', 'house']],
  ['supreme-court-entity', 'Supreme Court', ['supreme court', 'high court']],
  ['pentagon', 'Pentagon', ['pentagon']],
  ['doj', 'DOJ', ['doj', 'justice department']],
  ['ftc', 'FTC', ['ftc', 'federal trade commission']],
  ['sec', 'SEC', ['sec', 'securities and exchange commission']],
  ['apple', 'Apple', ['apple']],
  ['google', 'Google', ['google']],
  ['meta', 'Meta', ['meta', 'facebook']],
  ['microsoft', 'Microsoft', ['microsoft']],
  ['openai', 'OpenAI', ['openai']],
  ['nvidia', 'Nvidia', ['nvidia']],
  ['tesla', 'Tesla', ['tesla']],
  ['amazon', 'Amazon', ['amazon']],
  ['pfizer', 'Pfizer', ['pfizer']],
  ['moderna', 'Moderna', ['moderna']],
  ['denali-therapeutics', 'Denali Therapeutics', ['denali therapeutics', 'denali']],
  ['mlb-entity', 'MLB', ['mlb', 'major league baseball']],
  ['nba-entity', 'NBA', ['nba', 'national basketball association']],
  ['nfl-entity', 'NFL', ['nfl', 'national football league']],
  ['nhl-entity', 'NHL', ['nhl', 'national hockey league']],
  ['fifa', 'FIFA', ['fifa']],
  ['olympics-entity', 'Olympics', ['olympics', 'olympic']],
  ['disney', 'Disney', ['disney']],
  ['netflix', 'Netflix', ['netflix']],
  ['youtube-entity', 'YouTube', ['youtube']],
  ['tiktok-entity', 'TikTok', ['tiktok', 'tik tok']],
  ['spotify', 'Spotify', ['spotify']],
  ['tsa', 'TSA', ['tsa', 'transportation security administration']],
];

const ENTITY_DEFINITIONS_EXPANSION = [
  ['united-nations', 'United Nations', ['united nations', 'u.n.', 'un']],
  ['european-union-entity', 'European Union', ['european union', 'eu']],
  ['nato', 'NATO', ['nato', 'north atlantic treaty organization']],
  ['state-department', 'U.S. State Department', ['state department', 'u.s. state department']],
  ['treasury-department', 'U.S. Treasury', ['u.s. treasury', 'treasury department']],
  ['federal-reserve', 'Federal Reserve', ['federal reserve', 'the fed']],
  ['imf', 'IMF', ['imf', 'international monetary fund']],
  ['world-bank', 'World Bank', ['world bank']],
  ['who', 'WHO', ['world health organization', 'who']],
  ['hhs', 'HHS', ['hhs', 'health and human services']],
  ['ema', 'EMA', ['ema', 'european medicines agency']],
  ['jpmorgan', 'JPMorgan', ['jpmorgan', 'jpmorgan chase']],
  ['goldman-sachs', 'Goldman Sachs', ['goldman sachs', 'goldman']],
  ['blackrock', 'BlackRock', ['blackrock']],
  ['coinbase', 'Coinbase', ['coinbase']],
  ['binance', 'Binance', ['binance']],
  ['strategy-company', 'Strategy', ['strategy', 'microstrategy']],
  ['fannie-mae', 'Fannie Mae', ['fannie mae']],
  ['freddie-mac', 'Freddie Mac', ['freddie mac']],
  ['visa', 'Visa', ['visa', 'visa inc']],
  ['mastercard', 'Mastercard', ['mastercard', 'master card']],
  ['intel', 'Intel', ['intel']],
  ['amd', 'AMD', ['amd', 'advanced micro devices']],
  ['tsmc', 'TSMC', ['tsmc', 'taiwan semiconductor']],
  ['samsung', 'Samsung', ['samsung']],
  ['oracle', 'Oracle', ['oracle']],
  ['bytedance', 'ByteDance', ['bytedance']],
  ['x-platform', 'X', ['x platform', 'x.com', 'twitter']],
  ['twitch', 'Twitch', ['twitch']],
  ['nasa', 'NASA', ['nasa', 'u.s. space agency']],
  ['ioc', 'International Olympic Committee', ['international olympic committee', 'ioc']],
  ['uefa', 'UEFA', ['uefa']],
  ['premier-league', 'Premier League', ['premier league', 'epl']],
  ['manchester-united', 'Manchester United', ['manchester united', 'man utd']],
  ['real-madrid', 'Real Madrid', ['real madrid']],
  ['barcelona-fc', 'FC Barcelona', ['fc barcelona', 'barcelona fc']],
  ['hamas', 'Hamas', ['hamas']],
  ['idf', 'Israel Defense Forces', ['idf', 'israel defense forces', 'israeli military']],
];

const GEOGRAPHY_DEFINITIONS = [
  ['united-states', 'United States', ['united states', 'u.s.', 'us']],
  ['china', 'China', ['china']],
  ['europe', 'Europe', ['europe', 'european union', 'eu']],
  ['russia', 'Russia', ['russia']],
  ['ukraine', 'Ukraine', ['ukraine']],
  ['middle-east', 'Middle East', ['middle east']],
  ['israel', 'Israel', ['israel']],
  ['gaza', 'Gaza', ['gaza']],
  ['united-kingdom', 'United Kingdom', ['united kingdom', 'uk', 'britain']],
  ['canada', 'Canada', ['canada']],
  ['california', 'California', ['california']],
  ['new-york', 'New York', ['new york']],
  ['washington', 'Washington', ['washington']],
  ['florida', 'Florida', ['florida']],
  ['texas', 'Texas', ['texas']],
];

const GEOGRAPHY_DEFINITIONS_EXPANSION = [
  ['india', 'India', ['india']],
  ['japan', 'Japan', ['japan']],
  ['south-korea', 'South Korea', ['south korea', 'korea']],
  ['taiwan', 'Taiwan', ['taiwan']],
  ['germany', 'Germany', ['germany']],
  ['france', 'France', ['france']],
  ['italy', 'Italy', ['italy']],
  ['spain', 'Spain', ['spain']],
  ['mexico', 'Mexico', ['mexico']],
  ['brazil', 'Brazil', ['brazil']],
  ['australia', 'Australia', ['australia']],
  ['iran', 'Iran', ['iran']],
  ['saudi-arabia', 'Saudi Arabia', ['saudi arabia']],
  ['lebanon', 'Lebanon', ['lebanon']],
  ['syria', 'Syria', ['syria']],
  ['west-bank', 'West Bank', ['west bank']],
  ['palestinian-territories', 'Palestinian Territories', ['palestinian territories', 'occupied territories']],
];

const FORMAT_DEFINITIONS = [
  ['report', 'Report', ['report']],
  ['analysis', 'Analysis', ['analysis']],
  ['explainer', 'Explainer', ['explainer']],
  ['timeline', 'Timeline', ['timeline']],
  ['live-updates', 'Live Updates', ['live updates', 'live coverage']],
];


const TOPIC_ALIAS_ENRICHMENTS = {
  'economy-markets': ['market', 'market opening', 'market opens', 'pre-market', 'premarket', 'wall street'],
  'housing-real-estate': ['mortgage', 'mortgages'],
  'public-health': ['health coverage', 'insurance coverage', 'medicare'],
  'creators-platforms': ['social media'],
  'major-leagues': ['mlb', 'nba', 'major league baseball', 'national basketball association', 'baseball', 'basketball'],
};

const TOPIC_ALIAS_ENRICHMENTS_EXPANSION = {
  'us-politics': ['executive order', 'immigration policy', 'budget bill'],
  'world-geopolitics': ['ceasefire', 'sanctions', 'middle east conflict', 'geopolitics'],
  'law-crime': ['court ruling', 'sentencing', 'civil rights case'],
  'climate-extreme-weather': ['climate policy', 'extreme weather', 'disaster response'],
  'society-social-trends': ['cost of living', 'social policy', 'demographics'],
  'companies-deals': ['ipo', 'corporate governance', 'shareholder activism'],
  'crypto-bitcoin': ['ethereum', 'stablecoins', 'crypto regulation', 'digital assets'],
  'travel-consumer-issues': ['consumer protection', 'travel disruption', 'refunds'],
  'ai-big-tech': ['ai regulation', 'model safety', 'data centers'],
  'cybersecurity': ['cyber espionage', 'critical infrastructure', 'incident response'],
  'space-astronomy': ['nasa', 'lunar mission', 'commercial space'],
  'public-health': ['vaccination', 'healthcare access', 'public health emergency'],
  'pharma-fda': ['drug pricing', 'fda advisory committee'],
  'athletes-culture': ['player safety', 'gender eligibility'],
  'film-tv': ['tv ratings', 'production delays'],
  'music-celebrities': ['music industry', 'chart performance'],
  'internet-culture': ['online safety', 'platform algorithms'],
  'creators-platforms': ['creator rights', 'ad revenue', 'subscription models', 'platform policy'],
};

const ENTITY_TOPIC_HINTS = {
  'ai-big-tech': ['openai', 'google', 'meta', 'microsoft', 'nvidia', 'apple', 'amazon'],
  'consumer-tech': ['apple', 'google', 'meta', 'microsoft', 'youtube-entity', 'tiktok-entity'],
  'cybersecurity': ['microsoft', 'google', 'doj', 'ftc'],
  'mobility-evs': ['tesla'],
  'major-leagues': ['mlb-entity', 'nba-entity', 'nfl-entity', 'nhl-entity'],
  'events-tournaments': ['fifa', 'olympics-entity'],
  'transfers-business': ['mlb-entity', 'nba-entity', 'nfl-entity', 'nhl-entity'],
  'film-tv': ['disney', 'netflix'],
  'music-celebrities': ['spotify'],
  'creators-platforms': ['youtube-entity', 'tiktok-entity', 'instagram', 'spotify'],
};

const ENTITY_TOPIC_HINTS_EXPANSION = {
  'us-politics': ['state-department', 'treasury-department', 'federal-reserve', 'white-house-entity', 'congress-entity', 'doj'],
  'world-geopolitics': ['united-nations', 'european-union-entity', 'nato', 'hamas', 'idf', 'state-department', 'imf', 'world-bank'],
  'law-crime': ['doj', 'supreme-court-entity', 'state-department'],
  'economy-markets': ['federal-reserve', 'treasury-department', 'imf', 'world-bank', 'jpmorgan', 'goldman-sachs', 'blackrock'],
  'companies-deals': ['jpmorgan', 'goldman-sachs', 'blackrock', 'visa', 'mastercard', 'intel', 'amd', 'oracle', 'samsung'],
  'consumer-money': ['visa', 'mastercard', 'jpmorgan', 'federal-reserve'],
  'housing-real-estate': ['fannie-mae', 'freddie-mac', 'federal-reserve'],
  'crypto-bitcoin': ['coinbase', 'binance', 'strategy-company', 'sec', 'treasury-department'],
  'travel-consumer-issues': ['tsa', 'state-department'],
  'ai-big-tech': ['intel', 'amd', 'tsmc', 'oracle'],
  'consumer-tech': ['samsung', 'bytedance', 'x-platform'],
  'cybersecurity': ['state-department'],
  'space-astronomy': ['nasa'],
  'enterprise-platforms': ['oracle', 'amazon', 'microsoft', 'google'],
  'public-health': ['who', 'hhs'],
  'medical-research': ['who', 'ema', 'nih'],
  'pharma-fda': ['ema'],
  'major-leagues': ['premier-league', 'manchester-united', 'real-madrid', 'barcelona-fc'],
  'events-tournaments': ['ioc', 'uefa'],
  'transfers-business': ['premier-league', 'uefa'],
  'athletes-culture': ['ioc', 'premier-league'],
  'internet-culture': ['x-platform', 'bytedance', 'twitch'],
  'creators-platforms': ['x-platform', 'bytedance', 'twitch'],
};

function mergeTopicTagMap(base = {}, expansion = {}) {
  const merged = {};
  for (const layer of [base, expansion]) {
    for (const [topicId, values] of Object.entries(layer || {})) {
      if (!merged[topicId]) merged[topicId] = [];
      const target = new Set(merged[topicId]);
      for (const value of Array.isArray(values) ? values : []) {
        const normalized = String(value || '').trim();
        if (!normalized || target.has(normalized)) continue;
        target.add(normalized);
      }
      merged[topicId] = Array.from(target);
    }
  }
  return merged;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildTag(tagId, label, type, aliases = [], sectionIds = [], topicIds = [], extra = {}) {
  return {
    tag_id: tagId,
    slug: slugify(tagId || label),
    label,
    type,
    section_ids: Array.from(new Set(sectionIds.filter(Boolean))),
    topic_ids: Array.from(new Set(topicIds.filter(Boolean))),
    aliases: Array.from(new Set([label, ...(aliases || [])].filter(Boolean))),
    indexable: extra.indexable !== false,
    priority: extra.priority || (type === 'topic' ? 100 : type === 'theme' ? 80 : type === 'entity' ? 60 : 40),
    min_posts_to_index: extra.min_posts_to_index || (type === 'topic' ? 1 : type === 'theme' ? 3 : type === 'entity' ? 4 : 999),
    related_tags: Array.from(new Set(extra.related_tags || [])),
  };
}

export function buildTagRegistry() {
  const taxonomy = readJson(TAXONOMY_REGISTRY_PATH);
  const topicThemeMap = mergeTopicTagMap(TOPIC_THEME_MAP, TOPIC_THEME_MAP_EXPANSION);
  const topicAliasEnrichments = mergeTopicTagMap(TOPIC_ALIAS_ENRICHMENTS, TOPIC_ALIAS_ENRICHMENTS_EXPANSION);
  const entityTopicHints = mergeTopicTagMap(ENTITY_TOPIC_HINTS, ENTITY_TOPIC_HINTS_EXPANSION);
  const tags = [];
  const topicTagByTopicId = {};
  const themeTagSlugsByTopicId = {};
  const entityTagSlugsByTopicId = {};

  for (const topic of taxonomy.topics || []) {
    const tag = buildTag(topic.id, topic.label, 'topic', [topic.slug, ...(topic.aliases || []), ...(topicAliasEnrichments[topic.id] || [])], [topic.section_id], [topic.id], { priority: 100, min_posts_to_index: 1 });
    tags.push(tag);
    topicTagByTopicId[topic.id] = tag.slug;
  }

  const themeTagsBySlug = new Map();
  for (const [tagId, label, aliases] of [...THEME_DEFINITIONS, ...THEME_DEFINITIONS_EXPANSION]) {
    const topicIds = Object.entries(topicThemeMap).filter(([, values]) => values.includes(tagId)).map(([topicId]) => topicId);
    const sectionIds = Array.from(new Set(topicIds.map((topicId) => taxonomy.sectionByTopic?.[topicId]).filter(Boolean)));
    const tag = buildTag(tagId, label, 'theme', aliases, sectionIds, topicIds, { min_posts_to_index: 3 });
    tags.push(tag);
    themeTagsBySlug.set(tag.slug, tag);
    for (const topicId of topicIds) {
      if (!themeTagSlugsByTopicId[topicId]) themeTagSlugsByTopicId[topicId] = [];
      themeTagSlugsByTopicId[topicId].push(tag.slug);
    }
  }

  for (const section of taxonomy.sections || []) {
    const definition = SECTION_CATEGORY_THEME_DEFINITIONS[section.id];
    if (!definition) continue;
    const [tagId, label, aliases] = definition;
    const topicIds = (taxonomy.topics || [])
      .filter((topic) => topic.section_id === section.id)
      .map((topic) => topic.id);
    const sectionIds = [section.id];
    const tag = buildTag(tagId, label, 'theme', aliases, sectionIds, topicIds, {
      indexable: false,
      min_posts_to_index: 999,
      priority: 20,
    });
    tags.push(tag);
    themeTagsBySlug.set(tag.slug, tag);
    for (const topicId of topicIds) {
      if (!themeTagSlugsByTopicId[topicId]) themeTagSlugsByTopicId[topicId] = [];
      themeTagSlugsByTopicId[topicId].push(tag.slug);
    }
  }

  for (const [tagId, label, aliases] of [...ENTITY_DEFINITIONS, ...ENTITY_DEFINITIONS_EXPANSION]) {
    const topicIds = Object.entries(entityTopicHints).filter(([, values]) => values.includes(tagId)).map(([topicId]) => topicId);
    const sectionIds = Array.from(new Set(topicIds.map((topicId) => taxonomy.sectionByTopic?.[topicId]).filter(Boolean)));
    const tag = buildTag(tagId, label, 'entity', aliases, sectionIds, topicIds, { indexable: false, min_posts_to_index: 4 });
    tags.push(tag);
    for (const topicId of topicIds) {
      if (!entityTagSlugsByTopicId[topicId]) entityTagSlugsByTopicId[topicId] = [];
      entityTagSlugsByTopicId[topicId].push(tag.slug);
    }
  }

  const geographyTagSlugs = [];
  for (const [tagId, label, aliases] of [...GEOGRAPHY_DEFINITIONS, ...GEOGRAPHY_DEFINITIONS_EXPANSION]) {
    const tag = buildTag(tagId, label, 'geography', aliases, [], [], { indexable: false, min_posts_to_index: 999 });
    tags.push(tag);
    geographyTagSlugs.push(tag.slug);
  }

  const formatTagSlugs = [];
  for (const [tagId, label, aliases] of FORMAT_DEFINITIONS) {
    const tag = buildTag(tagId, label, 'format', aliases, [], [], { indexable: false, min_posts_to_index: 999 });
    tags.push(tag);
    formatTagSlugs.push(tag.slug);
  }

  const bySlug = Object.fromEntries(tags.map((tag) => [tag.slug, tag]));
  const byType = tags.reduce((acc, tag) => {
    if (!acc[tag.type]) acc[tag.type] = [];
    acc[tag.type].push(tag);
    return acc;
  }, { topic: [], theme: [], entity: [], geography: [], format: [] });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source_taxonomy_registry: 'qwen-data/contracts/taxonomy-registry.json',
    tags,
    topicTagByTopicId,
    themeTagSlugsByTopicId,
    entityTagSlugsByTopicId,
    geographyTagSlugs,
    formatTagSlugs,
    bySlug,
    byType,
  };
}

export function writeTagRegistry() {
  const registry = buildTagRegistry();
  fs.mkdirSync(path.dirname(TAG_REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(TAG_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  console.log(`[tag-registry] Wrote ${registry.tags.length} canonical tags to ${TAG_REGISTRY_PATH}`);
  return registry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeTagRegistry();
}
