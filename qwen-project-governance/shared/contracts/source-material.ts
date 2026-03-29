// File: qwen-project-governance/shared/contracts/source-material.ts
// Purpose: Standard contract for normalized discovered materials before source-role classification.

export type SourcePageKind =
  | 'article'
  | 'analysis'
  | 'official_release'
  | 'live'
  | 'roundup'
  | 'section'
  | 'topic'
  | 'homepage'
  | 'video'
  | 'audio'
  | 'unknown';

export interface SourceMaterial {
  source_id: string;
  url: string;
  canonical_url: string;
  domain: string;
  canonical_domain: string;
  title: string;
  normalized_title: string;
  snippet: string;
  page_kind: SourcePageKind;
  published_at?: string | null;
  provider?: string | null;
  section_id?: string | null;
  topic_id?: string | null;
  section_candidates?: string[];
  topic_candidates?: string[];
  cluster_id?: string | null;
  event_key?: string | null;
  entities?: string[];
  keywords?: string[];
  region?: string | null;
  angle?: string | null;
  genericity_score?: number;
  article_likelihood?: number;
  source_quality_score?: number;
}
