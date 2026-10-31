"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobBrief, ManualPassage, RepairSession } from "../lib/types";
import { createLiveClient, createLiveVoiceBackend } from "../frontend/live-client";
import { createCamera } from "../frontend/camera";
import { createRealtimeVoice } from "../frontend/realtime-voice";
import { errorMessage, isMissingKeyError, isNotFound } from "../frontend/session-client";
import { VoicePanel, useVoiceSnapshot } from "./voice-panel";
import { Badge, Banner, Button, Card, EmptyState, Input, LinkButton, SegmentedTabs, Spinner, Textarea } from "./ui";

type LinkState = "connecting" | "live" | "polling" | "offline";
type Load = "loading" | "ready" | "not-found" | "error";
type Tab = "voice" | "findings" | "report";
/** `retry` is null when retrying cannot help, such as a missing server API key. */
type BannerState = { message: string; retry: (() => void) | null } | null;

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const LINK_LABEL: Record<LinkState, { text: string; tone: "neutral" | "good" | "bad" | "amber" }> = {
  connecting: { text: "Connecting", tone: "neutral" },
  live: { text: "Live updates", tone: "good" },
  polling: { text: "Connected (polling)", tone: "good" },
  offline: { text: "Offline", tone: "bad" },
};

export function Workspace({ jobId }: { jobId: string }) {
  const client = useMemo(() => createLiveClient(), []);
  const [job, setJob] = useState<JobBrief | null>(null);
  const [session, setSession] = useState<RepairSession | null>(null);
  const [load, setLoad] = useState<Load>("loading");
  const [loadError, setLoadError] = useState("");
  const [link, setLink] = useState<LinkState>("connecting");
  const [tab, setTab] = useState<Tab>("voice");
  const [banner, setBanner] = useState<BannerState>(null);
  const [passages, setPassages] = useState<Record<string, ManualPassage>>({});
  const [draft, setDraft] = useState("");
  const [findingText, setFindingText] = useState("");
  const [checkText, setCheckText] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [reportText, setReportText] = useState("");
  const [reportDirty, setReportDirty] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingFinding, setSavingFinding] = useState(false);
  const [savingCheck, setSavingCheck] = useState(false);
  const [reportBusy, setReportBusy] = useState<"generate" | "save" | "approve" | null>(null);
  const [confirmingProposal, setConfirmingProposal] = useState<string | null>(null);
  const reportDirtyRef = useRef(false);
  const findingKey = useRef<string | null>(null);
  const checkKey = useRef<string | null>(null);
  const sessionRef = useRef<RepairSession | null>(null);
  const socketOpen = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<(quiet?: boolean) => Promise<unknown>>(async () => null);
  const passagesRef = useRef<(items: ManualPassage[]) => void>(() => undefined);

  const remember = useCallback((items: ManualPassage[]) => {
    if (!items.length) return;
    setPassages((current) => {
      const next = { ...current };
      for (const item of items) next[item.id] = item;
      return next;
    });
  }, []);

  /** Realtime voice for this job. The job id comes from the page route, never from the model. */
  const voiceController = useMemo(
    () =>
      createRealtimeVoice({
        jobId,
        backend: createLiveVoiceBackend(),
        hooks: {
          onPassages: (items) => passagesRef.current(items),
          onTranscriptSaved: () => void refreshRef.current(true),
        },
      }),
    [jobId],
  );
  const voice = useVoiceSnapshot(voiceController);
  /** Camera and recording. Images reach the AI only through the voice controller's live session. */
  const cameraController = useMemo(() => createCamera({ sink: voiceController }), [voiceController]);

  const applySession = useCallback((next: RepairSession, forceReport = false) => {
    sessionRef.current = next;
    setSession(next);
    if (forceReport || !reportDirtyRef.current) {
      setReportText(next.reportDraft);
      reportDirtyRef.current = false;
      setReportDirty(false);
    }
  }, []);

  const refresh = useCallback(
    async (quiet = false) => {
      try {
        const detail = await client.getJob(jobId);
        setJob(detail.job);
        const current = sessionRef.current;
        if (!current || detail.session.revision !== current.revision) applySession(detail.session);
        setLoad("ready");
        setLink(socketOpen.current ? "live" : "polling");
        if (!quiet) setBanner(null);
        return detail;
      } catch (error) {
        if (isNotFound(error)) {
          setLoad("not-found");
          return null;
        }
        setLink("offline");
        if (!sessionRef.current) {
          setLoad("error");
          setLoadError(errorMessage(error));
        } else if (!quiet) {
          setBanner({ message: errorMessage(error), retry: () => void refresh(false) });
        }
        return null;
      }
    },
    [applySession, client, jobId],
  );

  useEffect(() => {
    refreshRef.current = refresh;
    passagesRef.current = remember;
  }, [refresh, remember]);

  // Leaving the page must close the voice session and release the microphone.
  useEffect(() => {
    const release = () => {
      cameraController.stopAll();
      void voiceController.stop();
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
      cameraController.dispose();
    };
  }, [voiceController, cameraController]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    setLoad("loading");
    setLink("connecting");
    setSession(null);
    sessionRef.current = null;
    socketOpen.current = false;
    void refresh(false).then((detail) => {
      if (cancelled || !detail) return;
      void client
        .prepareSocket(jobId)
        .then((grant) => {
          if (cancelled || !grant?.websocketUrl) return;
          socket = new WebSocket(grant.websocketUrl);
          socket.onopen = () => {
            socketOpen.current = true;
            setLink("live");
          };
          socket.onmessage = (event) => {
            try {
              // The actor sends { type: "session_update", session } on connect and after each mutation.
              const payload = JSON.parse(String(event.data)) as { type?: string; session?: RepairSession };
              if (payload.type === "session_update" && payload.session) {
                const current = sessionRef.current;
                if (!current || payload.session.revision >= current.revision) applySession(payload.session);
              }
            } catch {
              // An unreadable update is ignored; polling keeps the page correct.
            }
          };
          socket.onclose = () => {
            socketOpen.current = false;
            setLink((value) => (value === "live" ? "polling" : value));
          };
        })
        .catch(() => undefined);
    });
    const poll = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh(true);
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      socket?.close();
    };
  }, [applySession, client, jobId, refresh]);

  const log = useMemo(
    () =>
      session
        ? [...session.messages, ...(session.transcript ?? []).map((turn) => ({ ...turn, sources: [] as string[], spoken: true }))]
            .map((entry, index) => ({ entry, index }))
            .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.index - b.index)
            .map(({ entry }) => entry)
        : [],
    [session],
  );

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [log.length]);

  function setReport(next: string) {
    reportDirtyRef.current = true;
    setReportDirty(true);
    setReportText(next);
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || sending) return;
    setSending(true);
    try {
      const result = await client.sendMessage(jobId, question);
      remember(result.sources);
      applySession(result.session);
      setDraft("");
      setBanner(null);
    } catch (error) {
      const missingKey = isMissingKeyError(error);
      setBanner({ message: errorMessage(error), retry: missingKey ? null : () => void ask(question) });
    } finally {
      setSending(false);
    }
  }

  async function confirmProposal(id: string) {
    const proposal = voice.proposals.find((item) => item.id === id);
    if (!proposal || confirmingProposal) return;
    setConfirmingProposal(id);
    try {
      // Same idempotency key on every retry, so a repeated tap cannot create a duplicate finding.
      applySession(await client.recordFinding(jobId, proposal.idempotencyKey, proposal.text));
      voiceController.removeProposal(id);
      setBanner(null);
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: () => void confirmProposal(id) });
    } finally {
      setConfirmingProposal(null);
    }
  }

  async function confirmFinding() {
    const text = findingText.trim();
    if (!text || savingFinding) return;
    findingKey.current ??= crypto.randomUUID();
    setSavingFinding(true);
    try {
      applySession(await client.recordFinding(jobId, findingKey.current, text));
      findingKey.current = null;
      setFindingText("");
      setBanner(null);
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: () => void confirmFinding() });
    } finally {
      setSavingFinding(false);
    }
  }

  async function confirmCheck() {
    const description = checkText.trim();
    if (!description || savingCheck) return;
    checkKey.current ??= crypto.randomUUID();
    setSavingCheck(true);
    try {
      applySession(await client.recordCheck(jobId, checkKey.current, description, checkResult.trim()));
      checkKey.current = null;
      setCheckText("");
      setCheckResult("");
      setBanner(null);
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: () => void confirmCheck() });
    } finally {
      setSavingCheck(false);
    }
  }

  async function generateReport() {
    if (reportBusy) return;
    setReportBusy("generate");
    try {
      const result = await client.generateReport(jobId);
      applySession(result.session, true);
      setBanner(null);
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: isMissingKeyError(error) ? null : () => void generateReport() });
    } finally {
      setReportBusy(null);
    }
  }

  async function saveReport(): Promise<boolean> {
    const text = reportText.trim();
    if (!text || reportBusy) return false;
    setReportBusy("save");
    try {
      applySession((await client.saveReport(jobId, text)).session, true);
      setBanner(null);
      return true;
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: () => void saveReport() });
      return false;
    } finally {
      setReportBusy(null);
    }
  }

  async function approveReport() {
    const text = reportText.trim();
    if (!text || reportBusy) return;
    setReportBusy("approve");
    try {
      // The server only approves the saved draft, so unsaved edits are saved first.
      let saved = session?.reportDraft ?? "";
      if (reportDirtyRef.current || text !== saved.trim()) {
        saved = (await client.saveReport(jobId, text)).report;
      }
      applySession((await client.approveReport(jobId, saved)).session, true);
      setBanner(null);
    } catch (error) {
      setBanner({ message: errorMessage(error), retry: () => void approveReport() });
    } finally {
      setReportBusy(null);
    }
  }

  if (load === "loading") {
    return <Spinner label="Opening job…" />;
  }
  if (load === "not-found") {
    return (
      <EmptyState
        title="Job not found"
        body="This job does not exist on the server. It may have been removed, or the link is wrong."
        action={<LinkButton href="/">Back to jobs</LinkButton>}
      />
    );
  }
  if (load === "error" || !session || !job) {
    return (
      <div className="flex flex-col gap-4">
        <Banner
          action={
            <Button variant="secondary" onClick={() => void refresh(false)}>
              Retry
            </Button>
          }
        >
          This job could not be loaded. {loadError}
        </Banner>
        <Link href="/" className="text-base font-semibold underline">
          Back to jobs
        </Link>
      </div>
    );
  }

  const approvedAt = session.reportApprovedAt && !reportDirty ? session.reportApprovedAt : null;
  const sourcesFor = (ids: string[]) => ids.map((id) => passages[id]).filter((item): item is ManualPassage => Boolean(item));
  const latestAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  const latestSources = sourcesFor(latestAssistant?.sources ?? []);
  const shown = (name: Tab) => (tab === name ? "flex" : "hidden lg:flex");
  const linkInfo = LINK_LABEL[link];
  const equipmentRows: Array<[string, string | undefined]> = [
    ["Manufacturer", job.equipment.manufacturer],
    ["Model", job.equipment.model],
    ["Serial", job.equipment.serial],
    ["Type", job.equipment.type],
    ["Location / notes", job.equipment.notes],
    ["Service history", job.serviceHistory],
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="amber">{job.trade}</Badge>
              <span className="text-sm text-muted">Created {stamp(job.createdAt)}</span>
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight break-words sm:text-2xl">{job.reportedProblem}</h1>
            <p className="text-sm text-muted">Reported problem</p>
          </div>
          <div className="flex flex-col items-end gap-1" role="status" aria-live="polite">
            <Badge tone={linkInfo.tone}>{linkInfo.text}</Badge>
            <span className="text-sm text-muted">
              Revision {session.revision} · {clock(session.updatedAt)}
            </span>
          </div>
        </div>
        <details className="group rounded-[13px] border border-line bg-surface-2 px-4 py-3 lg:open:block" open={undefined}>
          <summary className="min-h-11 cursor-pointer text-base font-semibold leading-[2.75rem]">Equipment and details</summary>
          <dl className="grid gap-3 pb-1 sm:grid-cols-2 lg:grid-cols-3">
            {equipmentRows.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className={`text-base break-words ${value ? "" : "text-muted"}`}>{value || "Not provided"}</dd>
              </div>
            ))}
          </dl>
        </details>
      </Card>

      {banner ? (
        <Banner
          action={
            banner.retry ? (
              <Button variant="secondary" onClick={banner.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {banner.message}
        </Banner>
      ) : null}

      <div className="lg:hidden">
        <SegmentedTabs
          label="Job sections"
          value={tab}
          onChange={setTab}
          options={[
            { id: "voice", label: "Voice" },
            { id: "findings", label: "Findings" },
            { id: "report", label: "Report" },
          ]}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section id="panel-voice" role="tabpanel" aria-label="Voice and conversation" className={`${shown("voice")} min-w-0 flex-col gap-4`}>
          <VoicePanel controller={voiceController} camera={cameraController} onConfirmProposal={(id) => void confirmProposal(id)} confirmingProposal={confirmingProposal} />
          <Card className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Conversation</h2>
            <div ref={logRef} className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto" role="log" aria-live="polite" aria-relevant="additions">
              {log.length === 0 ? <p className="text-base text-muted">No conversation yet. Tap Talk to TechyBuddy or type a question below.</p> : null}
              {log.map((message) => {
                const mine = message.role === "user";
                const cited = sourcesFor(message.sources);
                return (
                  <article key={message.id} className={mine ? "ml-auto max-w-[85%]" : "max-w-[92%]"}>
                    <p className="mb-1 text-sm text-muted">
                      {mine ? "You" : "Techybuddy"}
                      {"spoken" in message ? " (voice)" : ""} · {clock(message.createdAt)}
                    </p>
                    <div className={`rounded-[16px] px-4 py-2.5 text-base leading-relaxed break-words ${mine ? "bg-ink text-white" : "bg-surface-2 text-ink border border-line"}`}>{message.text}</div>
                    {cited.map((passage) => (
                      <SourceCard key={passage.id} passage={passage} />
                    ))}
                  </article>
                );
              })}
            </div>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void ask(draft);
              }}
            >
              <label className="sr-only" htmlFor="question">
                Type a question
              </label>
              <input
                id="question"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type a question"
                className="min-h-12 flex-1 rounded-[13px] border border-line-strong bg-surface px-3.5 text-base placeholder:text-muted/70"
                maxLength={2000}
              />
              <Button type="submit" disabled={sending || !draft.trim()}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </form>
          </Card>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <section id="panel-findings" role="tabpanel" aria-label="Documentation, findings and checks" className={`${shown("findings")} flex-col gap-4`}>
            <Card className="flex flex-col gap-2" aria-labelledby="docs-heading">
              <h2 id="docs-heading" className="text-lg font-semibold">
                Documentation
              </h2>
              {latestSources.length ? (
                latestSources.map((passage) => <SourceCard key={passage.id} passage={passage} />)
              ) : (
                <p className="text-base text-muted">{job.documentation.status === "available" ? "Documentation citations appear here when the assistant uses them." : job.documentation.message || "Verified equipment documentation unavailable."}</p>
              )}
            </Card>

            <Card className="flex flex-col gap-3" aria-labelledby="findings-heading">
              <h2 id="findings-heading" className="text-lg font-semibold">
                Confirmed findings
              </h2>
              <ul className="flex flex-col gap-2">
                {session.findings.length === 0 ? <li className="text-base text-muted">No confirmed findings yet.</li> : null}
                {session.findings.map((finding) => (
                  <li key={finding.id} className="rounded-[13px] border border-line bg-surface-2 px-3 py-2.5">
                    <p className="text-base break-words">{finding.text}</p>
                    <p className="text-sm text-muted">Confirmed {clock(finding.confirmedAt)}</p>
                  </li>
                ))}
              </ul>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmFinding();
                }}
              >
                <Textarea label="Record a finding you observed" value={findingText} onChange={(event) => setFindingText(event.target.value)} rows={2} maxLength={1000} />
                <Button type="submit" disabled={savingFinding || !findingText.trim()}>
                  {savingFinding ? "Saving…" : "Confirm finding"}
                </Button>
              </form>
            </Card>

            <Card className="flex flex-col gap-3" aria-labelledby="checks-heading">
              <h2 id="checks-heading" className="text-lg font-semibold">
                Checks performed
              </h2>
              <ul className="flex flex-col gap-2">
                {session.completedSteps.length === 0 ? <li className="text-base text-muted">No checks recorded yet.</li> : null}
                {session.completedSteps.map((step) => (
                  <li key={step.id} className="rounded-[13px] border border-line bg-surface-2 px-3 py-2.5">
                    <p className="text-base break-words">{step.description ?? step.stepId}</p>
                    {step.result ? <p className="text-base break-words text-good">Result: {step.result}</p> : null}
                    <p className="text-sm text-muted">Confirmed {clock(step.confirmedAt)}</p>
                  </li>
                ))}
              </ul>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmCheck();
                }}
              >
                <Input label="What did you check?" value={checkText} onChange={(event) => setCheckText(event.target.value)} maxLength={500} />
                <Input label="Result (optional)" value={checkResult} onChange={(event) => setCheckResult(event.target.value)} maxLength={500} />
                <Button type="submit" variant="secondary" disabled={savingCheck || !checkText.trim()}>
                  {savingCheck ? "Saving…" : "Confirm check"}
                </Button>
              </form>
              {session.unresolvedQuestions.length ? (
                <div>
                  <h3 className="text-base font-semibold">Unresolved questions</h3>
                  <ul className="mt-1 list-disc pl-5 text-base">
                    {session.unresolvedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          </section>
        </div>
      </div>

      <section id="panel-report" role="tabpanel" aria-label="Service report" className={`${shown("report")} flex-col`}>
        <Card className="flex flex-col gap-3" aria-labelledby="report-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="report-heading" className="text-xl font-semibold">
                Service report
              </h2>
              <p className="text-sm text-muted">Built from confirmed findings and checks. Edit it, save it, then approve it.</p>
            </div>
            {approvedAt ? <Badge tone="good">Approved by technician at {stamp(approvedAt)}</Badge> : <Badge tone="amber">Draft — not approved</Badge>}
          </div>
          <Textarea
            label="Report text"
            value={reportText}
            onChange={(event) => setReport(event.target.value)}
            rows={12}
            maxLength={20000}
            placeholder="Generate a draft or write the report here."
            className="leading-relaxed"
          />
          <p className="text-sm text-muted" aria-live="polite">
            {reportDirty ? "Unsaved edits. Approval is cleared until you save and approve again." : session.reportDraft ? "Saved." : "Nothing saved yet."}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button variant="secondary" onClick={() => void generateReport()} disabled={reportBusy !== null}>
              {reportBusy === "generate" ? "Generating…" : "Generate draft"}
            </Button>
            <Button variant="secondary" onClick={() => void saveReport()} disabled={!reportDirty || reportBusy !== null || !reportText.trim()}>
              {reportBusy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button variant="accent" onClick={() => void approveReport()} disabled={reportBusy !== null || !reportText.trim() || Boolean(approvedAt)}>
              {reportBusy === "approve" ? "Approving…" : approvedAt ? "Approved" : "Approve report"}
            </Button>
            {reportDirty ? (
              <Button
                variant="secondary"
                onClick={() => {
                  reportDirtyRef.current = false;
                  setReportDirty(false);
                  setReportText(session.reportDraft);
                }}
              >
                Discard edits
              </Button>
            ) : null}
          </div>
        </Card>
      </section>
    </div>
  );
}

/** Real citation card. Only rendered for passages the server returned with document metadata. */
function SourceCard({ passage }: { passage: ManualPassage }) {
  return (
    <article className="mt-2 rounded-[13px] border border-line bg-surface px-3 py-2.5">
      <p className="text-sm font-semibold">
        {passage.manufacturer} · {passage.title} · page {passage.page} · {passage.section}
      </p>
      <p className="mt-1 text-base leading-relaxed break-words">{passage.text}</p>
      {passage.sourceUrl ? <p className="mt-1 text-sm break-all text-muted">{passage.sourceUrl}</p> : null}
    </article>
  );
}
