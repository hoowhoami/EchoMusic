import {
  canPrepareGaplessTransition,
  resolveQueueAdvanceAuthority,
  type QueueAdvanceAuthority,
} from '../../../shared/playback-queue-decision';
import { LISTEN_TOGETHER_QUEUE_ID, PERSONAL_FM_QUEUE_ID } from '../playlist/constants';

export const getQueueAdvanceAuthority = (
  queueId: string | number | null | undefined,
): QueueAdvanceAuthority => {
  return resolveQueueAdvanceAuthority({
    queueId,
    personalFmQueueId: PERSONAL_FM_QUEUE_ID,
    listenTogetherQueueId: LISTEN_TOGETHER_QUEUE_ID,
  });
};

export const canPrepareGaplessForQueue = (
  queueId: string | number | null | undefined,
  autoNextSuppressed: boolean,
): boolean =>
  canPrepareGaplessTransition({
    authority: getQueueAdvanceAuthority(queueId),
    autoNextSuppressed,
  });
