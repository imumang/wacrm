/**
 * The account-scoped repository for canonical image observations.
 *
 * Every function is specific, and every function takes `accountId`
 * first. There is no generic `query()`, no caller-supplied filter
 * object, and no way to reach another account's data. That mirrors
 * `historical-cases/repository.ts` and `vector-memory/repository.ts`,
 * and for the same reason: this is the layer an AI tool or a future
 * retrieval service will call, and a prompt-influenced filter object
 * is exactly what must not exist.
 *
 * Two conventions worth stating once:
 *
 *   - **Writes are whole-aggregate.** A run, its images, its
 *     observations and its source links are one logical record, so
 *     `insertImageAnalysis` writes all four or is treated as having
 *     written none. There is deliberately no "insert one observation"
 *     function: a partial aggregate would leave an observation with no
 *     traceable photograph, which is the one state the schema forbids.
 *
 *   - **Idempotency is expressed, not assumed.** The request
 *     fingerprint's unique index is the authority. When an insert
 *     collides, the existing run is returned rather than a second
 *     record being written, so re-analysing identical media under an
 *     identical model cannot grow the dataset.
 *
 * Traceability is verified HERE as well as in the database. The
 * migration's guards are the real boundary (a service-role write
 * bypasses RLS entirely), but verifying in the domain layer too means a
 * caller who fabricates a `source_media_id` gets a domain error naming
 * the problem rather than a constraint violation.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveMediaObjectPath } from '@/lib/ai/image-analysis/media';

import {
  ImageObservationError,
  buildImageAnalysisResultHash,
  buildImageAnalysisSourceFingerprint,
  isImageAnalysisFailureReason,
  isImageAnalysisFindingKind,
  isImageAnalysisRunState,
  isImageAnalysisRunStatus,
  requireNonEmptyId,
  type CanonicalImageAnalysis,
  type ImageAnalysisAggregate,
  type ImageAnalysisFailureReason,
  type ImageAnalysisObservation,
  type ImageAnalysisObservationSource,
  type ImageAnalysisRun,
  type ImageAnalysisRunImage,
  type ImageAnalysisRunState,
  type ImageAnalysisRunStatus,
} from './model';

export const IMAGE_ANALYSIS_RUN_COLUMNS = [
  'id',
  'account_id',
  'conversation_id',
  'enquiry_id',
  'historical_case_id',
  'analyzer_id',
  'provider',
  'model',
  'analysis_schema_version',
  'prompt_version',
  'status',
  'failure_reason',
  'image_count',
  'correlation_id',
  'source_fingerprint',
  'result_content_hash',
  'state',
  'superseded_by',
  'started_at',
  'completed_at',
  'created_at',
].join(',');

export const IMAGE_ANALYSIS_RUN_IMAGE_COLUMNS = [
  'id',
  'account_id',
  'run_id',
  'ordinal',
  'source_message_id',
  'source_media_id',
  'mime_type',
  'byte_length',
  'direction',
  'message_created_at',
  'created_at',
].join(',');

export const IMAGE_ANALYSIS_OBSERVATION_COLUMNS = [
  'id',
  'account_id',
  'run_id',
  'observation_type',
  'ordinal_in_result',
  'observation_ref',
  'kind',
  'label',
  'confidence',
  'basis',
  'detail',
  'payload',
  'created_at',
].join(',');

export const IMAGE_ANALYSIS_OBSERVATION_SOURCE_COLUMNS = [
  'id',
  'account_id',
  'observation_id',
  'run_image_id',
  'source_ordinal',
  'created_at',
].join(',');

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Read and validate a stored run row.
 *
 * Strict and total for the same reason `parseCaseEmbedding` is: a row
 * that cannot be read back was not written correctly, and a
 * half-defaulted run would let a retrieval consumer believe a status or
 * a version it never actually stored.
 */
