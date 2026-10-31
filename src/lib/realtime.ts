import { EVIDENCE_RULES, jobContext } from './prompts';
import type { JobRecord, RepairSession } from './types';

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
export const REALTIME_VOICE = 'marin';
export const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
export const CLIENT_SECRET_TTL_SECONDS = 600;

/** Browser-SDK (camelCase) config the client passes to RealtimeSession `config`; mirrors what is sent upstream. */
export const clientSessionConfig = {
  audio: {
    input: {
      transcription: { model: TRANSCRIPTION_MODEL, language: 'en' },
      turnDetection: { type: 'semantic_vad', eagerness: 'auto', createResponse: true, interruptResponse: true },
    },
    output: { voice: REALTIME_VOICE },
  },
} as const;

/** Builds the model instructions entirely server-side from the authorized job's technician-entered fields and confirmed session state. */
export function buildInstructions(job: JobRecord, session: RepairSession): string {
  return `You are TechyBuddy, a hands-free voice assistant for a field ${job.trade.toLowerCase()} technician. You are speaking aloud with a technician who may be working with their hands busy.

HOW TO SPEAK
- Give practical, short spoken answers: one to three sentences, plain words, one step at a time. No lists, markdown, or long preambles.
- If the technician interrupts, stop and listen. If something is unclear, ask one short clarifying question.
- Briefly say which evidence class you are using (verified documentation, technician-confirmed facts, general explanation, or unknown).
- You can call the search_manual tool to look for verified documentation for this job's equipment; if it returns none, say "Verified equipment documentation unavailable."

${EVIDENCE_RULES}

${jobContext(job, session)}`;
}

export type MintResult =
  | { ok: true; value: string; expiresAt: number }
  | { ok: false; status: 502 | 503; code: string; message: string };

/** Mints a short-lived ephemeral client secret. The permanent key never leaves this function. */
export async function mintClientSecret(opts: { model: string; instructions: string }): Promise<MintResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, status: 503, code: 'MISSING_API_KEY', message: 'OPENAI_API_KEY is not configured on the server' };
  const c = clientSessionConfig.audio;
  const body = {
    expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
    session: {
      type: 'realtime',
      model: opts.model,
      instructions: opts.instructions,
      audio: {
        input: {
          transcription: { model: c.input.transcription.model, language: c.input.transcription.language },
          turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
        },
        output: { voice: c.output.voice },
      },
    },
  };
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {}); // upstream body is intentionally discarded
      return { ok: false, status: 502, code: 'UPSTREAM_ERROR', message: `The voice service rejected the session request (status ${r.status})` };
    }
    const data = (await r.json()) as { value?: unknown; expires_at?: unknown };
    if (typeof data.value !== 'string' || !data.value.startsWith('ek_')) return { ok: false, status: 502, code: 'UPSTREAM_ERROR', message: 'The voice service returned an unexpected response' };
    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : Math.floor(Date.now() / 1000) + CLIENT_SECRET_TTL_SECONDS;
    return { ok: true, value: data.value, expiresAt };
  } catch {
    return { ok: false, status: 502, code: 'UPSTREAM_ERROR', message: 'Could not reach the voice service' };
  }
}
