import { NextResponse } from 'next/server';
import { actors } from '../../generated/index.js';
import { documentationInfo } from './manual';
import type { JobBrief, JobInput, JobRecord, JobSummary, Trade } from './types';

// Jobs are created only from technician-entered information (POST /api/jobs) and stored in Durable Actors:
// one RepairSessionActor per job (id = job uuid) plus a singleton JobIndexActor for the summary list. Nothing is seeded.
export const JOB_ID_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;
export const INDEX_ACTOR_ID = 'index';

export function jobBrief(job: JobRecord): JobBrief { return { ...job, documentation: documentationInfo(job.equipment) }; }
export function jobSummary(job: JobRecord): JobSummary {
  const { manufacturer, model } = job.equipment;
  return { id: job.id, trade: job.trade, reportedProblem: job.reportedProblem, equipment: { ...(manufacturer ? { manufacturer } : {}), ...(model ? { model } : {}) }, createdAt: job.createdAt };
}

const FIELD_LIMITS = { manufacturer: 200, model: 200, serial: 200, type: 200, notes: 2000 } as const;
export type ParsedJobInput = { ok: true; input: JobInput; clientRequestId: string | null } | { ok: false; message: string };
/** Validates a create-job body. Stores exactly what was typed (trimmed); empty optional fields are dropped, never defaulted. */
export function parseJobInput(b: unknown): ParsedJobInput {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  if (o.trade !== 'HVAC' && o.trade !== 'Plumbing') return { ok: false, message: "trade is required: 'HVAC' or 'Plumbing'" };
  if (typeof o.reportedProblem !== 'string' || !o.reportedProblem.trim() || o.reportedProblem.length > 4000) return { ok: false, message: 'reportedProblem is required (max 4000 chars)' };
  const equipment: JobInput['equipment'] = {};
  const eq = o.equipment === undefined || o.equipment === null ? {} : o.equipment;
  if (typeof eq !== 'object' || Array.isArray(eq)) return { ok: false, message: 'equipment must be an object' };
  for (const k of Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[]) {
    const v = (eq as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > FIELD_LIMITS[k]) return { ok: false, message: `equipment.${k} must be a string (max ${FIELD_LIMITS[k]} chars)` };
    if (v.trim()) equipment[k] = v.trim();
  }
  let serviceHistory: string | undefined;
  if (o.serviceHistory !== undefined && o.serviceHistory !== null) {
    if (typeof o.serviceHistory !== 'string' || o.serviceHistory.length > 4000) return { ok: false, message: 'serviceHistory must be text (max 4000 chars)' };
    if (o.serviceHistory.trim()) serviceHistory = o.serviceHistory.trim();
  }
  let clientRequestId: string | null = null;
  if (o.clientRequestId !== undefined && o.clientRequestId !== null) {
    if (typeof o.clientRequestId !== 'string' || !o.clientRequestId.trim() || o.clientRequestId.length > 100) return { ok: false, message: 'clientRequestId must be a non-empty string (max 100 chars)' };
    clientRequestId = o.clientRequestId.trim();
  }
  return { ok: true, input: { trade: o.trade as Trade, reportedProblem: o.reportedProblem.trim(), equipment, ...(serviceHistory ? { serviceHistory } : {}) }, clientRequestId };
}

export type AuthFailure = { ok: false; status: 400 | 403 | 404 | 503; code: string; message: string };
export type AuthResult = { ok: true; job: JobRecord } | AuthFailure;

/**
 * Same-origin check for browser requests. Browsers always send Origin on cross-site and non-GET requests and
 * Sec-Fetch-Site on all of them; a cross-site page therefore cannot pass. Requests with neither header (curl,
 * server-to-server) are allowed.
 */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  if (origin !== null) { try { return !!host && new URL(origin).host === host; } catch { return false; } }
  const site = req.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin' || site === 'none';
  return true;
}
export const crossSiteFailure: AuthFailure = { ok: false, status: 403, code: 'FORBIDDEN', message: 'Cross-site requests are not allowed' };

/**
 * THE single authorization choke point for every job-scoped route. There are no user accounts, so "authorized"
 * means: the job exists in the Durable Actors store and the request is same-origin. LIMITATION: this does not
 * identify a person or company; anyone who can reach the server and knows a job id (and sends no browser
 * cross-site headers) is allowed. Replace with real authentication and per-company ownership checks before real use.
 * Callers must pass the jobId from the URL/body, never from model tool arguments.
 */
export async function authorizeJob(req: Request, jobId: string): Promise<AuthResult> {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Invalid job ID' };
  if (!isSameOrigin(req)) return crossSiteFailure;
  try {
    const job = await actors.RepairSessionActor.get(jobId).getJob();
    if (!job) return { ok: false, status: 404, code: 'JOB_NOT_FOUND', message: 'Unknown job' };
    return { ok: true, job };
  } catch { return { ok: false, status: 503, code: 'ACTOR_UNAVAILABLE', message: 'Durable Actors service unavailable' }; }
}

export function authFailureResponse(f: AuthFailure): NextResponse {
  return NextResponse.json({ error: { code: f.code, message: f.message } }, { status: f.status });
}
