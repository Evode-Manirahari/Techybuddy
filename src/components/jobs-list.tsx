"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JobSummary } from "../lib/types";
import { createLiveClient } from "../frontend/live-client";
import { errorMessage } from "../frontend/session-client";
import { Badge, Banner, Button, EmptyState, LinkButton, PageTitle, Spinner } from "./ui";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; jobs: JobSummary[] };

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function JobsList() {
  const client = useMemo(() => createLiveClient(), []);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", jobs: await client.listJobs() });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Jobs"
        subtitle="Open a job to talk to Techybuddy, record findings, and prepare the report."
        actions={state.kind === "ready" && state.jobs.length ? <LinkButton href="/jobs/new">New job</LinkButton> : undefined}
      />
      {state.kind === "loading" ? <Spinner label="Loading jobs…" /> : null}
      {state.kind === "error" ? (
        <Banner
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          Jobs could not be loaded. {state.message}
        </Banner>
      ) : null}
      {state.kind === "ready" && state.jobs.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          body="Create a job with the trade and the problem the customer reported. Nothing is pre-filled."
          action={<LinkButton href="/jobs/new">Create job</LinkButton>}
        />
      ) : null}
      {state.kind === "ready" && state.jobs.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {state.jobs.map((job) => {
            const equipment = [job.equipment.manufacturer, job.equipment.model].filter(Boolean).join(" ");
            return (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="flex h-full min-h-11 flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 transition hover:border-line-strong sm:p-5">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="amber">{job.trade}</Badge>
                    <span className="text-sm text-muted">{when(job.createdAt)}</span>
                  </div>
                  <p className="line-clamp-3 text-base font-semibold break-words">{job.reportedProblem}</p>
                  <p className="text-sm text-muted">{equipment || "Equipment not provided"}</p>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
