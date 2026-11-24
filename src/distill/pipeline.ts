import { authorHandler } from "./author.js";
import { clusterHandlers } from "./cluster.js";
import { digestHandler } from "./digest.js";
import type { RetryHandlers } from "./retry.js";

export { SYSTEMIC_FAILURE_STREAK } from "../runners/failures.js";
export {
  type AuthorStageOptions,
  type AuthorStageResult,
  createRecoveryOperations,
  prepareTaskRecoveryInputs,
  runAuthorStage,
  type SkippedTask,
  type SourcesJson,
  summarizeOutcomes,
} from "./author.js";
export {
  clearCheckpoints,
  type DigestLineage,
  type DigestsCheckpoint,
  loadDigests,
  loadTasks,
  newGeneration,
  saveDigests,
  saveTasks,
  type TasksCheckpoint,
} from "./checkpoints.js";
export {
  applyClusterMerges,
  CLUSTER_TIMEOUT_PER_DIGEST_MS,
  type ClusterStageOptions,
  type ClusterStageResult,
  canonicalizeClusterIds,
  planClusterWindows,
  runClusterStage,
  synthesizeNoGroupTasks,
  validateCluster,
} from "./cluster.js";
export {
  type BlockedSession,
  countReusableDigests,
  type DigestStageOptions,
  type DigestStageResult,
  planDigestReuse,
  runDigestStage,
} from "./digest.js";
export type { RunnerFn, StageFailure } from "./stage-support.js";

/** Strict selection calls only the handler for the chosen operation. */
export function createRetryHandlers(home: string): RetryHandlers {
  return { digest: digestHandler(home), author: authorHandler(home), ...clusterHandlers(home) };
}
