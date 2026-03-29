// File: qwen-project-governance/shared/contracts/event-cluster.ts
// Purpose: Contract for clustered events emitted between discovery and brief normalization.

import type { DiscoveryCandidate } from './discovery-candidate.js';

export interface EventCluster {
  clusterId: string;
  eventKey: string;
  section_id: string | null;
  topic_id: string | null;
  region: string;
  angle: string;
  action?: string;
  place?: string;
  entities: string[];
  keywords: string[];
  representative: DiscoveryCandidate | null;
  candidates: DiscoveryCandidate[];
  candidateCount: number;
  sourceUrls: string[];
  trustedSourceCount?: number;
  genericPageCount?: number;
  articleRichCount?: number;
  latestSeenAt: string;
  earliestSeenAt: string;
  clusterScore: number;
  canonicalTitle: string;
}
