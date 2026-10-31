# Techybuddy API contract (v2: no fictional data)

Base path `/api`; JSON; errors are `{ "error": { "code": "...", "message": "..." } }`. Nothing is seeded: with no jobs created, `GET /api/jobs` returns `{ "jobs": [] }` and any unknown job id returns `404 JOB_NOT_FOUND`. There are NO verified equipment documents loaded. All `/api/jobs/**` routes and `/api/realtime/token` go through `authorizeJob` (see Authorization).

## Jobs
- `POST /api/jobs` `{ "trade": "HVAC"|"Plumbing", "reportedProblem": "free text", "equipment"?: { "manufacturer"?, "model"?, "serial"?, "type"?, "notes"? }, "serviceHistory"?: "free text", "clientRequestId"?: "string" }` → `201 { "job": JobBrief, "session": RepairSession }` (`200` with the same body on an idempotent retry with the same `clientRequestId`). Everything is stored exactly as typed (trimmed; empty optional fields dropped; nothing inferred or defaulted). The job id is a server-generated uuid. `400 VALIDATION_ERROR` on bad input.
- `GET /api/jobs` → `{ "jobs": JobSummary[] }`, newest first, `[]` when none.
- `GET /api/jobs/:jobId` → `{ "session": RepairSession, "job": JobBrief }`; `404 JOB_NOT_FOUND` for unknown ids (including the legacy `demo-pump-001`, which has no job record).
- `POST /api/jobs/:jobId/findings` `{ idempotencyKey, text }` → `{ session }`. Technician-confirmed finding; key deduplicates retries.
- `POST /api/jobs/:jobId/steps` `{ idempotencyKey, description, result? }` → `{ session }`. Free-form technician check (`description` and optional `result` are technician-typed; legacy `stepId` is accepted as `description`). No fixed step list.
- `POST /api/jobs/:jobId/messages` `{ text }` → `{ session, answer, sources: ManualPassage[], documentation: DocumentationInfo }`. Uses OpenAI; failures return the real error (`502 MODEL_ERROR`/`503`), never a substitute answer. Assistant text is advice, never a finding.
- `POST /api/jobs/:jobId/report` `{}` regenerates a DRAFT → `{ session, report }`. `PUT /api/jobs/:jobId/report` `{ text }` saves an edit → `{ session, report }`. Both CLEAR `session.reportApprovedAt`.
- `POST /api/jobs/:jobId/report/approve` `{ text? }` approves the CURRENT SAVED draft → `{ session, report }` and sets `session.reportApprovedAt`. `409 CONFLICT` if the saved draft is empty or `text` differs from the saved draft. A report is final only when `reportApprovedAt` is set.
- `POST /api/jobs/:jobId/socket` `{}` → `{ websocketUrl, connectByMs }`; the actor pushes `{type:"session_update",session}`. Polling `GET /api/jobs/:jobId` is the fallback.
- `POST /api/jobs/:jobId/transcript` `{ turns: [{ id, role: "user"|"assistant", text, createdAt?, interrupted? }] }` (or one `{ turnId, role, text }`) → `{ session }`. Final voice turns go to `session.transcript` (1–20 per request, text ≤ 4000, last 500 kept). Idempotent by `id`; a re-sent id is ignored unless its text is longer. Transcript turns are never findings or checks.

## Documentation (honest by construction)
- `GET /api/jobs/:jobId/manual/search?q=` and legacy `GET /api/manual/search?q=` → `{ "passages": [], "documentation": { "status": "unavailable", "message": "Verified equipment documentation unavailable." } }` unless a verified document whose manufacturer AND applicable model equal the job's entered manufacturer and model exists (none do; the library in `src/lib/manual.ts` ships empty and only accepts entries with `verified: true`, provenance and real page numbers). No generic or other-model manual is ever cited. `job.documentation` carries the same `{status, message}`.

## Realtime voice
- `POST /api/realtime/token` `{ "jobId": "<uuid>" }` → `200 { value: "ek_…", expiresAt (unix s, 600 s TTL), model, instructions, sessionConfig, job: JobBrief }`. The permanent `OPENAI_API_KEY` stays on the server; `Cache-Control: no-store`. Model = env `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1`). The browser must use `instructions` (`new RealtimeAgent({instructions})`), `sessionConfig` and `value` (`session.connect({apiKey: value})`), since the SDK's own session update overrides what is baked into the secret. Instructions are built server-side from the technician-entered job fields and confirmed findings/checks, with four labelled evidence classes (verified documentation, technician-entered/confirmed facts, general explanation, unknown) and hard rules against assuming damage, measurements, valve state, inspections, repairs, parts or diagnoses. Empty fields are stated as unknown.
- Errors: `400 VALIDATION_ERROR`, `403 FORBIDDEN` (cross-site), `404 JOB_NOT_FOUND`, `503 MISSING_API_KEY` (message mentions `OPENAI_API_KEY`), `502 UPSTREAM_ERROR` (status only; no upstream body or key), `503 ACTOR_UNAVAILABLE`.

## Reports
Generated only from the real job fields + technician-confirmed findings/checks. Technician-spoken transcript turns are passed as clearly labelled unconfirmed statements; assistant text is never evidence. Unknown stays "Unknown"; no root cause, parts, labor or outcome unless confirmed.

## Authorization (prototype limitation)
There are no user accounts. `authorizeJob` in `src/lib/jobs.ts` is the single choke point: id format (400), same-origin (403: if `Origin` is present its host must equal `Host`, else a present `Sec-Fetch-Site` must be `same-origin`/`none`), and the job must exist in the Durable Actors store (404). This does NOT identify a person or company: a non-browser client without those headers that knows a job id is accepted, and job listing is open to any same-origin caller. Replace it with real authentication and per-company ownership before real use. Model/tool arguments never choose the job.

```ts
export type ManualPassage = { id: string; documentId: string; title: string; manufacturer: string; section: string; page: number; text: string; sourceUrl: string | null; verified: true };
export type DocumentationInfo = { status: 'unavailable' | 'available'; message: string };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; sources: string[] };
export type Finding = { id: string; idempotencyKey: string; text: string; confirmedAt: string };
export type CompletedStep = { id: string; idempotencyKey: string; description?: string; stepId?: string /* legacy */; result?: string; confirmedAt: string };
export type TranscriptTurn = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; interrupted?: boolean };
export type JobEquipment = { manufacturer?: string; model?: string; serial?: string; type?: string; notes?: string; provenance: 'technician-entered' };
export type JobBrief = { id: string; trade: 'HVAC' | 'Plumbing'; reportedProblem: string; equipment: JobEquipment; serviceHistory?: string; serviceHistoryProvenance?: 'technician-entered'; createdAt: string; documentation: DocumentationInfo };
export type JobSummary = { id: string; trade: 'HVAC' | 'Plumbing'; reportedProblem: string; equipment: { manufacturer?: string; model?: string }; createdAt: string };
export type RepairSession = { jobId: string; messages: Message[]; findings: Finding[]; completedSteps: CompletedStep[]; currentStep?: string; unresolvedQuestions: string[]; reportDraft: string; reportApprovedAt?: string; transcript?: TranscriptTurn[]; createdAt: string; updatedAt: string; revision: number };
```
