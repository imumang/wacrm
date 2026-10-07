/**
 * Objective 08 — the deterministic test analyzer.
 *
 * A provider-free stand-in for a real vision model. It is a normal
 * `ImageAnalyzer`, so the tool cannot tell the difference, which is what
 * makes it useful for the automated suite and for local development
 * without any model credential.
 *
 * It records only a redacted summary of each request — image ordinals,
 * source message ids and byte lengths. Image bytes are never retained, so a
 * failing assertion cannot print customer photographs into the test output.
 */

import type {
  ImageAnalysisRequest,
  ImageAnalyzer,
  ImageSourceRef,
} from './analyzer';

export interface FakeAnalyzerCall {
  image_count: number;
  images: Array<{
    source: ImageSourceRef;
    mime_type: string;
    byte_length: number;
  }>;
  context_present: boolean;
  supplied_context: ImageAnalysisRequest['context'];
}

export interface FakeImageAnalyzer extends ImageAnalyzer {
  readonly calls: FakeAnalyzerCall[];
}

export interface FakeImageAnalyzerOptions {
  /** Defaults to `fake_image_analyzer`. Never carries provider detail. */
  id?: string;
  respond: (request: ImageAnalysisRequest) => unknown | Promise<unknown>;
}

/** Honour an already-parsed result shape; the payload still gets validated. */
export function createStubImageAnalyzer(
  result: unknown,
  id = 'fake_image_analyzer'
): FakeImageAnalyzer {
  return createFakeImageAnalyzer({ id, respond: () => result });
}

export function createFakeImageAnalyzer(
  options: FakeImageAnalyzerOptions
): FakeImageAnalyzer {
  const calls: FakeAnalyzerCall[] = [];
  return {
    id: options.id ?? 'fake_image_analyzer',
    calls,
    async analyze(request) {
      calls.push({
        image_count: request.images.length,
        images: request.images.map((image) => ({
          source: image.source,
          mime_type: image.mime_type,
          byte_length: image.byte_length,
        })),
        context_present: request.context !== null,
        supplied_context: request.context,
      });
      return options.respond(request);
    },
  };
}
