import { NextResponse } from 'next/server';
import { DOCS_UNAVAILABLE } from '../../../../src/lib/manual';
// Legacy job-less search. Applicability (manufacturer + model) can only be judged for a job, so this never returns passages;
// use GET /api/jobs/:jobId/manual/search. No verified documents are loaded in any case.
export function GET() { return NextResponse.json({ passages: [], documentation: DOCS_UNAVAILABLE }); }
