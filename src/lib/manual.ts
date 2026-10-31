import type { DocumentationInfo, JobEquipment, ManualPassage, VerifiedDocument } from './types';

// Verified-documentation library. It ships EMPTY on purpose: no manufacturer document has been verified and loaded.
// Only add an entry here with real provenance (manufacturer, applicable models, title, source URL/file, real page numbers).
// Nothing in the app may cite a passage that is not traceable to an entry in this list.
export const documents: VerifiedDocument[] = [];

export const DOCS_UNAVAILABLE: DocumentationInfo = { status: 'unavailable', message: 'Verified equipment documentation unavailable.' };

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

/** Documents whose manufacturer AND applicable model match what the technician entered. No fuzzy/generic fallback. */
export function applicableDocuments(equipment: Pick<JobEquipment, 'manufacturer' | 'model'>): VerifiedDocument[] {
  const mf = norm(equipment.manufacturer), model = norm(equipment.model);
  if (!mf || !model) return [];
  return documents.filter(d => d.verified === true && norm(d.manufacturer) === mf && d.applicableModels.some(m => norm(m) === model));
}

export function documentationInfo(equipment: Pick<JobEquipment, 'manufacturer' | 'model'>): DocumentationInfo {
  const n = applicableDocuments(equipment).length;
  return n ? { status: 'available', message: `${n} verified document(s) match the entered manufacturer and model.` } : DOCS_UNAVAILABLE;
}

const STOP_WORDS = new Set(['what','should','for','the','and','are','how','why','does','with','this','that','can','you','any','not','was','has','have','from','when','which','there','about','where','who','its','but','our','all','too']);
const stem = (w: string): string => (w.length > 4 ? w.replace(/(ing|ed)$/, '').replace(/([^s])s$/, '$1') : w);
const stems = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem));

export function searchPassages(query: string, docs: readonly VerifiedDocument[]): ManualPassage[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP_WORDS.has(w)).map(stem) ?? [];
  const scored = docs.flatMap(d => d.passages).map(p => { const t = stems(p.text), sec = stems(p.section); return { p, score: words.reduce((n, w) => n + (t.has(w) ? 1 : 0) + (sec.has(w) ? 1 : 0), 0) }; }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored.filter(x => x.score * 2 >= top).slice(0, 3).map(x => x.p);
}

/** Search scoped to a job's equipment. Returns no passages and an 'unavailable' status unless a verified applicable document exists. */
export function searchJobDocumentation(query: string, equipment: Pick<JobEquipment, 'manufacturer' | 'model'>): { passages: ManualPassage[]; documentation: DocumentationInfo } {
  const docs = applicableDocuments(equipment);
  if (!docs.length) return { passages: [], documentation: DOCS_UNAVAILABLE };
  return { passages: searchPassages(query, docs), documentation: documentationInfo(equipment) };
}
