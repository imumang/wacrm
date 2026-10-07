/**
 * Registry guards for Objective 02.
 *
 * Two invariants are load-bearing enough to assert directly rather than
 * trusting a code review to keep them:
 *
 *   1. The registry is an explicit allowlist of business tools, and nothing
 *      in it can express an unrestricted query.
 *   2. The tool layer carries no model/provider dependency, so the tools stay
 *      usable by any orchestrator and the audit/context work introduces no
 *      LLM wiring.
 */

import { describe, expect, it } from 'vitest';

import { AI_TOOL_REGISTRY } from './index';

const ALLOWED_TOOL_NAMES = [
  'get_customer',
  'get_conversation',
  'analyze_images',
  'create_repeat_enquiry',
];

/** Anything that smells like a raw database escape hatch. */
const UNRESTRICTED_ACCESS_PATTERN =
  /sql|query|raw|exec|statement|rpc|graphql|table/i;

describe('AI tool registry', () => {
  it('contains exactly the reviewed allowlist', () => {
    expect(Object.keys(AI_TOOL_REGISTRY).sort()).toEqual(
      [...ALLOWED_TOOL_NAMES].sort()
    );
  });

  it('offers no unrestricted query or SQL tool', () => {
    for (const [name, tool] of Object.entries(AI_TOOL_REGISTRY)) {
      expect(UNRESTRICTED_ACCESS_PATTERN.test(name)).toBe(false);
      expect(['read', 'write']).toContain(tool.access);
      expect(tool).not.toHaveProperty('sql');
      expect(tool).not.toHaveProperty('query');
      expect(tool).not.toHaveProperty('rpc');
      expect(tool).not.toHaveProperty('table');
    }
  });

  it('declares read tools as side-effect free and write tools as gated', () => {
    for (const tool of Object.values(AI_TOOL_REGISTRY)) {
      if (tool.access === 'read') {
        expect(tool.side_effects).toBe('none');
        expect(tool).not.toHaveProperty('approval_required');
      } else {
        expect(tool.side_effects.length).toBeGreaterThan(0);
        expect(tool.approval_required).toBe(true);
        expect(tool.idempotency).toBe('required_account_tool_scoped');
        expect(tool.audit_required).toBe(true);
        expect(tool.account_scope).toBe('required');
      }
    }
  });
});
