// File: qwen-project-governance/shared/contracts/discovery-candidate.ts
// Purpose: Contract for normalized discovery-node output passed to clustering/selection.

export interface DiscoveryCandidate {
  id: string;
  title: string;
  summary: string;
  sourceUrls: string[];
  when?: string;
  discoveredAt?: string;
  provider?: string;
  freshness?: number;
  urgency?: number;
  discoveryScore?: number;
  trustedSource?: boolean;
  discoveryLane?: string;
  sectionCandidates?: string[];
  topicCandidates?: string[];
  detectedSectionId?: string | null;
  detectedTopicId?: string | null;
  entities?: string[];
  region?: string;
  angle?: string;
  genericPage?: boolean;
  page_kind?: string;
  genericity_score?: number;
  article_likelihood?: number;
  normalizedTitle?: string;
  canonicalUrl?: string;
  eventKey?: string;
}
