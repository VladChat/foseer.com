// File: qwen-project-governance/shared/contracts/source-pack.ts
// Purpose: Contract for source-pack node output used by claim-map and publisher stages.

export interface SourcePackSource {
  source_id?: string;
  url: string;
  title: string;
  canonicalDomain?: string;
  canonical_domain?: string;
  page_kind?: string;
  sourceQualityScore?: number;
  isPrimary?: boolean;
  sourceRoleHint?: string;
}

export interface SourcePackMetrics {
  totalSources: number;
  uniqueDomains: number;
  relatedItemsConsidered: number;
  sourceUrlsSeeded: number;
  cleanCollectedCount: number;
  primaryishCount: number;
  averageSourceScore: number;
  strongMatchCount: number;
  sourceConsistencyScore: number;
  coreSourceCount?: number;
  supportingSourceCount?: number;
  backgroundSourceCount?: number;
  signalSourceCount?: number;
  rejectedSourceCount?: number;
  clusterArticleRichCount?: number;
  clusterGenericSignalCount?: number;
}

export interface SourcePackContract {
  eventId: string;
  topic: string;
  articleType: string;
  sources: SourcePackSource[];
  primarySources?: SourcePackSource[];
  supportingSources?: SourcePackSource[];
  backgroundSources?: SourcePackSource[];
  signalSources?: SourcePackSource[];
  excludedSources?: SourcePackSource[];
  uniqueDomains: number;
  passesGate: boolean;
  gateNotes: string[];
  gateDecision: 'PASS' | 'FAIL';
  metrics: SourcePackMetrics;
  assembledAt: string;
}
