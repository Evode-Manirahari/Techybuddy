// Documentation entries only exist when verified against a real source. `verified: true` is a literal so unverified entries cannot be typed in.
export type ManualPassage = { id: string; documentId: string; title: string; manufacturer: string; section: string; page: number; text: string; sourceUrl: string | null; verified: true };
export type VerifiedDocument = { id: string; manufacturer: string; applicableModels: string[]; title: string; version?: string; provenance: string; sourceUrl?: string; passages: ManualPassage[]; verified: true };
export type DocumentationInfo = { status: 'unavailable' | 'available'; message: string };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; sources: string[] };
export type Finding = { id: string; idempotencyKey: string; text: string; confirmedAt: string };
// Free-form technician check. Legacy stored steps may carry `stepId` instead of `description`.
export type CompletedStep = { id: string; idempotencyKey: string; description?: string; stepId?: string; result?: string; confirmedAt: string };
export type TranscriptTurn = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; interrupted?: boolean };
export type Trade = 'HVAC' | 'Plumbing';
// Every field is exactly what the technician typed; nothing is inferred or defaulted.
export type JobEquipment = { manufacturer?: string; model?: string; serial?: string; type?: string; notes?: string; provenance: 'technician-entered' };
export type JobInput = { trade: Trade; reportedProblem: string; equipment: Omit<JobEquipment, 'provenance'>; serviceHistory?: string };
export type JobRecord = { id: string; trade: Trade; reportedProblem: string; equipment: JobEquipment; serviceHistory?: string; serviceHistoryProvenance?: 'technician-entered'; createdAt: string };
export type JobBrief = JobRecord & { documentation: DocumentationInfo };
export type JobSummary = { id: string; trade: Trade; reportedProblem: string; equipment: { manufacturer?: string; model?: string }; createdAt: string };
export type RepairSession = { jobId: string; messages: Message[]; findings: Finding[]; completedSteps: CompletedStep[]; currentStep?: string; unresolvedQuestions: string[]; reportDraft: string; reportApprovedAt?: string; transcript?: TranscriptTurn[]; createdAt: string; updatedAt: string; revision: number };
