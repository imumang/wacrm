import {
  createRepeatEnquiry,
  EnquiryRepositoryError,
} from '@/lib/enquiries/repository';

import { defineWriteTool, ToolError, type ToolActor } from './contract';
import {
  isRecord,
  parseRequiredId,
  toToolEnquiryContext,
  unavailable,
  type ToolEnquiryContext,
} from './shared';

export interface CreateRepeatEnquiryInput {
  conversation_id: string;
}

export interface CreateRepeatEnquiryOutput {
  enquiry: ToolEnquiryContext;
  created: boolean;
  idempotency_replayed: boolean;
}

export const createRepeatEnquiryTool = defineWriteTool<
  CreateRepeatEnquiryInput,
  CreateRepeatEnquiryOutput
>('create_repeat_enquiry', {
  side_effects: ['create_enquiry', 'append_enquiry_state_event'],
  handler: async (context, rawInput) => {
    const input = parseInput(rawInput);
    if (
      context.approval.resource.type !== 'conversation' ||
      context.approval.resource.id !== input.conversation_id
    ) {
      throw new ToolError(
        'forbidden',
        'Approval does not authorize this conversation'
      );
    }

    try {
      const result = await createRepeatEnquiry(context.db, {
        accountId: context.account_id,
        conversationId: input.conversation_id,
        createdByUserId: actorUserId(context.actor),
        idempotencyKey: context.idempotency_key,
        approvalId: context.approval.approval_id,
        correlationId: context.correlation_id,
      });
      return {
        enquiry: toToolEnquiryContext(result.enquiry),
        created: result.created,
        idempotency_replayed: !result.created,
      };
    } catch (error) {
      if (!(error instanceof EnquiryRepositoryError)) throw error;
      if (error.code === 'not_found') {
        throw new ToolError('not_found', 'Conversation not found');
      }
      if (error.code === 'conflict') {
        throw new ToolError('conflict', error.message);
      }
      throw unavailable('Could not create repeat enquiry');
    }
  },
});

function parseInput(input: unknown): CreateRepeatEnquiryInput {
  if (!isRecord(input)) {
    throw new ToolError('invalid_input', 'Tool input must be an object');
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'conversation_id')) {
    throw new ToolError(
      'invalid_input',
      'create_repeat_enquiry accepts only conversation_id'
    );
  }
  return {
    conversation_id: parseRequiredId(input.conversation_id, 'conversation_id'),
  };
}

function actorUserId(actor: ToolActor): string {
  if (actor.type === 'user') return actor.user_id;
  if (typeof actor.user_id === 'string' && actor.user_id.trim() !== '') {
    return actor.user_id;
  }
  throw new ToolError(
    'forbidden',
    'A canonical user identity is required for this write'
  );
}
