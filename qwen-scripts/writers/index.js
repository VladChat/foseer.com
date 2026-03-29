// File: qwen-scripts/writers/index.js
// Purpose: Main export for writer system
// Provides unified interface to all writer system components

export { WRITER_REGISTRY, getWriterById, getAllWriters, getWritersForArticleType, getWritersForBeat, registerWriter } from './writer-registry.js';
export { ARTICLE_TYPE_LAYERS, getArticleTypeLayer, getAllArticleTypes, shouldIncludeForecast } from './article-type-layers.js';
export { CORE_EDITORIAL_PROMPT, getCoreEditorialPrompt } from './core-editorial-prompt.js';
export { FORECAST_LAYER, getForecastLayer, buildForecastInstructions } from './forecast-layer.js';
export { assembleFinalPrompt, getPromptAssemblySummary } from './prompt-assembler.js';
export { classifyStory, selectWriter, getWriterUsageStats, resetWriterUsage } from './writer-selector.js';
