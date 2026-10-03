/**
 * Legacy compatibility path. The canonical store lives in src/store/useAppStore.ts.
 * Keep this re-export so older imports do not compile against a stale duplicate.
 */
export * from '../../store/useAppStore';