export function parseImageAnalysisRun(input: unknown): ImageAnalysisRun {
  const row = requireRecord(input, 'image analysis run');
  const status = row.status;
  if (!isImageAnalysisRunStatus(status)) {
    throw databaseError(`invalid image analysis status: ${String(status)}`);
  }
  const state = row.state;
  if (!isImageAnalysisRunState(state)) {
    throw databaseError(`invalid image analysis state: ${String(state)}`);
  }
  const failureReason = row.failure_reason;
  if (
    failureReason !== null &&
    failureReason !== undefined &&
    !isImageAnalysisFailureReason(failureReason)
  ) {
    throw databaseError(
      `invalid image analysis failure_reason: ${String(failureReason)}`
    );
  }

  const sourceFingerprint = nullableString(row.source_fingerprint);
  const resultContentHash = nullableString(row.result_content_hash);
  for (const [label, value] of [
    ['source_fingerprint', sourceFingerprint],
    ['result_content_hash', resultContentHash],
  ] as const) {
    if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
      throw databaseError(`${label} is not a lowercase sha-256 hex digest`);
    }
  }

  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    conversation_id: requireString(row.conversation_id, 'conversation_id'),
    enquiry_id: nullableString(row.enquiry_id),
    historical_case_id: nullableString(row.historical_case_id),
    analyzer_id: requireString(row.analyzer_id, 'analyzer_id'),
    provider: requireString(row.provider, 'provider'),
    model: requireString(row.model, 'model'),
    analysis_schema_version: requireString(
      row.analysis_schema_version,
      'analysis_schema_version'
    ),
    prompt_version: requireString(row.prompt_version, 'prompt_version'),
    status,
    failure_reason: failureReason ?? null,
    image_count: requireInteger(row.image_count, 'image_count'),
    correlation_id: nullableString(row.correlation_id),
    source_fingerprint: sourceFingerprint,
    result_content_hash: resultContentHash,
    state,
    superseded_by: nullableString(row.superseded_by),
    started_at: requireString(row.started_at, 'started_at'),
    completed_at: nullableString(row.completed_at),
    created_at: requireString(row.created_at, 'created_at'),
  };
}

function parseImageAnalysisRunImage(input: unknown): ImageAnalysisRunImage {
  const row = requireRecord(input, 'image analysis run image');
  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    run_id: requireString(row.run_id, 'run_id'),
    ordinal: requireInteger(row.ordinal, 'ordinal'),
    source_message_id: requireString(row.source_message_id, 'source_message_id'),
    source_media_id: requireString(row.source_media_id, 'source_media_id'),
    mime_type: requireString(row.mime_type, 'mime_type'),
    byte_length: requireInteger(row.byte_length, 'byte_length'),
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    message_created_at: requireString(
      row.message_created_at,
      'message_created_at'
    ),
    created_at: requireString(row.created_at, 'created_at'),
  };
}

function parseImageAnalysisObservationRow(
  input: unknown
): ImageAnalysisObservation {
  const row = requireRecord(input, 'image analysis observation');
  if (!isImageAnalysisFindingKind(row.observation_type)) {
    throw databaseError(
      `invalid observation_type: ${String(row.observation_type)}`
    );
  }
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw databaseError('observation payload must be an object');
  }
  const confidence =
    row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence);
  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    run_id: requireString(row.run_id, 'run_id'),
    finding_kind: row.observation_type,
    ordinal_in_result: requireInteger(row.ordinal_in_result, 'ordinal_in_result'),
    finding_ref: requireString(row.observation_ref, 'observation_ref'),
    kind: nullableString(row.kind),
    label: nullableString(row.label),
    confidence:
      confidence === null || Number.isNaN(confidence) ? null : confidence,
    basis: nullableString(row.basis),
    detail: nullableString(row.detail),
    payload: payload as Record<string, unknown>,
    created_at: requireString(row.created_at, 'created_at'),
  };
}

function parseImageAnalysisObservationSource(
  input: unknown
): ImageAnalysisObservationSource {
  const row = requireRecord(input, 'image analysis observation source');
  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    observation_id: requireString(row.observation_id, 'observation_id'),
    run_image_id: requireString(row.run_image_id, 'run_image_id'),
    source_ordinal: requireInteger(row.source_ordinal, 'source_ordinal'),
  };
}

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

