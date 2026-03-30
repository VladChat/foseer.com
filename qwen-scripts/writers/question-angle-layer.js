// File: qwen-scripts/writers/question-angle-layer.js
// Purpose: Optional question-led prompt layer for answer-style articles without changing the core article pipeline.

export function buildQuestionAngleLayer(questionIntent) {
  if (!questionIntent?.question) {
    return '';
  }

  const question = String(questionIntent.question || '').trim();
  const uncertainty = String(questionIntent.uncertainty || '').trim() || 'what remains unresolved';
  const stakes = String(questionIntent.stakes || '').trim() || 'real-world consequences for readers or affected groups';
  const timeHorizon = String(questionIntent.time_horizon || questionIntent.timeHorizon || '').trim() || 'the near term';
  const questionType = String(questionIntent.question_type || questionIntent.questionType || '').trim() || 'answer-seeking';

  return `QUESTION MODE:
- This article must directly answer the reader question: ${question}
- Treat the question as the article spine, but do not turn the piece into a FAQ or interview transcript
- Lead with the strongest evidence-based answer available right now
- Make clear what is known, what remains unresolved, and what evidence points in each direction
- Keep uncertainty explicit; do not pretend certainty where the evidence is incomplete
- Keep the answer tied to the source pack rather than generic background knowledge

QUESTION-SPECIFIC DISCIPLINE:
- Question type: ${questionType}
- Core uncertainty: ${uncertainty}
- Stakes: ${stakes}
- Time horizon: ${timeHorizon}
- The headline may be declarative or explanatory, but the body must satisfy the question quickly
- Prefer section headings that help answer the question in sequence: what is known, what points toward an outcome, what could change next
- Do not add broad side-topics that do not help answer the question`;
}
