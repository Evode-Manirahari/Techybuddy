import { Actor, Persisted, type ActorSocket } from 'durable-actors';
import type { RepairSession, Message, TranscriptTurn, JobInput, JobRecord, JobSummary } from './lib/types';

const MAX_TRANSCRIPT_TURNS = 500;

type Outgoing = { type: 'session_update'; session: RepairSession };
// One actor per job (actor id = job id). It holds the technician-entered job record and the working session.
// A job exists only when `job` is set: legacy actors that only have an old auto-created `session` are NOT served.
export class RepairSessionActor extends Actor<null, never, Outgoing> {
  @Persisted private session: RepairSession | null = null;
  @Persisted private job: JobRecord | null = null;
  async createJob(jobId: string, input: JobInput, createdAt: string): Promise<{ job: JobRecord; session: RepairSession; created: boolean }> {
    if (this.job && this.session) return { job: this.job, session: this.session, created: false };
    const { manufacturer, model, serial, type, notes } = input.equipment;
    const equipment: JobRecord['equipment'] = { provenance: 'technician-entered', ...(manufacturer ? { manufacturer } : {}), ...(model ? { model } : {}), ...(serial ? { serial } : {}), ...(type ? { type } : {}), ...(notes ? { notes } : {}) };
    this.job = { id: jobId, trade: input.trade, reportedProblem: input.reportedProblem, equipment, ...(input.serviceHistory ? { serviceHistory: input.serviceHistory, serviceHistoryProvenance: 'technician-entered' as const } : {}), createdAt };
    this.session = { jobId, messages: [], findings: [], completedSteps: [], unresolvedQuestions: [], reportDraft: '', transcript: [], createdAt, updatedAt: createdAt, revision: 0 };
    return { job: this.job, session: this.session, created: true };
  }
  async getJob(): Promise<JobRecord | null> { return this.job && this.session ? this.job : null; }
  async getSession(jobId: string): Promise<RepairSession> {
    if (!this.job || !this.session) throw new Error('JOB_NOT_FOUND');
    if (!Array.isArray(this.session.transcript)) this.session = { ...this.session, transcript: [] };
    return this.session;
  }
  private async commit(s: RepairSession): Promise<RepairSession> { this.session = {...s, updatedAt:new Date().toISOString(), revision:s.revision+1}; this.broadcast({type:'session_update',session:this.session}); return this.session; }
  async appendMessages(jobId:string, user:Message, assistant:Message): Promise<RepairSession> { const s=await this.getSession(jobId); if(s.messages.some(m=>m.id===user.id)) return s; return this.commit({...s,messages:[...s.messages,user,assistant]}); }
  async recordFinding(jobId:string,key:string,text:string): Promise<RepairSession> { const s=await this.getSession(jobId); if(s.findings.some(f=>f.idempotencyKey===key)) return s; return this.commit({...s,findings:[...s.findings,{id:crypto.randomUUID(),idempotencyKey:key,text,confirmedAt:new Date().toISOString()}]}); }
  async confirmStep(jobId:string,key:string,description:string,result?:string): Promise<RepairSession> { const s=await this.getSession(jobId); if(s.completedSteps.some(f=>f.idempotencyKey===key)) return s; return this.commit({...s,completedSteps:[...s.completedSteps,{id:crypto.randomUUID(),idempotencyKey:key,description,...(result?{result}:{}),confirmedAt:new Date().toISOString()}]}); }
  // Any save (edit or regeneration) clears technician approval.
  async saveReport(jobId:string,text:string): Promise<RepairSession> { const s=await this.getSession(jobId); const { reportApprovedAt: _a, ...rest } = s; void _a; return this.commit({...rest,reportDraft:text}); }
  // Approves the saved draft only if it still equals `expectedDraft` (guards against a concurrent edit).
  async approveReport(jobId:string,expectedDraft:string): Promise<RepairSession> { const s=await this.getSession(jobId); if(!s.reportDraft.trim()||s.reportDraft!==expectedDraft) return s; return this.commit({...s,reportApprovedAt:new Date().toISOString()}); }
  // Persists FINAL voice turns. Idempotent by turn id: a re-sent id is ignored unless its text is longer (then the text is updated). Not evidence.
  async appendTranscript(jobId:string, turns:TranscriptTurn[]): Promise<RepairSession> {
    const s=await this.getSession(jobId); const next=[...(s.transcript??[])]; let changed=false;
    for(const t of turns){ const i=next.findIndex(x=>x.id===t.id); if(i<0){ next.push(t); changed=true; } else if(t.text.length>next[i].text.length){ next[i]={...next[i],text:t.text,interrupted:t.interrupted??next[i].interrupted}; changed=true; } }
    if(!changed) return s; return this.commit({...s,transcript:next.slice(-MAX_TRANSCRIPT_TURNS)});
  }
  async onConnect(socket:ActorSocket<null,Outgoing>):Promise<void> { if(this.session && this.job) socket.send({type:'session_update',session:this.session}); }
}

// Singleton index (fixed id 'index'): the job summary list plus clientRequestId -> jobId reservations for idempotent create. Starts empty; never seeded.
export class JobIndexActor extends Actor<null, never, never> {
  @Persisted private jobs: JobSummary[] = [];
  @Persisted private requests: Record<string, string> = {};
  // Returns the job id bound to this clientRequestId, binding `candidateId` if it is new.
  async reserve(clientRequestId: string | null, candidateId: string): Promise<string> {
    if (!clientRequestId) return candidateId;
    const existing = this.requests[clientRequestId];
    if (existing) return existing;
    this.requests = { ...this.requests, [clientRequestId]: candidateId };
    return candidateId;
  }
  async addJob(summary: JobSummary): Promise<void> { if (!this.jobs.some(j => j.id === summary.id)) this.jobs = [summary, ...this.jobs]; }
  async listJobs(): Promise<JobSummary[]> { return [...this.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
}
