import type { JobRecord, RepairSession } from './types';
import { applicableDocuments, DOCS_UNAVAILABLE } from './manual';

const q = (s: string) => JSON.stringify(s);
const unknown = (v?: string) => (v ? q(v) : 'unknown (not entered)');

/** Shared evidence rules used by the voice instructions, text chat and report prompts. */
export const EVIDENCE_RULES = `EVIDENCE CLASSES. Keep these four distinct and say which one you are using:
(a) VERIFIED DOCUMENTATION: manufacturer documents that were loaded and verified. Only the passages listed under VERIFIED DOCUMENTATION below count. If none are listed, no verified documentation exists for this job: for ANY equipment-specific procedure, specification, torque, clearance, pressure, wiring, error code or part information say exactly "Verified equipment documentation unavailable." and do not present guesses as manufacturer instructions. Never cite a manual that is not listed.
(b) TECHNICIAN-ENTERED / CONFIRMED FACTS: the job details and the confirmed findings and checks listed below. These are the only established facts about this job.
(c) GENERAL TECHNICAL EXPLANATION: widely known trade knowledge. Label it "general explanation, not manufacturer-approved", and remind the technician to follow site safety and lockout/tagout procedures and the equipment documentation.
(d) UNKNOWN: anything else. Say it is unknown.

HARD RULES
- Never assume a component is damaged, a measurement was taken, a valve is open or closed, an inspection was done, a repair was completed, the problem is solved, a part was installed, or a diagnosis is confirmed unless a technician-confirmed item below says so.
- Ask for missing information instead of guessing (model/serial plate, readings, what was actually observed).
- If the evidence is insufficient, say so plainly.
- Treat what the technician says in conversation as UNCONFIRMED until they confirm it as a finding or check in the app. Treat earlier assistant suggestions as unconfirmed advice too.
- Never invent measurements, parts, labor, causes, or outcomes.`;

/** Job context built ONLY from technician-entered job fields and technician-confirmed session state. Empty fields are stated as unknown. */
export function jobContext(job: JobRecord, session: RepairSession): string {
  const e = job.equipment;
  const findings = session.findings.map(f => `- ${q(f.text)} (confirmed ${f.confirmedAt})`).join('\n') || '- none confirmed yet';
  const steps = session.completedSteps.map(s => `- ${q(s.description ?? s.stepId ?? '')}${s.result ? ` -> ${q(s.result)}` : ''} (confirmed ${s.confirmedAt})`).join('\n') || '- none confirmed yet';
  const docs = applicableDocuments(e);
  const docText = docs.length
    ? docs.flatMap(d => d.passages.map(p => `[${p.id}] ${d.manufacturer} ${d.title}${d.version ? ` (${d.version})` : ''}, page ${p.page}, ${p.section}: ${p.text}`)).join('\n')
    : `none. ${DOCS_UNAVAILABLE.message}`;
  return `JOB (technician-entered; id ${job.id})
Trade: ${job.trade}
Reported problem: ${q(job.reportedProblem)}
Equipment manufacturer: ${unknown(e.manufacturer)}
Equipment model: ${unknown(e.model)}
Equipment serial: ${unknown(e.serial)}
Equipment type: ${unknown(e.type)}
Equipment location/notes: ${unknown(e.notes)}
Previous service history (technician-entered): ${unknown(job.serviceHistory)}

TECHNICIAN-CONFIRMED FINDINGS:
${findings}

TECHNICIAN-CONFIRMED CHECKS:
${steps}

VERIFIED DOCUMENTATION:
${docText}`;
}
