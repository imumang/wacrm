import { describe, expect, it } from 'vitest';

import { ToolError } from '@/lib/ai/tools/contract';

import {
  IMAGE_ANALYSIS_LIMITS,
  normalizeImageMimeType,
  sniffImageMimeType,
} from './limits';
import {
  createSupabaseStorageMediaLoader,
  resolveAnalysisImages,
  resolveMediaObjectPath,
  type AnalysisMediaCandidate,
  type AnalysisMediaClient,
  type AnalysisMediaLoader,
} from './media';

// A real account id, because the storage convention is `account-<uuid>/`
// (migrations 020/023) and the boundary matches that segment exactly.
const ACCOUNT = '3f1b2c40-1111-4222-8333-444455556666';
const FOLDER = `account-${ACCOUNT}`;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
]);

function mediaUrl(path: string): string {
  return `https://project.supabase.co/storage/v1/object/public/chat-media/${path}`;
}

function candidate(
  overrides: Partial<AnalysisMediaCandidate> = {}
): AnalysisMediaCandidate {
  return {
    message_id: 'message-1',
    created_at: '2026-10-01T09:00:00.000Z',
    sender_type: 'customer',
    content_type: 'image',
    media_url: mediaUrl(`${FOLDER}/inbound/photo-1.jpg`),
    media_type: 'image/jpeg',
    ...overrides,
  };
}

/** Serves fixed bytes per object path and records what was requested. */
function fakeStorage(
  objects: Record<string, { bytes: Uint8Array; type: string | null }>
): {
  client: AnalysisMediaClient;
  requests: string[];
} {
  const requests: string[] = [];
  const client: AnalysisMediaClient = {
    storage: {
      from: () => ({
        download: async (path: string) => {
          requests.push(path);
          const object = objects[path];
          if (!object) return { data: null, error: { message: 'not found' } };
          return {
            data: new Blob([object.bytes as BlobPart], {
              type: object.type ?? '',
            }),
            error: null,
          };
        },
      }),
    },
  };
  return { client, requests };
}

/** The real loader wired to an in-memory storage double. */
function loader(
  objects: Record<string, { bytes: Uint8Array; type: string | null }>
): {
  loader: AnalysisMediaLoader;
  client: AnalysisMediaClient;
  requests: string[];
} {
  const storage = fakeStorage(objects);
  return {
    loader: createSupabaseStorageMediaLoader(),
    client: storage.client,
    requests: storage.requests,
  };
}

function toolErrorFrom(promise: Promise<unknown>): Promise<ToolError> {
  return promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: unknown) => error as ToolError
  );
}

describe('image MIME helpers', () => {
  it('normalises only supported image types', () => {
    expect(normalizeImageMimeType('IMAGE/JPEG; charset=binary')).toBe(
      'image/jpeg'
    );
    expect(normalizeImageMimeType('image/png')).toBe('image/png');
    expect(normalizeImageMimeType('image/webp')).toBe('image/webp');
    expect(normalizeImageMimeType('image/gif')).toBe('image/gif');
    expect(normalizeImageMimeType('application/pdf')).toBeNull();
    expect(normalizeImageMimeType('video/mp4')).toBeNull();
    expect(normalizeImageMimeType('image/heic')).toBeNull();
    expect(normalizeImageMimeType(null)).toBeNull();
  });

  it('identifies image content from its leading bytes', () => {
    expect(sniffImageMimeType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMimeType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageMimeType(GIF_BYTES)).toBe('image/gif');
    expect(
      sniffImageMimeType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ])
      )
    ).toBe('image/webp');
    expect(
      sniffImageMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    ).toBeNull();
    expect(sniffImageMimeType(new Uint8Array([0xff]))).toBeNull();
  });
});

