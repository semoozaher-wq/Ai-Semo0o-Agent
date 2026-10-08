/**
 * Legacy compatibility path; canonical implementation is in
 * src/components/composite/AccountSecurityCard.tsx.
 *
 * This top-level file was an exact duplicate of the composite component whose
 * relative imports (`../../theme`, `../ui/*`, ...) do not resolve from
 * `src/components/`, which broke `tsc --noEmit`. It now re-exports the canonical
 * component so the path keeps working without a divergent duplicate.
 */
export * from './composite/AccountSecurityCard';
