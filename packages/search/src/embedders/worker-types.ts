/**
 * Shared types for worker thread communication.
 * Used by both WorkerEmbedder (main thread) and embedder-worker (worker thread).
 */

import type { TransformersJsEmbedderConfig, ProgressInfo } from './types.js';

// ============================================================================
// Request Types (Main Thread → Worker)
// ============================================================================

export interface WorkerRequestBase {
  /** Unique request ID for correlating responses */
  id: string;
}

export interface InitializeRequest extends WorkerRequestBase {
  type: 'initialize';
  config?: TransformersJsEmbedderConfig;
}

export interface EmbedRequest extends WorkerRequestBase {
  type: 'embed';
  text: string;
}

export interface EmbedBatchRequest extends WorkerRequestBase {
  type: 'embedBatch';
  texts: string[];
}

export interface EmbedQueryRequest extends WorkerRequestBase {
  type: 'embedQuery';
  query: string;
}

export interface EmbedDocumentRequest extends WorkerRequestBase {
  type: 'embedDocument';
  text: string;
}

export interface EmbedBatchDocumentsRequest extends WorkerRequestBase {
  type: 'embedBatchDocuments';
  texts: string[];
}

export interface IsReadyRequest extends WorkerRequestBase {
  type: 'isReady';
}

export interface DisposeRequest extends WorkerRequestBase {
  type: 'dispose';
}

export type WorkerRequest =
  | InitializeRequest
  | EmbedRequest
  | EmbedBatchRequest
  | EmbedQueryRequest
  | EmbedDocumentRequest
  | EmbedBatchDocumentsRequest
  | IsReadyRequest
  | DisposeRequest;

// ============================================================================
// Response Types (Worker → Main Thread)
// ============================================================================

export interface WorkerResponseBase {
  /** Request ID this response corresponds to */
  id: string;
}

export interface InitializedResponse extends WorkerResponseBase {
  type: 'initialized';
  success: boolean;
  error?: string;
  /** Model dimensions (from embedder) */
  dimensions?: number;
  /** Model ID (from embedder) */
  modelId?: string;
  /** Whether model is multilingual */
  isMultilingual?: boolean;
}

export interface ProgressResponse extends WorkerResponseBase {
  type: 'progress';
  progress: ProgressInfo;
}

export interface EmbeddingResponse extends WorkerResponseBase {
  type: 'embedding';
  result: number[];
}

export interface EmbeddingBatchResponse extends WorkerResponseBase {
  type: 'embeddingBatch';
  result: number[][];
}

export interface ReadyResponse extends WorkerResponseBase {
  type: 'ready';
  isReady: boolean;
}

export interface DisposedResponse extends WorkerResponseBase {
  type: 'disposed';
}

export interface ErrorResponse extends WorkerResponseBase {
  type: 'error';
  error: string;
}

export interface WarningResponse {
  type: 'warning';
  id?: string;
  warning: {
    type: 'batch_size_fallback' | 'batch_failed';
    message: string;
    originalBatchSize?: number;
    newBatchSize?: number;
  };
}

export type WorkerResponse =
  | InitializedResponse
  | ProgressResponse
  | EmbeddingResponse
  | EmbeddingBatchResponse
  | ReadyResponse
  | DisposedResponse
  | ErrorResponse
  | WarningResponse;

// ============================================================================
// Worker State
// ============================================================================

export interface WorkerState {
  initialized: boolean;
  modelId: string | null;
  dimensions: number;
  isMultilingual: boolean;
}
