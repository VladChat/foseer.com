// File: qwen-project-governance/shared/contracts/publish-manifest.ts
// Purpose: Contract for the final publisher manifest emitted after successful validation/publish.

export interface PublishManifestContract {
  version: number;
  generated_at: string;
  event_id: string | null;
  cluster_id?: string | null;
  article_type: 'report' | 'analysis' | 'explainer';
  title: string;
  slug: string;
  canonical_slug?: string | null;
  expected_url: string;
  file_path?: string | null;
  published_at?: string | null;
  section_id: string;
  section_label: string;
  topic_id: string;
  topic_label: string;
  subsection?: string | null;
  writer?: {
    writer_id?: string | null;
    author_id?: string | null;
    author_name?: string | null;
    author_title?: string | null;
  };
  image?: {
    provider?: string | null;
    image_path?: string | null;
    source_url?: string | null;
    asset_key?: string | null;
    alt_text?: string | null;
  };
  source_pack?: {
    passes_gate: boolean;
    unique_domains?: number;
    total_sources?: number;
  };
}
