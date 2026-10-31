import { NextRequest, NextResponse } from 'next/server';
import { actors } from '../../../../generated/index.js';
import { authFailureResponse, authorizeJob, jobBrief } from '../../../../src/lib/jobs';
import { buildInstructions, clientSessionConfig, DEFAULT_REALTIME_MODEL, mintClientSecret } from '../../../../src/lib/realtime';
export const runtime = 'nodejs';
const fail = (code: string, message: string, status: number) => NextResponse.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  let body: { jobId?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  if (typeof body?.jobId !== 'string') return fail('VALIDATION_ERROR', 'jobId is required', 400);
  const auth = await authorizeJob(req, body.jobId);
  if (!auth.ok) return authFailureResponse(auth);
  const { job } = auth;
  let session;
  try { session = await actors.RepairSessionActor.get(job.id).getSession(job.id); } catch { return fail('ACTOR_UNAVAILABLE', 'Durable Actors service unavailable', 503); }
  const instructions = buildInstructions(job, session);
  const model = process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
  const minted = await mintClientSecret({ model, instructions });
  if (!minted.ok) return fail(minted.code, minted.message, minted.status);
  return NextResponse.json(
    { value: minted.value, expiresAt: minted.expiresAt, model, instructions, sessionConfig: clientSessionConfig, job: jobBrief(job) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
