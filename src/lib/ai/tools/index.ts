export {
  AI_TOOL_AUDIT_METADATA_ALLOWLIST,
  AI_TOOL_AUDIT_TABLE,
  createDurableToolAuditSink,
  sanitizeExecutionMetadata,
  toToolAuditRow,
  type ToolAuditMetadataKey,
  type ToolAuditMetadataRow,
  type ToolAuditRow,
} from './audit';
export {
  TOOL_ERROR_CODES,
  ToolError,
  defineReadTool,
  defineWriteTool,
  type ApprovedWriteToolExecutionContext,
  type BusinessTool,
  type ReadBusinessTool,
  type ToolActor,
  type ToolApproval,
  type ToolAuditEvent,
  type ToolAuditMetadata,
  type ToolAuditMetadataValue,
  type ToolAuditRecorder,
  type ToolErrorCode,
  type ToolErrorShape,
  type ToolExecutionContext,
  type ToolResult,
  type WriteBusinessTool,
  type WriteToolExecutionContext,
} from './contract';
export {
  TOOL_CONTEXT_MAX_CORRELATION_ID_CHARS,
  ToolContextError,
  createToolExecutionContext,
  createWriteToolExecutionContext,
  type ToolExecutionContextOptions,
  type TrustedToolAuthorization,
  type WriteToolExecutionContextOptions,
} from './context';
export {
  createRepeatEnquiryTool,
  type CreateRepeatEnquiryInput,
  type CreateRepeatEnquiryOutput,
} from './create-repeat-enquiry';
export {
  getCustomerTool,
  type GetCustomerInput,
  type GetCustomerOutput,
} from './get-customer';
export {
  analyzeImagesTool,
  createAnalyzeImagesTool,
  type AnalyzeImagesDependencies,
  type AnalyzeImagesInput,
  type AnalyzeImagesOutput,
  type AnalyzedImageRef,
} from './analyze-images';
export {
  getConversationTool,
  type GetConversationInput,
  type GetConversationOutput,
  type ToolConversationMessage,
  type ToolEnquiryTransition,
} from './get-conversation';

import { getConversationTool } from './get-conversation';
import { getCustomerTool } from './get-customer';
import { createRepeatEnquiryTool } from './create-repeat-enquiry';
import { analyzeImagesTool } from './analyze-images';

/** Explicit allowlist for future orchestration; there is no raw query tool. */
export const AI_TOOL_REGISTRY = {
  get_customer: getCustomerTool,
  get_conversation: getConversationTool,
  analyze_images: analyzeImagesTool,
  create_repeat_enquiry: createRepeatEnquiryTool,
} as const;

export type AiToolName = keyof typeof AI_TOOL_REGISTRY;
