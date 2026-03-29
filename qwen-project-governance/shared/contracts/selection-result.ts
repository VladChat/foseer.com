// File: qwen-project-governance/shared/contracts/selection-result.ts
// Purpose: Contract for ranked selection decisions emitted from the coverage-aware selection node.

export interface SelectionScore {
  score: number;
  notes: string[];
}

export interface SelectionDecision<TItem = unknown> {
  item: TItem;
  ranking: SelectionScore;
  contextSummary?: {
    undercoveredSections?: string[];
    recentItems?: number;
  };
}
