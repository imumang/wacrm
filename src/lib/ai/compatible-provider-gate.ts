import { AiError, type AiProvider } from './types'

/**
 * Deterministic server-side gate for the `openai_compatible` provider.
 *
 * The provider adapter is integrated but DISABLED in this deployment: it is
 * neither selectable, savable, testable nor executable unless an operator
 * sets the server-only env flag `AI_COMPATIBLE_PROVIDER_ENABLED=true` after a
 * separate approval. Read at call time (not module load) so it can never be
 * flipped by client input, and so tests can toggle it.
 */
export function isCompatibleProviderEnabled(): boolean {
  return process.env.AI_COMPATIBLE_PROVIDER_ENABLED === 'true'
}

export const COMPATIBLE_PROVIDER_DISABLED_CODE = 'provider_disabled'

/** True when `provider` may be saved/tested/executed under the current gate. */
export function isProviderAllowed(provider: AiProvider | string): boolean {
  return provider !== 'openai_compatible' || isCompatibleProviderEnabled()
}

/** Throws a fail-closed AiError (403) when the provider is gated off. */
export function assertProviderAllowed(provider: AiProvider | string): void {
  if (!isProviderAllowed(provider)) {
    throw new AiError(
      'The OpenAI-compatible provider is disabled in this deployment.',
      { code: COMPATIBLE_PROVIDER_DISABLED_CODE, status: 403 },
    )
  }
}
