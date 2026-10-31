import type { JobSummary, ManualPassage, RepairSession } from "../lib/types";
import type { RealtimeGrant, VoiceBackend } from "./realtime-voice";
import {
  SessionRequestError,
  type JobDetail,
  type ManualSearchResult,
  type MessageResult,
  type ReportResult,
  type SessionClient,
  type SocketGrant,
} from "./session-client";

const JOB_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;
/** Session reads and writes are small; the actor should answer quickly. */
const SESSION_TIMEOUT_MS = 8_000;
/** Model calls can legitimately take longer. */
const AI_TIMEOUT_MS = 45_000;

/** fetch with a deadline. Timeouts and network failures become SessionRequestError with a clear message. */
async function call(url: string, init: RequestInit = {}, timeoutMs = SESSION_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { cache: "no-store", ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new SessionRequestError(`No response after ${Math.round(timeoutMs / 1000)} seconds. The Techybuddy server may be down.`, "TIMEOUT", 504);
    }
    throw new SessionRequestError("Could not reach the Techybuddy server.", "NETWORK", 0);
  }
}

async function readError(response: Response): Promise<SessionRequestError> {
  const data = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new SessionRequestError(
    data?.error?.message || `Request failed (${response.status})`,
    data?.error?.code || "REQUEST_FAILED",
    response.status,
  );
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

function jobPath(jobId: string, suffix = ""): string {
  if (!JOB_PATTERN.test(jobId)) throw new SessionRequestError("Invalid job ID", "VALIDATION_ERROR", 400);
  return `/api/jobs/${jobId}${suffix}`;
}

function sendJson(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function sessionOf(response: Response): Promise<RepairSession> {
  return (await readJson<{ session: RepairSession }>(response)).session;
}

/**
 * Network side of the realtime voice feature. Only the backend holds OPENAI_API_KEY;
 * the browser receives a short-lived ek_ client secret from POST /api/realtime/token.
 */
export function createLiveVoiceBackend(): VoiceBackend {
  return {
    async mintToken(jobId) {
      return readJson<RealtimeGrant>(await call("/api/realtime/token", sendJson({ jobId }), 20_000));
    },
    async searchManual(jobId, query) {
      const data = await readJson<{ passages: ManualPassage[] }>(await call(jobPath(jobId, `/manual/search?q=${encodeURIComponent(query)}`)));
      return data.passages;
    },
    async saveTranscript(jobId, turns) {
      await readJson<unknown>(await call(jobPath(jobId, "/transcript"), sendJson({ turns })));
    },
  };
}

/** Calls the Techybuddy API. No sample data and no API keys live here. */
export function createLiveClient(): SessionClient {
  return {
    async listJobs() {
      const data = await readJson<{ jobs: JobSummary[] }>(await call("/api/jobs"));
      return data.jobs;
    },
    async createJob(input, clientRequestId) {
      return readJson<JobDetail>(await call("/api/jobs", sendJson({ ...input, clientRequestId })));
    },
    async getJob(jobId) {
      return readJson<JobDetail>(await call(jobPath(jobId)));
    },
    async sendMessage(jobId, text) {
      return readJson<MessageResult>(await call(jobPath(jobId, "/messages"), sendJson({ text }), AI_TIMEOUT_MS));
    },
    async searchManual(jobId, query) {
      const data = await readJson<Partial<ManualSearchResult>>(await call(jobPath(jobId, `/manual/search?q=${encodeURIComponent(query)}`)));
      return { passages: data.passages ?? [], documentation: data.documentation ?? null };
    },
    async recordFinding(jobId, idempotencyKey, text) {
      return sessionOf(await call(jobPath(jobId, "/findings"), sendJson({ idempotencyKey, text })));
    },
    async recordCheck(jobId, idempotencyKey, description, result) {
      return sessionOf(await call(jobPath(jobId, "/steps"), sendJson({ idempotencyKey, description, ...(result ? { result } : {}) })));
    },
    async generateReport(jobId) {
      return readJson<ReportResult>(await call(jobPath(jobId, "/report"), sendJson({}), AI_TIMEOUT_MS));
    },
    async saveReport(jobId, text) {
      return readJson<ReportResult>(await call(jobPath(jobId, "/report"), sendJson({ text }, "PUT")));
    },
    async approveReport(jobId, text) {
      return readJson<ReportResult>(await call(jobPath(jobId, "/report/approve"), sendJson({ text })));
    },
    async prepareSocket(jobId) {
      const response = await call(jobPath(jobId, "/socket"), sendJson({}));
      if (response.status === 503) return null;
      return readJson<SocketGrant>(response);
    },
  };
}
