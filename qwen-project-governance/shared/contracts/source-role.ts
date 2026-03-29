// File: qwen-project-governance/shared/contracts/source-role.ts
// Purpose: Standard contract for assigning editorial roles to normalized source materials.

export type SourceRole = 'core' | 'supporting' | 'background' | 'signal_only' | 'reject';

export interface SourceRoleResult {
  role: SourceRole;
  role_confidence: number;
  role_reason: string[];
  same_event_score: number;
  topic_fit_score: number;
  genericity_score: number;
  article_likelihood: number;
  page_kind: string;
  source_id: string;
  source: unknown;
}
