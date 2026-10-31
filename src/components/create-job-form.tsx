"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { Trade } from "../lib/types";
import { createLiveClient } from "../frontend/live-client";
import { errorMessage } from "../frontend/session-client";
import { Banner, Button, Card, Input, PageTitle, Textarea } from "./ui";

type Errors = { trade?: string; reportedProblem?: string };

export function CreateJobForm() {
  const router = useRouter();
  const client = useMemo(() => createLiveClient(), []);
  const [trade, setTrade] = useState<Trade | "">("");
  const [problem, setProblem] = useState("");
  const [equipment, setEquipment] = useState({ manufacturer: "", model: "", serial: "", type: "", notes: "" });
  const [history, setHistory] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Held until the job is created, so a retry after a network failure cannot create a second job. */
  const requestId = useRef<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {};
    if (!trade) next.trade = "Choose HVAC or Plumbing.";
    if (!problem.trim()) next.reportedProblem = "Describe the problem the customer reported.";
    setErrors(next);
    if (next.trade || next.reportedProblem || !trade) return;
    requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setFailure(null);
    const trimmed = Object.fromEntries(Object.entries(equipment).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    try {
      const created = await client.createJob(
        {
          trade,
          reportedProblem: problem.trim(),
          ...(Object.keys(trimmed).length ? { equipment: trimmed } : {}),
          ...(history.trim() ? { serviceHistory: history.trim() } : {}),
        },
        requestId.current,
      );
      router.push(`/jobs/${created.job.id}`);
    } catch (error) {
      setFailure(errorMessage(error));
      setBusy(false);
    }
  }

  const set = (key: keyof typeof equipment) => (event: { target: { value: string } }) => setEquipment((current) => ({ ...current, [key]: event.target.value }));

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto flex max-w-2xl flex-col gap-5" noValidate>
      <PageTitle title="New job" subtitle="Only the trade and the reported problem are required. Everything else is optional and stays blank unless you fill it in." />
      {failure ? <Banner>Job was not created. {failure} Your entries are kept. Try again.</Banner> : null}
      <Card className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Trade</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Trade">
            {(["HVAC", "Plumbing"] as const).map((option) => (
              <label
                key={option}
                className={`flex min-h-12 cursor-pointer items-center justify-center rounded-[13px] border px-3 text-base font-semibold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-amber ${trade === option ? "border-ink bg-ink text-white" : "border-line-strong bg-surface text-ink"}`}
              >
                <input type="radio" name="trade" value={option} checked={trade === option} onChange={() => setTrade(option)} className="sr-only" />
                {option}
              </label>
            ))}
          </div>
          {errors.trade ? (
            <p className="text-sm font-medium text-bad" role="alert">
              {errors.trade}
            </p>
          ) : null}
        </fieldset>
        <Textarea
          label="Reported problem"
          value={problem}
          onChange={(event) => setProblem(event.target.value)}
          error={errors.reportedProblem}
          maxLength={2000}
          rows={4}
          hint="In the customer's or your own words."
        />
      </Card>
      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Equipment (optional)</h2>
          <p className="text-sm text-muted">Enter only what you can read from the unit. Empty fields show as “Not provided”.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Manufacturer" value={equipment.manufacturer} onChange={set("manufacturer")} maxLength={200} autoComplete="off" />
          <Input label="Model" value={equipment.model} onChange={set("model")} maxLength={200} autoComplete="off" />
          <Input label="Serial number" value={equipment.serial} onChange={set("serial")} maxLength={200} autoComplete="off" />
          <Input label="Equipment type" value={equipment.type} onChange={set("type")} maxLength={200} autoComplete="off" />
        </div>
        <Textarea label="Location or notes" value={equipment.notes} onChange={set("notes")} maxLength={1000} rows={2} />
        <Textarea label="Service history" value={history} onChange={(event) => setHistory(event.target.value)} maxLength={4000} rows={3} hint="Only if you know it. Leave blank otherwise." />
      </Card>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => router.push("/")} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating…" : "Create job"}
        </Button>
      </div>
    </form>
  );
}
