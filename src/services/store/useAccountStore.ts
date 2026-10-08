/**
 * Legacy compatibility path; canonical implementation is in src/store/useAccountStore.ts.
 *
 * This file previously held a full copy of the account store with an import path
 * (`../services/api/client`) that does not resolve from `src/services/store/`,
 * which broke `tsc --noEmit`. It now re-exports the single canonical store so the
 * path keeps working without a divergent duplicate.
 */
export * from '../../store/useAccountStore';
