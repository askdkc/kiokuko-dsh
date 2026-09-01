import { KiokukoError } from '../../errors.js';
import { successEnvelope } from '../../serialization/envelope.js';
import {
  type CheckpointMutationPort,
  type CheckpointMutationResult,
} from '../../gateway/checkpoint-mutation-service.js';
import type { NudgeDeliveryPort, ValidatedNudgeDeliveryRequest } from '../../gateway/nudge-delivery-service.js';
import { AgentCheckpointUseCase } from '../agent-checkpoint-use-case.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { agentRequestBindingHash } from './request-binding.js';

const CHECKPOINTS_SUFFIX = 'checkpoints';
const FEEDBACK_SUFFIX = 'feedback';

function legacyCheckpointUseCase(context: AgentRouteContext): AgentCheckpointUseCase {
  const legacy = context.checkpointService;
  if (legacy === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Agent checkpoint use case is not configured');
  }
  const checkpointMutation: CheckpointMutationPort = {
    checkpoint: (input: unknown): CheckpointMutationResult => {
      const value = legacy.checkpoint(input);
      return {
        ...value,
        preliminaryRecommendations: [...(value.recommendations ?? [])],
      };
    },
  };
  const nudgeDelivery: NudgeDeliveryPort = {
    deliver: (input: ValidatedNudgeDeliveryRequest) => legacy.deliverNudge(input),
  };
  return new AgentCheckpointUseCase({
    database: context.database,
    service: context.service,
    checkpointMutation,
    validateMutationAcknowledgement: false,
    nudgeDelivery,
    broker: context.broker,
    enqueueWrite: context.enqueueWrite,
  });
}

export function createTask5Route(context: AgentRouteContext): V1RouteHandler {
  const checkpoint = context.agentCheckpoint ?? legacyCheckpointUseCase(context);
  return async (request) => {
    if (request.method === 'POST') {
      const rawCheckpointRunId = runIdSegment(request.url.pathname, CHECKPOINTS_SUFFIX);
      if (rawCheckpointRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawCheckpointRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.checkpoint',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await checkpoint.execute({
          runId,
          idempotencyKey,
          body: request.body,
          requestBindingHash,
        });
        return successEnvelope('agent.checkpoint', data);
      }

      const rawFeedbackRunId = runIdSegment(request.url.pathname, FEEDBACK_SUFFIX);
      if (rawFeedbackRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawFeedbackRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.feedback',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await context.enqueueWrite(() => context.feedbackService.feedback({ runId, idempotencyKey, request: request.body }));
        return successEnvelope('agent.feedback', { ...data, requestBindingHash });
      }
    }

    return undefined;
  };
}

export function task5Operation(method: string, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (runIdSegment(pathname, CHECKPOINTS_SUFFIX) !== undefined) return 'agent.checkpoint';
  if (runIdSegment(pathname, FEEDBACK_SUFFIX) !== undefined) return 'agent.feedback';
  return undefined;
}
