export type ID = string;

export type ISODateString = string;

export interface Timestamps {
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Discriminated result type used across services for explicit error handling. */
export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface AppError {
  code: string;
  message: string;
  /** Optional developer-facing detail (never shown to end users raw). */
  detail?: string;
  /** Whether the operation can be retried safely. */
  retryable?: boolean;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function makeError(
  code: string,
  message: string,
  extra?: Partial<AppError>,
): AppError {
  return { code, message, ...extra };
}

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface Range {
  min: number;
  max: number;
}

export type Nullable<T> = T | null;
export type Maybe<T> = T | undefined;
