import type { DocumentationInfo, JobBrief, JobSummary, ManualPassage, RepairSession, Trade } from "../lib/types";

export type SocketGrant = { websocketUrl: string; connectByMs: number };

export type JobDetail = { session: RepairSession; job: JobBrief };

export type NewJobInput = {
  trade: Trade;
  reportedProblem: string;
  equipment?: { manufacturer?: string; model?: string; serial?: string; type?: string; notes?: string };
  serviceHistory?: string;
};

export type MessageResult = {
  session: RepairSession;
  answer: string;
  sources: ManualPassage[];
};

export type ReportResult = {
  session: RepairSession;
  report: string;
};

export type ManualSearchResult = {
  passages: ManualPassage[];
  documentation: DocumentationInfo | null;
};

/** Browser-facing API operations. Everything returned here came from the server. */
export type SessionClient = {
  listJobs(): Promise<JobSummary[]>;
  createJob(input: NewJobInput, clientRequestId: string): Promise<JobDetail>;
  getJob(jobId: string): Promise<JobDetail>;
  sendMessage(jobId: string, text: string): Promise<MessageResult>;
  searchManual(jobId: string, query: string): Promise<ManualSearchResult>;
  recordFinding(jobId: string, idempotencyKey: string, text: string): Promise<RepairSession>;
  recordCheck(jobId: string, idempotencyKey: string, description: string, result: string): Promise<RepairSession>;
  generateReport(jobId: string): Promise<ReportResult>;
  saveReport(jobId: string, text: string): Promise<ReportResult>;
  approveReport(jobId: string, text: string): Promise<ReportResult>;
  prepareSocket(jobId: string): Promise<SocketGrant | null>;
};

export class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

export const MISSING_KEY_MESSAGE =
  "AI features are off: OPENAI_API_KEY is not set on the server. Add it to .env.local and restart the server. Findings, checks, and reports can still be written by hand.";

/** The backend answers AI, report, and voice routes with this text when the server key is absent. */
export function isMissingKeyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("OPENAI_API_KEY");
}

export function isNotFound(error: unknown): boolean {
  return error instanceof SessionRequestError && (error.status === 404 || error.code === "JOB_NOT_FOUND");
}

export function errorMessage(error: unknown): string {
  if (isMissingKeyError(error)) return MISSING_KEY_MESSAGE;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
