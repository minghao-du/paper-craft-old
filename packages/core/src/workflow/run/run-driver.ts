/**
 * Run intake and authoritative Fleet relationships; managed execution belongs to one Run.
 * Compatibility facade re-exporting workflow operations from cohesive domain modules.
 */

export {
  home,
  inspectRuns,
  updateRunRegistry,
  save,
  claimDriver,
  validateRegistryRoles,
  type RunSubject,
  type WorkflowRun,
  type RunRegistry,
  type StageRequest,
  type StageDispatch,
  type StageReceipt,
  type StageFacts,
} from './run-registry.js';

export {
  reserveSubject,
  releaseRunCheckout,
  orchestratorForSubject,
  referenceRunSubject,
  reserveRunCheckout,
} from './run-ownership.js';

export {
  stopRun,
  releaseRun,
  type StopRunResult,
  type ReleaseRunResult,
  type RunControlOptions,
} from './run-control.js';

export {
  startRun,
  verifyRunRequirements,
  assignmentWithRequirements,
} from './startup.js';

export {
  recoverRun,
  recoverAllRuns,
} from './recovery.js';

export {
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  retryStage,
  setRemediationLimit,
  startBusinessTurn,
  collectBusinessTurn,
  validateImplementationResult,
  acceptValidatedBusinessTurns,
  sendStageMessage,
  reconcileStageMessage,
  stopAcceptedExecution,
  releaseAcceptedExecution,
  epicChildSubjects,
  verifyEpicDeliveries,
  type StageRetryOptions,
  type CollectBusinessTurnOptions,
  type ReconcileStageMessageResult,
  type StageMessageInput,
  type StageFactVerifier,
  type StageAcceptanceVerifier,
  type StageDispatchOptions,
  type StageReceiptOptions,
  type BusinessTurnResult,
} from './stage-execution.js';

export {
  inspectRun,
  inspectRunViews,
  type WorkflowRunView,
  type WorkflowRunExecutionView,
  type WorkflowRunResourceView,
  type WorkflowRunHelperView,
} from './run-observation.js';

export {
  epicDeliveries,
  canonicalDeliveryFingerprint,
  confirmStageEpic,
  closeStageEpic,
  dispositionStagePipeline,
  publishStageReport,
  type EpicClosureActions,
  type DeliverySummary,
  type HumanEpicConfirmation,
  type EpicClosureResult,
  type PipelineDispositionResult,
  type StageReportOptions,
  type StageReportResult,
} from './epic-completion.js';

export { pipelineAccepted } from '../delivery/epic-finalization.js';
