import { NextRequest, NextResponse } from 'next/server';
import { actors } from '../../../../../../generated/index.js';
import { authFailureResponse, authorizeJob } from '../../../../../../src/lib/jobs';
export const runtime = 'nodejs';
const fail = (code: string, message: string, status: number) => NextResponse.json({ error: { code, message } }, { status });

// Technician approval of the CURRENT SAVED draft. Optional body { text }: if given it must equal the saved draft (else 409: unsaved edits).
// Any later PUT/regeneration clears the approval.
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const auth = await authorizeJob(req, jobId);
  if (!auth.ok) return authFailureResponse(auth);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* text is optional */ }
  try {
    const actor = actors.RepairSessionActor.get(jobId);
    const s = await actor.getSession(jobId);
    if (!s.reportDraft.trim()) return fail('CONFLICT', 'No saved report draft to approve', 409);
    if (b?.text !== undefined && b.text !== s.reportDraft) return fail('CONFLICT', 'The report text differs from the saved draft; save it before approving', 409);
    const session = await actor.approveReport(jobId, s.reportDraft);
    if (!session.reportApprovedAt) return fail('CONFLICT', 'The saved draft changed; review and approve again', 409);
    return NextResponse.json({ session, report: session.reportDraft });
  } catch { return fail('ACTOR_UNAVAILABLE', 'Durable Actors service unavailable', 503); }
}
