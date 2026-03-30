/**
 * Store-level constants used across the SQLite LCM store.
 * These are configuration-like values that control store behavior.
 */

// Summary DAG configuration
export const SUMMARY_LEAF_MESSAGES = 6;
export const SUMMARY_BRANCH_FACTOR = 3;
export const SUMMARY_NODE_CHAR_LIMIT = 260;

// Store schema
export const STORE_SCHEMA_VERSION = 1;

// Message retrieval limits
export const EXPAND_MESSAGE_LIMIT = 6;

// Automatic retrieval configuration
export const AUTOMATIC_RETRIEVAL_QUERY_TOKENS = 8;
export const AUTOMATIC_RETRIEVAL_RECENT_MESSAGES = 3;
export const AUTOMATIC_RETRIEVAL_QUERY_VARIANTS = 8;
