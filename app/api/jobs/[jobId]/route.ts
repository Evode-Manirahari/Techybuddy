import { NextResponse } from 'next/server';
import { actors } from '../../../../generated/index.js';
import { authFailureResponse, authorizeJob, jobBrief } from '../../../../src/lib/jobs';
export const runtime='nodejs';
export async function GET(req:Request,{params}:{params:Promise<{jobId:string}>}){const {jobId}=await params;const auth=await authorizeJob(req,jobId);if(!auth.ok)return authFailureResponse(auth);try{return NextResponse.json({session:await actors.RepairSessionActor.get(jobId).getSession(jobId),job:jobBrief(auth.job)},{headers:{'Cache-Control':'no-store'}})}catch{return NextResponse.json({error:{code:'ACTOR_UNAVAILABLE',message:'Durable Actors service unavailable'}},{status:503})}}
