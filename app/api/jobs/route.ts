import { NextRequest, NextResponse } from 'next/server';
import { INDEX_ACTOR_ID, authFailureResponse, crossSiteFailure, isSameOrigin, jobBrief, jobSummary, parseJobInput } from '../../../src/lib/jobs';
import { actors } from '../../../generated/index.js';
export const runtime = 'nodejs';
const fail = (code: string, message: string, status: number) => NextResponse.json({ error: { code, message } }, { status });
const actorDown = () => fail('ACTOR_UNAVAILABLE', 'Durable Actors service unavailable', 503);

// GET /api/jobs -> { jobs: JobSummary[] } newest first. Empty array when no job has been created; never seeded.
export async function GET(req: NextRequest) {
  if (!isSameOrigin(req)) return authFailureResponse(crossSiteFailure);
  try { return NextResponse.json({ jobs: await actors.JobIndexActor.get(INDEX_ACTOR_ID).listJobs() }, { headers: { 'Cache-Control': 'no-store' } }); } catch { return actorDown(); }
}

// POST /api/jobs: creates a job from technician-ENTERED information only. Job id is generated here (uuid).
// clientRequestId makes retries idempotent (same id => same job, no duplicate).
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return authFailureResponse(crossSiteFailure);
  let body: unknown = null;
  try { body = await req.json(); } catch { /* validated below */ }
  const parsed = parseJobInput(body);
  if (!parsed.ok) return fail('VALIDATION_ERROR', parsed.message, 400);
  try {
    const index = actors.JobIndexActor.get(INDEX_ACTOR_ID);
    const jobId = await index.reserve(parsed.clientRequestId, crypto.randomUUID());
    const { job, session, created } = await actors.RepairSessionActor.get(jobId).createJob(jobId, parsed.input, new Date().toISOString());
    await index.addJob(jobSummary(job)); // idempotent by id; also repairs a retry after a partial failure
    return NextResponse.json({ job: jobBrief(job), session }, { status: created ? 201 : 200 });
  } catch { return actorDown(); }
}
