import { NextRequest, NextResponse } from 'next/server';
import { authFailureResponse, authorizeJob } from '../../../../../../src/lib/jobs';
import { searchJobDocumentation } from '../../../../../../src/lib/manual';
export const runtime = 'nodejs';

// Job-scoped documentation search for the voice `search_manual` tool. jobId comes from the URL only. Returns passages only from
// VERIFIED documents matching the job's entered manufacturer+model; otherwise { passages: [], documentation: { status: 'unavailable', ... } }.
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const auth = await authorizeJob(req, jobId);
  if (!auth.ok) return authFailureResponse(auth);
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 500);
  return NextResponse.json(searchJobDocumentation(q, auth.job.equipment));
}
