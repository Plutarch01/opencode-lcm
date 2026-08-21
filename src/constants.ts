/**
 * Store-level constants used across the SQLite LCM store.
 * These are configuration-like values that control store behavior.
 */

// Summary DAG configuration
export const SUMMARY_LEAF_MESSAGES = 6;
export const SUMMARY_BRANCH_FACTOR = 3;
export const SUMMARY_NODE_CHAR_LIMIT = 260;
export const SUMMARY_INTERNAL_CHAR_LIMIT = 400;

// Store schema
export const STORE_SCHEMA_VERSION = 2;

// Message retrieval limits
export const EXPAND_MESSAGE_LIMIT = 6;
export const ARTIFACT_FTS_CHAR_LIMIT = 16_384;

// Automatic retrieval configuration
export const AUTOMATIC_RETRIEVAL_QUERY_TOKENS = 8;
export const AUTOMATIC_RETRIEVAL_WEIGHTED_TOKENS = 5;
export const DEFERRED_PART_UPDATE_DELAY_MS = 250;
export const TFIDF_MIN_CORPUS_DOCS = 50;
export const AUTOMATIC_RETRIEVAL_RECENT_MESSAGES = 3;
export const AUTOMATIC_RETRIEVAL_QUERY_VARIANTS = 8;
