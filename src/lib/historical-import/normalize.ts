/**
 * Objective 02 (Historical Import and Normalization) - deterministic
 * normalization.
 *
 * Everything in this file is a pure function over a single string, and
 * everything in it is *mechanical*. There is no model call, no fuzzy
 * matching, no synonym table and no attempt to understand what a
 * customer wrote. The line is drawn at "rewrite the spelling of a
 * value" and not crossed into "guess the meaning of a value":
 *
 * - A postcode is recognised or it is not. It is never corrected.
 * - A timestamp becomes a canonical instant or it is rejected. A
 *   timezone-less value is not assumed to be UTC, because assuming it
 *   would invent the one piece of information that makes a timestamp
 *   usable.
 * - Free text is trimmed and whitespace-collapsed, and nothing else.
 *   A customer description is not paraphrased, re-spelled or
 *   re-categorised, because a semantic rewrite is a new fact wearing
 *   an old fact's name.
 *
 * Two normalizers here are **recognisers rather than writers**, and the
 * distinction matters:
 *
 * `normalizeUkPostcode` and `normalizeText` are used by the importer to
 * decide whether a source value is usable *as evidence of anything at
 * all*. They never write back to `enquiries` or any other canonical
 * column. `enquiries.postcode` is operational truth and this objective
 * does not touch it; what the importer records is a provenance
 * annotation for the column, which is why recognising the value is the
 * only thing that has to be right.
 */

/**
 * Maximum canonical-text length, matching the fact table's own bound.
 *
 * A source value longer than this is reported as unmapped rather than
 * truncated, because a truncated value is a different value and a
 * silently shortened address is worse than an absent one.
 */
export const HISTORICAL_IMPORT_MAX_TEXT_LENGTH = 2_000;

/**
 * The UK postcode shape.
 *
 * Recognizer, not a canonical form. It answers "is this plausibly a UK
 * postcode?" and nothing else: `normalizeUkPostcode` returns the
 * canonical spelling for comparison and for reporting, and the importer
 * never replaces the stored column with it.
 *
 * The shape is outward-inward: one or two letters, a digit, an optional
 * letter or digit, then the inward code of a digit and two letters.
 * `W1 1AA`, `SW1A 1AA` and `e14 9sh` all match; `n/a`, `???`, `12345`
 * and a free-text address do not.
 *
 * Deliberately a UK shape, because that is the shape this deployment's
 * enquiries actually hold. Being wrong about that fails benignly and
 * in one direction: an unrecognised value is reported rather than
 * recorded, and nothing is ever rewritten.
 */
const UK_POSTCODE_SHAPE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

/**
 * True when a timestamp string carries a timezone designator.
 *
 * The same test the objective-01 fact vocabulary applies to a stored
 * instant, for the same reason: "08:00 on the site" and "08:00 UTC" are
 * different facts, and a dataset that cannot tell them apart cannot
 * derive a labour duration from either.
 */
export function hasTimezoneDesignator(value: string): boolean {
  const trimmed = value.trim();
  return (
    /[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)
  );
}

/**
 * Canonicalize a timestamp to a UTC ISO-8601 instant.
 *
 * Returns `null` - unknown, not an error - for a missing, unparseable,
 * or timezone-less value. The caller records why, because "the source
 * had no timezone" and "the source had no timestamp" are different
 * findings about the data.
 */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!hasTimezoneDesignator(trimmed)) return null;
  if (Number.isNaN(Date.parse(trimmed))) return null;
  return new Date(trimmed).toISOString();
}

/**
 * Recognize a UK postcode and return its canonical spelling.
 *
 * Uppercase, single internal space, nothing else. Returns `null` for a
 * value that is not postcode-shaped, which is how the importer tells
 * "this column holds a postcode" from "this column holds something
 * that is not a postcode".
 */
export function normalizeUkPostcode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().toUpperCase().replace(/\s+/g, '');
  if (compact === '' || compact.length > 8) return null;
  if (!UK_POSTCODE_SHAPE.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/**
 * Trim and collapse whitespace, and reject anything empty or oversized.
 *
 * The only text normalization performed anywhere in the import. No
 * case folding, no punctuation stripping, no synonym mapping, no
 * truncation.
 */
export function normalizeText(
  value: unknown,
  maxLength: number = HISTORICAL_IMPORT_MAX_TEXT_LENGTH
): string | null {
  if (typeof value !== 'string') return null;
  // Collapse every whitespace run - including newlines, tabs and the
  // non-breaking space WhatsApp clients emit - to one space.
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  if (collapsed.length > maxLength) return null;
  return collapsed;
}

/**
 * Normalize a free-text list column.
 *
 * `enquiries.access_constraints`, `item_descriptions` and
 * `heavy_special_items` are `TEXT[]`. Each entry is normalized
 * independently and entries that normalize to nothing are dropped, so
 * a stray empty string in a historical row does not become a fact that
 * says "an empty constraint was recorded".
 */
export function normalizeTextList(
  value: unknown,
  maxLength: number = HISTORICAL_IMPORT_MAX_TEXT_LENGTH
): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeText(entry, maxLength);
    if (normalized === null) continue;
    seen.add(normalized);
  }
  return seen.size === 0 ? null : [...seen];
}

/**
 * What the importer does with a media reference, stated rather than
 * implemented.
 *
 * An inbound attachment is imported as a *reference*: the source
 * ledger names the `messages` row, and that row keeps its own
 * `created_at`, `media_type` and `media_url`. Nothing in the import
 * path downloads the bytes, and nothing writes an `image_observed`
 * fact - that provenance means "a validated model looked at this
 * photo", and claiming it without running analysis would be the most
 * serious fabrication available to this objective.
 *
 * The canonical storage *object path* is deliberately not extracted
 * here. There is no column that could hold it without implying an
 * observation (`historical_case_facts.source_media_id` is gated behind
 * `image_observed`), and adding one for a string the message row can
 * already produce would be schema churn. That attachment point belongs
 * to the image-enrichment phase, which runs analysis and can then
 * write both together.
 */