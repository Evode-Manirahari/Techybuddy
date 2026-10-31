# Techybuddy

Voice-first assistant for HVAC and plumbing technicians. A technician creates a job from information they enter themselves, records findings and checks they confirm, talks to the assistant (text or realtime voice), and produces a report draft that only becomes final when they approve it.

## Start
Requires Node 22.
```sh
npm install
cp .env.example .env.local   # set OPENAI_API_KEY (server-side only; never in browser code)
npm run actors               # Durable Actors local runtime on :7100
npm run dev                  # in a second terminal, http://localhost:3000
```

## What is real, and what is not
- Real: jobs, findings, checks, transcripts and reports are stored in Durable Actors (one actor per job plus an index actor). Nothing is seeded; a fresh install has no jobs. AI answers, voice, transcription and reports come from OpenAI; if OpenAI fails the real error is returned.
- Not available: **no verified manufacturer documentation is loaded.** Documentation search returns `Verified equipment documentation unavailable.` and the assistant says so for any equipment-specific specification or procedure. The library in `src/lib/manual.ts` ships empty and accepts only verified entries with provenance and real page numbers.
- Not real authentication: there are no accounts. Job routes check only that the request is same-origin and the job exists, and anyone who can reach the server can list jobs. See [API_CONTRACT.md](API_CONTRACT.md).
- Earlier test sessions (e.g. the legacy `demo-pump-001` actor) may remain in the local `.durable-actors` store; they have no job record and are never served or listed.

## Backend
Endpoints and shapes: [API_CONTRACT.md](API_CONTRACT.md). Env: `OPENAI_API_KEY`, optional `OPENAI_TEXT_MODEL`, `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1`). After changing actor method signatures run `npm run actors:generate` and `npm run compile:actor`, then restart `npm run actors`.