/**
 * Prove every analysed image really came from a message in this
 * conversation, and that its recorded object path is the one that
 * message's own `media_url` resolves to.
 *
 * The domain half of the same guarantee the migration's
 * `guard_image_analysis_run_image_write` enforces in the database.
 * Doing it here as well means a caller who supplies a hand-built
 * `source_media_id` — a path from another account, a URL, a signed URL
 * — gets a named domain error instead of a constraint violation, and
 * because `resolveMediaObjectPath` is the SAME function the media
 * boundary used, the two cannot drift apart.
 *
 * No URL is ever fetched. `resolveMediaObjectPath` parses the stored
 * reference and returns the path; the origin is read but never used.
 */
export async function assertAnalysisSourceTraceability(
  db: SupabaseClient,
  input: { accountId: string; analysis: CanonicalImageAnalysis }
): Promise<void> {
  const { accountId, analysis } = input;

  const { data: conversation, error } = await db
    .from('conversations')
    .select('id')
    .eq('id', analysis.conversation_id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    throw databaseError('Could not verify the analysis conversation');
  }
  // An unknown conversation and another account's conversation are the
  // same answer, so this cannot be used to probe a tenant.
  if (!conversation) {
    throw new ImageObservationError(
      'not_found',
      'Conversation not found'
    );
  }

  const messageIds = analysis.images.map((image) => image.source_message_id);
  const { data: messages, error: messageError } = await db
    .from('messages')
    .select('id,conversation_id,media_url,media_type,content_type')
    .eq('conversation_id', analysis.conversation_id)
    .in('id', messageIds);

  if (messageError) {
    throw databaseError('Could not verify the analysed source messages');
  }

  const byId = new Map(
    ((messages ?? []) as Array<Record<string, unknown>>).map((row) => [
      String(row.id),
      row,
    ])
  );

  for (const image of analysis.images) {
    const message = byId.get(image.source_message_id);
    if (!message) {
      // A message id from another conversation, another account, or one
      // that simply does not exist. All three are the same answer.
      throw new ImageObservationError(
        'not_found',
        'One or more analysed images do not belong to this conversation'
      );
    }
    const resolution = resolveMediaObjectPath(
      (message.media_url as string | null) ?? null,
      accountId
    );
    if (!resolution.ok) {
      throw new ImageObservationError(
        resolution.reason === 'foreign_account' ? 'forbidden' : 'invalid_input',
        'An analysed image is not a WACRM media object for this account'
      );
    }
    if (resolution.object_path !== image.source_media_id) {
      throw new ImageObservationError(
        'invalid_input',
        'The recorded media reference does not match the source message'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface RecordImageAnalysisArgs {
  accountId: string;
  analysis: CanonicalImageAnalysis;
  startedAt?: string;
  completedAt?: string;
}

/**
 * What a record call produced.
 *
 * The full aggregate rather than just the run, because the caller's next
 * question is always relational: which observations came from which
 * photograph. `created: false` means the run already existed — either
 * this analysis was already recorded, or a concurrent writer recorded
 * the identical request first.
 */
export interface RecordImageAnalysisResult extends ImageAnalysisAggregate {
  /** True when this call inserted the run rather than adopting one. */
  created: boolean;
}

/**
 * Persist one validated analysis as a canonical per-image record.
 *
 * Order matters and is deliberate:
 *
 *   1. verify traceability from WACRM's own records;
 *   2. look for an existing run with the same request fingerprint, and
 *      adopt it if there is one;
 *   3. insert the run, then its images, then its observations, then
 *      the source links.
 *
 * If any step after the run insert fails, the run is removed again. A
 * run with no images and no observations would be a record of an
 * analysis that did not happen, and a later read would treat it as one
 * — so a partial aggregate is rolled back rather than left behind.
 */
export async function recordImageAnalysis(
  db: SupabaseClient,
  args: RecordImageAnalysisArgs
): Promise<RecordImageAnalysisResult> {
  const { accountId } = args;
  // The fingerprint is recomputed here rather than read off the argument.
  // It is a pure function of the analysis, and an analysis whose
  // fingerprint was computed before a field was changed would otherwise
  // store a stale identity — which would make a re-analysis under a
  // different model collide with the previous run instead of producing
  // its own. Deriving it at the boundary means the stored fingerprint is
  // always the one that describes what was actually written.
  const analysis: CanonicalImageAnalysis = {
    ...args.analysis,
    fingerprint: {
      source_fingerprint: buildImageAnalysisSourceFingerprint(args.analysis),
      result_content_hash: buildImageAnalysisResultHash(args.analysis),
    },
  };
  await assertAnalysisSourceTraceability(db, { accountId, analysis });

  const fingerprint = analysis.fingerprint.source_fingerprint;
  const existing = await findImageAnalysisRun(db, {
    accountId,
    conversationId: analysis.conversation_id,
    sourceFingerprint: fingerprint,
    analyzerId: analysis.analyzer_id,
    provider: analysis.provider,
    model: analysis.model,
    analysisSchemaVersion: analysis.analysis_schema_version,
    promptVersion: analysis.prompt_version,
  });
  if (existing) {
    return {
      ...(await loadImageAnalysisAggregate(db, {
        accountId,
        runId: existing.id,
      })),
      created: false,
    };
  }

  const runPayload = {
    account_id: accountId,
    conversation_id: analysis.conversation_id,
    enquiry_id: analysis.enquiry_id,
    historical_case_id: analysis.historical_case_id,
    analyzer_id: analysis.analyzer_id,
    provider: analysis.provider,
    model: analysis.model,
    analysis_schema_version: analysis.analysis_schema_version,
    prompt_version: analysis.prompt_version,
    status: 'succeeded',
    failure_reason: null,
    image_count: analysis.images.length,
    correlation_id: analysis.correlation_id,
    source_fingerprint: fingerprint,
    result_content_hash: analysis.fingerprint.result_content_hash,
    state: 'current',
    started_at: args.startedAt ?? new Date().toISOString(),
    completed_at: args.completedAt ?? new Date().toISOString(),
  };

  const insertedRun = await db
    .from('image_analysis_runs')
    .insert(runPayload)
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .single();

  if (insertedRun.error) {
    // A concurrent writer won the race on the same fingerprint. Adopt
    // their run: two workers analysing identical media under the same
    // model produce the same answer, so there is nothing to reconcile.
    if (isUniqueViolation(insertedRun.error)) {
      const winner = await findImageAnalysisRun(db, {
        accountId,
        conversationId: analysis.conversation_id,
        sourceFingerprint: fingerprint,
        analyzerId: analysis.analyzer_id,
        provider: analysis.provider,
        model: analysis.model,
        analysisSchemaVersion: analysis.analysis_schema_version,
        promptVersion: analysis.prompt_version,
      });
      if (winner) {
        return {
          ...(await loadImageAnalysisAggregate(db, {
            accountId,
            runId: winner.id,
          })),
          created: false,
        };
      }
    }
    if (isCheckViolation(insertedRun.error)) {
      // The exclusion guard: the case is excluded from learning.
      throw new ImageObservationError(
        'conflict',
        'This historical case is excluded from learning, so its image analysis cannot be recorded as current.'
      );
    }
    throw databaseError('Could not record the image analysis run');
  }

  const run = parseImageAnalysisRun(insertedRun.data);

  try {
    const images = await insertRunImages(db, accountId, run.id, analysis);
    await insertFindings(db, accountId, run.id, images, analysis);
    return {
      ...(await loadImageAnalysisAggregate(db, {
        accountId,
        runId: run.id,
      })),
      created: true,
    };
  } catch (error) {
    await removeRun(db, accountId, run.id);
    throw error;
  }
}

/**
 * Record a run that produced no validated observations.
 *
 * For observability only. A failure row carries a closed-vocabulary
 * reason, a zero image count and no result hash — there is deliberately
 * no column in which raw provider output could be stored, and the
 * database refuses an observation under any status but `succeeded`.
 */
export async function recordFailedImageAnalysis(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    enquiryId?: string | null;
    historicalCaseId?: string | null;
    analyzerId: string;
    provider: string;
    model: string;
    analysisSchemaVersion: string;
    promptVersion: string;
    status: Exclude<ImageAnalysisRunStatus, 'succeeded'>;
    failureReason: ImageAnalysisFailureReason;
    imageCount?: number;
    correlationId?: string | null;
    startedAt?: string;
    completedAt?: string;
  }
): Promise<ImageAnalysisRun> {
  const { data, error } = await db
    .from('image_analysis_runs')
    .insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      enquiry_id: args.enquiryId ?? null,
      historical_case_id: args.historicalCaseId ?? null,
      analyzer_id: args.analyzerId,
      provider: args.provider,
      model: args.model,
      analysis_schema_version: args.analysisSchemaVersion,
      prompt_version: args.promptVersion,
      status: args.status,
      failure_reason: args.failureReason,
      image_count: Math.max(0, args.imageCount ?? 0),
      correlation_id: args.correlationId ?? null,
      source_fingerprint: null,
      result_content_hash: null,
      state: 'current',
      started_at: args.startedAt ?? new Date().toISOString(),
      completed_at: args.completedAt ?? new Date().toISOString(),
    })
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .single();

  if (error) {
    if (isCheckViolation(error)) {
      throw new ImageObservationError(
        'conflict',
        'This historical case is excluded from learning, so its image analysis cannot be recorded as current.'
      );
    }
    throw databaseError('Could not record the failed image analysis');
  }
  return parseImageAnalysisRun(data);
}

async function insertRunImages(
  db: SupabaseClient,
  accountId: string,
  runId: string,
  analysis: CanonicalImageAnalysis
): Promise<ImageAnalysisRunImage[]> {
  const { data, error } = await db
    .from('image_analysis_run_images')
    .insert(
      [...analysis.images]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((image) => ({
          account_id: accountId,
          run_id: runId,
          ordinal: image.ordinal,
          source_message_id: image.source_message_id,
          source_media_id: image.source_media_id,
          mime_type: image.mime_type,
          byte_length: image.byte_length,
          direction: image.direction,
          message_created_at: image.message_created_at,
        }))
    )
    .select(IMAGE_ANALYSIS_RUN_IMAGE_COLUMNS);

  if (error) {
    throw translateWriteError(error, 'Could not record the analysed images');
  }
  const rows = ((data ?? []) as unknown[]).map(parseImageAnalysisRunImage);
  if (rows.length !== analysis.images.length) {
    throw databaseError('The analysed images could not all be recorded');
  }
  return rows;
}

async function insertFindings(
  db: SupabaseClient,
  accountId: string,
  runId: string,
  images: readonly ImageAnalysisRunImage[],
  analysis: CanonicalImageAnalysis
): Promise<void> {
  const byOrdinal = new Map(images.map((image) => [image.ordinal, image]));

  if (analysis.findings.length > 0) {
    const { error } = await db
      .from('image_analysis_observations')
      .insert(
        analysis.findings.map((finding) => ({
          account_id: accountId,
          run_id: runId,
          observation_type: finding.finding_kind,
          ordinal_in_result: finding.ordinal_in_result,
          observation_ref: finding.finding_ref,
          kind: finding.kind,
          label: finding.label,
          confidence: finding.confidence,
          basis: finding.basis,
          detail: finding.detail,
          payload: finding.payload,
        }))
      );
    if (error) {
      throw translateWriteError(
        error,
        'Could not record the validated image observations'
      );
    }
  }

  // The observation rows are read back rather than assumed. That is not
  // paranoia about the write: the source links below need each row's
  // database-assigned `id`, and a row that could not be read back is a
  // row this domain must not build a traceability graph on.
  const { data, error: readError } = await db
    .from('image_analysis_observations')
    .select(IMAGE_ANALYSIS_OBSERVATION_COLUMNS)
    .eq('account_id', accountId)
    .eq('run_id', runId);
  if (readError) {
    throw databaseError('Could not read back the recorded image observations');
  }
  const observations = ((data ?? []) as unknown[]).map(
    parseImageAnalysisObservationRow
  );

  // Source links. One row per (observation, image) pair — an
  // observation with three sources is ONE observation plus three links,
  // never three observations.
  const links: Array<{
    observation_id: string;
    run_image_id: string;
    source_ordinal: number;
  }> = [];
  for (const finding of analysis.findings) {
    const observation = observations.find(
      (candidate) =>
        candidate.finding_kind === finding.finding_kind &&
        candidate.finding_ref === finding.finding_ref
    );
    if (!observation) {
      throw databaseError(
        'A recorded image observation could not be read back'
      );
    }
    for (const ordinal of finding.source_ordinals) {
      const image = byOrdinal.get(ordinal);
      if (!image) {
        throw databaseError(
          'A recorded image observation references an unknown source image'
        );
      }
      links.push({
        observation_id: observation.id,
        run_image_id: image.id,
        source_ordinal: ordinal,
      });
    }
  }

  if (links.length > 0) {
    const { error } = await db
      .from('image_analysis_observation_sources')
      .insert(
        links.map((link) => ({
          account_id: accountId,
          ...link,
        }))
      );
    if (error) {
      throw translateWriteError(
        error,
        'Could not link the image observations to their source images'
      );
    }
  }
}

async function removeRun(
  db: SupabaseClient,
  accountId: string,
  runId: string
): Promise<void> {
  const { error } = await db
    .from('image_analysis_runs')
    .delete()
    .eq('account_id', accountId)
    .eq('id', runId);
  if (error) {
    // Nothing can be done about a failed rollback here, and surfacing it
    // would mask the original failure. The run is left empty rather than
    // fabricated; the next write of the same fingerprint adopts it.
    console.error(
      '[image-observations] an incomplete image analysis run could not be removed',
      { account_id: accountId, run_id: runId }
    );
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface FindImageAnalysisRunArgs {
  accountId: string;
  conversationId: string;
  sourceFingerprint: string;
  analyzerId: string;
  provider: string;
  model: string;
  analysisSchemaVersion: string;
  promptVersion: string;
}

/**
 * The one run that holds this exact request under this exact model.
 *
 * This is the idempotency read. The database's
 * `idx_image_analysis_runs_request_identity` unique index is the
 * authority; this function is what lets the service adopt an existing
 * row rather than fail on it.
 */
export async function findImageAnalysisRun(
  db: SupabaseClient,
  args: FindImageAnalysisRunArgs
): Promise<ImageAnalysisRun | null> {
  const { data, error } = await db
    .from('image_analysis_runs')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .eq('account_id', args.accountId)
    .eq('conversation_id', args.conversationId)
    .eq('source_fingerprint', args.sourceFingerprint)
    .eq('analyzer_id', args.analyzerId)
    .eq('provider', args.provider)
    .eq('model', args.model)
    .eq('analysis_schema_version', args.analysisSchemaVersion)
    .eq('prompt_version', args.promptVersion)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not look up the image analysis run');
  }
  return data ? parseImageAnalysisRun(data) : null;
}

/**
 * One run with its images, observations and resolved source links.
 *
 * Throws `not_found` rather than returning null for a run this account
 * does not own: an unknown run id and another tenant's run id are the
 * same answer, so the two are indistinguishable.
 */
export async function loadImageAnalysisAggregate(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<ImageAnalysisAggregate> {
  const { data: runRow, error } = await db
    .from('image_analysis_runs')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('id', input.runId)
    .maybeSingle();
  if (error) {
    throw databaseError('Could not load the image analysis run');
  }
  if (!runRow) {
    throw new ImageObservationError(
      'not_found',
      'Image analysis not found'
    );
  }
  const run = parseImageAnalysisRun(runRow);

  const images = await listRunImages(db, {
    accountId: input.accountId,
    runId: run.id,
  });
  const observations = await listRunObservations(db, {
    accountId: input.accountId,
    runId: run.id,
  });

  const mediaByImageId = new Map(
    images.map((image) => [image.id, image.source_media_id])
  );
  const sources: Array<
    ImageAnalysisObservationSource & { source_media_id: string }
  > = [];
  for (const source of await listObservationSources(db, {
    accountId: input.accountId,
    runId: run.id,
  })) {
    sources.push({
      ...source,
      source_media_id: mediaByImageId.get(source.run_image_id) ?? '',
    });
  }

  return { run, images, observations, sources };
}

/** Every analysed image in one run, in ordinal order. */
export async function listRunImages(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<ImageAnalysisRunImage[]> {
  const { data, error } = await db
    .from('image_analysis_run_images')
    .select(IMAGE_ANALYSIS_RUN_IMAGE_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('run_id', input.runId)
    .order('ordinal', { ascending: true });
  if (error) {
    throw databaseError('Could not list the analysed images');
  }
  return ((data ?? []) as unknown[]).map(parseImageAnalysisRunImage);
}

/** Every observation in one run, in result order. */
export async function listRunObservations(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<ImageAnalysisObservation[]> {
  const { data, error } = await db
    .from('image_analysis_observations')
    .select(IMAGE_ANALYSIS_OBSERVATION_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('run_id', input.runId)
    .order('observation_type', { ascending: true })
    .order('ordinal_in_result', { ascending: true });
  if (error) {
    throw databaseError('Could not list the image observations');
  }
  return ((data ?? []) as unknown[]).map(parseImageAnalysisObservationRow);
}

async function listObservationSources(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<ImageAnalysisObservationSource[]> {
  // The links have no `run_id` column of their own — it would be a
  // denormalisation that could disagree with the image they point at —
  // so the run's images are read first and their ids bound explicitly.
  const images = await listRunImages(db, {
    accountId: input.accountId,
    runId: input.runId,
  });
  if (images.length === 0) return [];
  const { data, error } = await db
    .from('image_analysis_observation_sources')
    .select(IMAGE_ANALYSIS_OBSERVATION_SOURCE_COLUMNS)
    .eq('account_id', input.accountId)
    .in(
      'run_image_id',
      images.map((image) => image.id)
    );
  if (error) {
    throw databaseError('Could not list the image observation sources');
  }
  const rows = ((data ?? []) as unknown[]).map(
    parseImageAnalysisObservationSource
  );
  const imageIds = new Set(images.map((image) => image.id));
  return rows.filter((row) => imageIds.has(row.run_image_id));
}

/**
 * The current analysis of one photograph, if there is one.
 *
 * This is the per-image question objective 04 will ask: not "what did
 * the model see anywhere in this conversation" but "what was observed
 * about THIS image, and which analysis says so".
 *
 * A withheld run is excluded, because a withheld analysis is retained
 * for audit and must not be retrievable.
 */
export async function getAnalysisForMedia(
  db: SupabaseClient,
  input: { accountId: string; messageId: string; runId?: string }
): Promise<ImageAnalysisAggregate | null> {
  const messageId = requireNonEmptyId(input.messageId, 'messageId');
  const { data: images, error } = await db
    .from('image_analysis_run_images')
    .select('run_id')
    .eq('account_id', input.accountId)
    .eq('source_message_id', messageId);
  if (error) {
    throw databaseError('Could not look up the analysed media');
  }
  const runIds = [...new Set(((images ?? []) as Array<{ run_id: string }>).map((row) => row.run_id))];
  if (runIds.length === 0) return null;

  const runFilter = input.runId ? [input.runId] : runIds;
  const { data: runs, error: runError } = await db
    .from('image_analysis_runs')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .in('id', runFilter)
    .eq('state', 'current')
    .order('created_at', { ascending: false })
    .limit(1);
  if (runError) {
    throw databaseError('Could not load the current analysis for this media');
  }
  const run = ((runs ?? []) as unknown[])[0];
  if (!run) return null;
  return loadImageAnalysisAggregate(db, {
    accountId: input.accountId,
    runId: (run as Record<string, unknown>).id as string,
  });
}

/**
 * Every analysis recorded against one historical case, newest first.
 *
 * Includes withheld runs. Retention and retrievability are separate
 * questions: this function is the audit read, and a caller that needs
 * retrievable data filters on `state` itself. The alternative —
 * hiding withheld rows here — would make a privacy exclusion invisible to
 * the operator who applied it.
 */
export async function listImageAnalysisRunsForCase(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; limit?: number }
): Promise<ImageAnalysisRun[]> {
  const caseId = requireNonEmptyId(input.caseId, 'caseId');
  const { data, error } = await db
    .from('image_analysis_runs')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('historical_case_id', caseId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.min(Math.max(1, input.limit ?? 20), 100));

  if (error) {
    throw databaseError('Could not list the historical case image analyses');
  }
  return ((data ?? []) as unknown[]).map(parseImageAnalysisRun);
}

/** The current analysis for a conversation's media set, if any. */
export async function getCurrentAnalysis(
  db: SupabaseClient,
  input: { accountId: string; conversationId: string; sourceFingerprint?: string }
): Promise<ImageAnalysisAggregate | null> {
  const conversationId = requireNonEmptyId(
    input.conversationId,
    'conversationId'
  );
  let query = db
    .from('image_analysis_runs')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('conversation_id', conversationId)
    .eq('state', 'current')
    .order('created_at', { ascending: false })
    .limit(1);
  if (input.sourceFingerprint) {
    query = query.eq('source_fingerprint', input.sourceFingerprint);
  }
  const { data, error } = await query;
  if (error) {
    throw databaseError('Could not load the current image analysis');
  }
  const run = ((data ?? []) as unknown[])[0];
  if (!run) return null;
  return loadImageAnalysisAggregate(db, {
    accountId: input.accountId,
    runId: (run as Record<string, unknown>).id as string,
  });
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

/**
 * Mark a run superseded, naming its replacement.
 *
 * Called when a deliberate re-analysis under a different model or
 * observation schema has produced a newer run over the same media. The
 * older run is retained rather than deleted: a case whose frozen
 * snapshot or embedding was derived from it must stay explainable.
 *
 * A withheld run is refused. An analysis withheld by a privacy
 * exclusion must not be quietly moved into an ordinary state.
 */
export async function supersedeImageAnalysisRun(
  db: SupabaseClient,
  input: { accountId: string; runId: string; supersededByRunId: string }
): Promise<ImageAnalysisRun | null> {
  const { data, error } = await db
    .from('image_analysis_runs')
    .update({ state: 'superseded' satisfies ImageAnalysisRunState, superseded_by: input.supersededByRunId })
    .eq('account_id', input.accountId)
    .eq('id', input.runId)
    .neq('state', 'withheld')
    .select(IMAGE_ANALYSIS_RUN_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isCheckViolation(error)) {
      throw new ImageObservationError(
        'conflict',
        'This image analysis is withheld and cannot be superseded'
      );
    }
    throw databaseError('Could not supersede the image analysis run');
  }
  return data ? parseImageAnalysisRun(data) : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw databaseError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw databaseError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw databaseError(`${field} must be a whole number`);
  }
  return parsed;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function databaseError(message: string): ImageObservationError {
  return new ImageObservationError('database_error', message);
}

/**
 * Translate a write failure into a domain error.
 *
 * The driver message is never surfaced: PostgREST errors echo
 * constraint names and occasionally row values, which here could include
 * a storage object path.
 */
function translateWriteError(
  error: unknown,
  fallback: string
): ImageObservationError {
  if (isCheckViolation(error)) {
    return new ImageObservationError(
      'conflict',
      'The image analysis was rejected by a data-integrity guard'
    );
  }
  if (isForeignKeyViolation(error)) {
    return new ImageObservationError(
      'not_found',
      'The image analysis references a record this account does not own'
    );
  }
  return databaseError(fallback);
}

function readCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return readCode(error) === '23505';
}

/** Postgres 23514 is a CHECK violation; the guards use it. */
function isCheckViolation(error: unknown): boolean {
  return readCode(error) === '23514';
}

function isForeignKeyViolation(error: unknown): boolean {
  return readCode(error) === '23503';
}
