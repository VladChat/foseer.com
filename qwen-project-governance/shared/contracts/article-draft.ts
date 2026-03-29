// File: qwen-project-governance/shared/contracts/article-draft.ts
// Purpose: Contract for the writer node output before image selection and publish.

export interface DraftWriterMeta {
  writerId: string | null;
  authorId?: string | null;
  authorName?: string | null;
  authorTitle?: string | null;
  fitScore?: number;
  finalScore?: number;
  reasoning?: string;
}

export interface ArticleDraftContract {
  eventId: string;
  title: string;
  excerpt: string;
  content: string;
  wordCount: number;
  articleType: 'report' | 'analysis' | 'explainer';
  article_type?: 'report' | 'analysis' | 'explainer';
  section: string;
  section_id: string;
  subsection?: string | null;
  topic_id: string;
  tags?: string[];
  sources: string[];
  authorName: string;
  authorTitle?: string | null;
  quality: 'strong' | 'degraded' | 'failed';
  safeForPublishing: boolean;
  qualityIssues: string[];
  metadata?: {
    writerPackage?: DraftWriterMeta;
    classification?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
