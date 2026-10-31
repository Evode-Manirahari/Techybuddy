import { NextRequest, NextResponse } from 'next/server';
import { actors } from '../../../../../generated/index.js';
import { authFailureResponse, authorizeJob } from '../../../../../src/lib/jobs';
import type { TranscriptTurn } from '../../../../../src/lib/types';
export const runtime = 'nodejs';
const MAX_TURNS_PER_REQUEST = 20;
const fail = (code: string, message: string, status: number) => NextResponse.json({ error: { code, message } }, { status });

// Persists FINAL voice turns: body { turns: [{ id, role, text, createdAt?, interrupted? }] } (or one turn as { turnId|id, role, text }).
// Idempotent by turn id (a re-sent id with longer text updates the text). Transcript turns are never findings/checks.
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const auth = await authorizeJob(req, jobId);
  if (!auth.ok) return authFailureResponse(auth);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* validated below */ }
  const raw: unknown[] = Array.isArray(b?.turns) ? b.turns : b && (b.turnId !== undefined || b.id !== undefined) ? [b] : [];
  if (raw.length === 0 || raw.length > MAX_TURNS_PER_REQUEST) return fail('VALIDATION_ERROR', `turns must contain 1-${MAX_TURNS_PER_REQUEST} items`, 400);
  const now = Date.now();
  const turns: TranscriptTurn[] = [];
  for (const item of raw) {
    const t = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = t.id ?? t.turnId;
    if (typeof id !== 'string' || !id.trim() || id.length > 100) return fail('VALIDATION_ERROR', 'each turn needs an id (max 100 chars)', 400);
    if (t.role !== 'user' && t.role !== 'assistant') return fail('VALIDATION_ERROR', "role must be 'user' or 'assistant'", 400);
    if (typeof t.text !== 'string' || !t.text.trim() || t.text.length > 4000) return fail('VALIDATION_ERROR', 'each turn needs text (max 4000 chars)', 400);
    // Client timestamp is only used for ordering display; ignore it unless it is a valid, not-in-the-future ISO time.
    const ts = typeof t.createdAt === 'string' ? Date.parse(t.createdAt) : NaN;
    const createdAt = Number.isFinite(ts) && ts <= now + 60_000 ? new Date(ts).toISOString() : new Date(now).toISOString();
    turns.push({ id, role: t.role, text: t.text.trim(), createdAt, ...(t.interrupted === true ? { interrupted: true } : {}) });
  }
  try { return NextResponse.json({ session: await actors.RepairSessionActor.get(auth.job.id).appendTranscript(auth.job.id, turns) }); }
  catch { return fail('ACTOR_UNAVAILABLE', 'Durable Actors service unavailable', 503); }
}
