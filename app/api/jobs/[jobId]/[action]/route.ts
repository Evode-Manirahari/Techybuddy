import { actors } from '../../../../../generated/index.js';
import { NextRequest, NextResponse } from 'next/server';
import { searchJobDocumentation } from '../../../../../src/lib/manual';
import { openaiJson, responseText } from '../../../../../src/lib/openai';
import { authFailureResponse, authorizeJob } from '../../../../../src/lib/jobs';
import { EVIDENCE_RULES, jobContext } from '../../../../../src/lib/prompts';
import type { Message } from '../../../../../src/lib/types';
export const runtime = 'nodejs';
type Ctx={params:Promise<{jobId:string;action:string}>};
const fail=(code:string,message:string,status:number)=>NextResponse.json({error:{code,message}},{status});
const valid=(s:unknown,max=1000)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
async function body(req:NextRequest){try{return await req.json() as Record<string,unknown>}catch{return {} as Record<string,unknown>}}
async function handle(req:NextRequest,{params}:Ctx){
 const {jobId,action}=await params;
 const auth=await authorizeJob(req,jobId); if(!auth.ok) return authFailureResponse(auth);
 const job=auth.job;
 const actor=actors.RepairSessionActor.get(jobId);
 try {
 if(req.method==='GET'&&action==='session') return NextResponse.json({session:await actor.getSession(jobId)});
 if(req.method!=='POST'&&req.method!=='PUT') return fail('NOT_FOUND','Unknown endpoint',404);
 const b=await body(req);
 if(action==='findings'&&req.method==='POST'){if(!valid(b.text)||!valid(b.idempotencyKey,100))return fail('VALIDATION_ERROR','text and idempotencyKey are required',400);return NextResponse.json({session:await actor.recordFinding(jobId,String(b.idempotencyKey),String(b.text).trim())});}
 if(action==='steps'&&req.method==='POST'){
  // Free-form technician check: description is what the technician typed (legacy clients may send stepId instead); result is optional technician-typed text.
  const description=b.description!==undefined?b.description:b.stepId;
  if(!valid(description,1000)||(b.result!==undefined&&b.result!==null&&!valid(b.result,1000))||!valid(b.idempotencyKey,100))return fail('VALIDATION_ERROR','description (technician-typed check) and idempotencyKey are required; result must be text if given',400);
  return NextResponse.json({session:await actor.confirmStep(jobId,String(b.idempotencyKey),String(description).trim(),b.result?String(b.result).trim():undefined)});
 }
 if(action==='messages'&&req.method==='POST'){
  if(!valid(b.text,2000))return fail('VALIDATION_ERROR','text is required',400);
  const text=String(b.text).trim(), session=await actor.getSession(jobId);
  const {passages:sources,documentation}=searchJobDocumentation(text,job.equipment);
  const data=await openaiJson('responses',{model:process.env.OPENAI_TEXT_MODEL||'gpt-4.1-mini',instructions:`You are TechyBuddy, a careful troubleshooting assistant for a field ${job.trade.toLowerCase()} technician. Answer concisely.\n\n${EVIDENCE_RULES}`,input:`${jobContext(job,session)}\n\nRetrieved verified passages for this question: ${sources.length?JSON.stringify(sources.map(p=>({id:p.id,page:p.page,section:p.section,text:p.text}))):`none. ${documentation.message}`}\nRecent conversation (unconfirmed): ${JSON.stringify(session.messages.slice(-8).map(m=>({role:m.role,text:m.text})))}\nTechnician question: ${text}`});
  const answer=responseText(data);if(!answer)return fail('MODEL_ERROR','Model returned no answer',502);
  const now=new Date().toISOString(), id=crypto.randomUUID();const user:Message={id,role:'user',text,createdAt:now,sources:[]};const assistant:Message={id:crypto.randomUUID(),role:'assistant',text:answer,createdAt:now,sources:sources.map(p=>p.id)};
  return NextResponse.json({session:await actor.appendMessages(jobId,user,assistant),answer,sources,documentation});
 }
 if(action==='report'){
  if(req.method==='PUT'){if(!valid(b.text,20000))return fail('VALIDATION_ERROR','text is required',400);const session=await actor.saveReport(jobId,String(b.text));return NextResponse.json({session,report:session.reportDraft});}
  const s=await actor.getSession(jobId);
  // Evidence = real job fields + technician-CONFIRMED findings/checks. Technician-spoken voice turns are passed separately as UNCONFIRMED statements; assistant text (chat or voice) is never evidence.
  const spoken=(s.transcript??[]).filter(t=>t.role==='user').slice(-40).map(t=>({text:t.text,time:t.createdAt}));
  const evidence={job:{trade:job.trade,reportedProblem:job.reportedProblem,equipment:job.equipment,serviceHistory:job.serviceHistory??null},findings:s.findings.map(f=>({text:f.text,time:f.confirmedAt})),completedChecks:s.completedSteps.map(c=>({check:c.description??c.stepId,result:c.result??null,time:c.confirmedAt})),unresolvedQuestions:s.unresolvedQuestions,unconfirmedTechnicianStatements:spoken};
  const data=await openaiJson('responses',{model:process.env.OPENAI_TEXT_MODEL||'gpt-4.1-mini',instructions:`Write a concise, editable service report DRAFT from the JSON evidence only. Sections: job and equipment (as entered), confirmed findings, completed checks, unresolved questions, outcome. Write "Unknown" for anything not in the evidence (unentered equipment fields, outcome, measurements). Do NOT state a root cause, parts, labor, or outcome unless a confirmed finding or check says so. The reported problem is the customer's/technician's report, not a diagnosis. Assistant suggestions are not evidence. unconfirmedTechnicianStatements are things the technician said aloud that they have NOT confirmed: never report them as completed work, measurements, or outcomes; at most list them under a heading "Unconfirmed technician statements (not verified)", or omit if empty. No equipment documentation has been verified unless stated in the evidence; do not cite manuals. The report is a draft until the technician approves it.`,input:`Evidence: ${JSON.stringify(evidence)}`});
  const report=responseText(data);if(!report)return fail('MODEL_ERROR','Model returned no report',502);const session=await actor.saveReport(jobId,report);return NextResponse.json({session,report});
 }
 if(action==='socket'&&req.method==='POST') return NextResponse.json(await actors.RepairSessionActor.prepareWebsocket({actorId:jobId,metadata:null}));
 return fail('NOT_FOUND','Unknown endpoint',404);
 }catch(e){return fail('SERVER_ERROR',e instanceof Error?e.message:'Unexpected error',503)}
}
export const POST=handle; export const PUT=handle; export const GET=handle;