describe('resolveMediaObjectPath', () => {
  it('derives the account-scoped object path from a stored reference', () => {
    expect(
      resolveMediaObjectPath(
        mediaUrl(`${FOLDER}/inbound/123-image-1.jpg`),
        ACCOUNT
      )
    ).toEqual({ ok: true, object_path: `${FOLDER}/inbound/123-image-1.jpg` });
  });

  it('refuses a path in another account folder', () => {
    expect(
      resolveMediaObjectPath(
        mediaUrl('account-99999999-9999-4999-8999-888888888888/inbound/x.jpg'),
        ACCOUNT
      )
    ).toEqual({ ok: false, reason: 'foreign_account' });
  });

  it('refuses traversal, absolute, and non-https references', () => {
    expect(
      resolveMediaObjectPath(
        mediaUrl(`${FOLDER}/inbound/../../secret.jpg`),
        ACCOUNT
      )
    ).toEqual({ ok: false, reason: 'invalid_reference' });
    expect(resolveMediaObjectPath('/etc/passwd', ACCOUNT)).toEqual({
      ok: false,
      reason: 'not_durable_media',
    });
    expect(resolveMediaObjectPath('C:\\secrets\\x.jpg', ACCOUNT)).toEqual({
      ok: false,
      reason: 'invalid_reference',
    });
    expect(
      resolveMediaObjectPath(
        `http://project.supabase.co/storage/v1/object/public/chat-media/${FOLDER}/inbound/x.jpg`,
        ACCOUNT
      )
    ).toEqual({ ok: false, reason: 'invalid_reference' });
  });

  it('refuses a signed or credential-bearing reference', () => {
    expect(
      resolveMediaObjectPath(
        `${mediaUrl(`${FOLDER}/inbound/x.jpg`)}?token=secret`,
        ACCOUNT
      )
    ).toEqual({ ok: false, reason: 'invalid_reference' });
    expect(
      resolveMediaObjectPath(
        `https://user:pass@project.supabase.co/storage/v1/object/public/chat-media/${FOLDER}/inbound/x.jpg`,
        ACCOUNT
      )
    ).toEqual({ ok: false, reason: 'invalid_reference' });
  });

  it('refuses the legacy Meta proxy pointer, which is not durable media', () => {
    expect(
      resolveMediaObjectPath('/api/whatsapp/media/1234567890', ACCOUNT)
    ).toEqual({ ok: false, reason: 'not_durable_media' });
  });

  it('refuses a missing or empty reference', () => {
    expect(resolveMediaObjectPath(null, ACCOUNT)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(resolveMediaObjectPath('   ', ACCOUNT)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});

describe('resolveAnalysisImages', () => {
  const objectPath = `${FOLDER}/inbound/photo-1.jpg`;

  it('retrieves a single valid image with source traceability', async () => {
    const {
      loader: mediaLoader,
      client,
      requests,
    } = loader({
      [objectPath]: { bytes: JPEG_BYTES, type: 'image/jpeg' },
    });

    const result = await resolveAnalysisImages({
      client,
      account_id: ACCOUNT,
      candidates: [candidate()],
      loader: mediaLoader,
    });

    expect(requests).toEqual([objectPath]);
    expect(result.duplicates).toEqual([]);
    expect(result.images).toHaveLength(1);
    const image = result.images[0]!;
    expect(image.source).toEqual({
      ordinal: 1,
      source_message_id: 'message-1',
      source_media_id: objectPath,
    });
    expect(image.mime_type).toBe('image/jpeg');
    expect(image.direction).toBe('inbound');
  });

  it('retrieves several images in the order given', async () => {
    const second = `${FOLDER}/inbound/photo-2.png`;
    const { loader: mediaLoader, client } = loader({
      [objectPath]: { bytes: JPEG_BYTES, type: 'image/jpeg' },
      [second]: { bytes: PNG_BYTES, type: 'image/png' },
    });

    const result = await resolveAnalysisImages({
      client,
      account_id: ACCOUNT,
      candidates: [
        candidate({ message_id: 'message-1' }),
        candidate({
          message_id: 'message-2',
          media_url: mediaUrl(second),
          media_type: 'image/png',
        }),
      ],
      loader: mediaLoader,
    });

    expect(result.images.map((image) => image.source.ordinal)).toEqual([1, 2]);
    expect(result.images.map((image) => image.mime_type)).toEqual([
      'image/jpeg',
      'image/png',
    ]);
  });

  it('collapses two references to the same stored object', async () => {
    const {
      loader: mediaLoader,
      client,
      requests,
    } = loader({
      [objectPath]: { bytes: JPEG_BYTES, type: 'image/jpeg' },
    });

    const result = await resolveAnalysisImages({
      client,
      account_id: ACCOUNT,
      candidates: [
        candidate({ message_id: 'message-1' }),
        candidate({ message_id: 'message-2' }),
      ],
      loader: mediaLoader,
    });

    expect(requests).toEqual([objectPath]);
    expect(result.images).toHaveLength(1);
    expect(result.duplicates).toEqual([
      {
        message_id: 'message-2',
        duplicate_of_message_id: 'message-1',
        reason: 'identical_media_object',
      },
    ]);
  });

  it('denies media in another account folder', async () => {
    const { client } = loader({});
    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [
          candidate({
            media_url: mediaUrl(
              'account-99999999-9999-4999-8999-888888888888/inbound/x.jpg'
            ),
          }),
        ],
        loader: {
          id: 'noop',
          read: async () => ({ bytes: JPEG_BYTES, declared_mime_type: null }),
        },
      })
    );

    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('Media is not accessible for this account');
    expect(error.message).not.toContain('99999999');
    expect(error.message).not.toContain('inbound');
  });

  it('rejects an unsupported declared MIME type', async () => {
    const { loader: mediaLoader, client } = loader({
      [objectPath]: { bytes: JPEG_BYTES, type: 'image/jpeg' },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate({ media_type: 'application/pdf' })],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe('Media type is not a supported image type');
  });

  it('rejects content whose bytes are not a supported image', async () => {
    const { loader: mediaLoader, client } = loader({
      [objectPath]: {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
        type: 'application/pdf',
      },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate({ media_type: 'application/pdf' })],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('invalid_input');
  });

  it('rejects a declared type that disagrees with the actual bytes', async () => {
    const { loader: mediaLoader, client } = loader({
      [objectPath]: { bytes: PNG_BYTES, type: 'image/png' },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        // The message row claims JPEG; the object is a PNG.
        candidates: [candidate({ media_type: 'image/jpeg' })],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe(
      'Media content does not match its declared image type'
    );
  });

  it('reports media that is missing from storage without leaking the path', async () => {
    const { loader: mediaLoader, client } = loader({});

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate()],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Stored media is not readable');
    expect(error.message).not.toContain(objectPath);
    expect(error.message).not.toContain('supabase');
  });

  it('rejects an image over the per-image byte limit', async () => {
    const oversized = new Uint8Array(
      IMAGE_ANALYSIS_LIMITS.max_bytes_per_image + 1
    );
    oversized.set(JPEG_BYTES, 0);
    const { loader: mediaLoader, client } = loader({
      [objectPath]: { bytes: oversized, type: 'image/jpeg' },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate()],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('byte analysis limit');
  });

  it('rejects a set over the total byte limit', async () => {
    const half = IMAGE_ANALYSIS_LIMITS.max_bytes_per_image;
    const objects: Record<string, { bytes: Uint8Array; type: string | null }> =
      {};
    const candidates: AnalysisMediaCandidate[] = [];
    for (let index = 0; index < 4; index += 1) {
      const bytes = new Uint8Array(half);
      bytes.set(JPEG_BYTES, 0);
      const path = `${FOLDER}/inbound/photo-${index}.jpg`;
      objects[path] = { bytes, type: 'image/jpeg' };
      candidates.push(
        candidate({ message_id: `message-${index}`, media_url: mediaUrl(path) })
      );
    }
    const { loader: mediaLoader, client } = loader(objects);

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates,
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('total analysis limit');
  });

  it('rejects more images than the per-call limit', async () => {
    const candidates = Array.from(
      { length: IMAGE_ANALYSIS_LIMITS.max_images + 1 },
      (_unused, index) =>
        candidate({
          message_id: `message-${index}`,
          media_url: mediaUrl(`${FOLDER}/inbound/photo-${index}.jpg`),
        })
    );

    const { client } = loader({});
    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates,
        loader: {
          id: 'noop',
          read: async () => ({ bytes: JPEG_BYTES, declared_mime_type: null }),
        },
      })
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('At most');
  });

  it('rejects empty media', async () => {
    const { loader: mediaLoader, client } = loader({
      [objectPath]: { bytes: new Uint8Array(0), type: 'image/jpeg' },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate()],
        loader: mediaLoader,
      })
    );

    expect(error.code).toBe('unavailable');
    expect(error.message).toBe('Stored media is empty');
  });

  it('stops before reading further images once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const {
      loader: mediaLoader,
      client,
      requests,
    } = loader({
      [objectPath]: { bytes: JPEG_BYTES, type: 'image/jpeg' },
    });

    const error = await toolErrorFrom(
      resolveAnalysisImages({
        client,
        account_id: ACCOUNT,
        candidates: [candidate()],
        loader: mediaLoader,
        signal: controller.signal,
      })
    );

    expect(error.code).toBe('unavailable');
    expect(requests).toEqual([]);
  });
});
