import type {
  ApprovedAiConfig,
  DocumentTextExtractor,
  InvoiceExtractor,
  JobLease,
  JobOutcome,
} from "@invoxim/core";
import type { AiBudgetPolicy, AiPriceSnapshot } from "../ai/budget";
import type { TransientContentReader } from "./gmail-content";
import type { PipelineRepository, PipelineWork } from "./repository";

export interface PipelineControl {
  readonly signal: AbortSignal;
  readonly checkpoint: () => Promise<boolean>;
}
export interface TransientContentFactory {
  open(
    lease: JobLease,
    control: PipelineControl,
  ): Promise<TransientContentReader>;
}
export interface PipelineInferenceFactory {
  open(
    lease: JobLease,
    work: PipelineWork,
    parts: readonly { id: string; text: string }[],
  ): Promise<{
    config: ApprovedAiConfig;
    extractor: InvoiceExtractor;
    pricing: ReadonlyMap<string, AiPriceSnapshot>;
  }>;
}
export interface PipelineServiceOptions {
  readonly repository: PipelineRepository;
  readonly content: TransientContentFactory;
  readonly documents: DocumentTextExtractor;
  readonly inference: PipelineInferenceFactory;
  readonly budget: AiBudgetPolicy;
  readonly remainingStatements: () => number;
}
export interface PipelineService {
  run(lease: JobLease, control: PipelineControl): Promise<JobOutcome>;
}
