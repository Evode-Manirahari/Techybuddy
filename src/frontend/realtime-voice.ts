import type { OpenAIRealtimeWebRTC, RealtimeItem, RealtimeSession, RealtimeSessionConfig } from "@openai/agents/realtime";
import { z } from "zod";

/** Loaded on first use so the SDK never runs during server rendering and stays out of the first paint. */
type Sdk = typeof import("@openai/agents/realtime");
import type { JobBrief, ManualPassage } from "../lib/types";

export type { JobBrief };

/**
 * Browser controller around the official OpenAI Agents SDK realtime classes.
 * - The browser only ever holds a short-lived `ek_...` client secret minted by our backend.
 * - The microphone stream is opened here (not by the SDK) so stop() can prove every track ended.
 * - Tools run in the browser but only call job-scoped backend routes with the page's jobId.
 *   The model never supplies a job id, and `propose_finding` never writes anything.
 */

export type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export type VoiceErrorKind =
  | "unsupported"
  | "mic-denied"
  | "mic-missing"
  | "mic-failed"
  | "missing-key"
  | "auth"
  | "job"
  | "token"
  | "connect-timeout"
  | "connection"
  | "session";

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly kind: VoiceErrorKind,
    /** Retry can only help when the cause is transient or user-fixable. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export type Caption = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** False while the transcript is still streaming in. */
  final: boolean;
  /** True when the technician talked over the assistant and the reply was cut off. */
  interrupted: boolean;
  /** True once the backend acknowledged this turn. */
  saved: boolean;
  createdAt: string;
};

/** A suggestion from the model. Nothing is recorded until the technician confirms it. */
export type FindingProposal = {
  id: string;
  text: string;
  /** Reused on retry so a repeated confirm cannot create a duplicate finding. */
  idempotencyKey: string;
  createdAt: string;
};

/** What POST /api/realtime/token returns (agreed with the backend over Agent Relay). */
export type RealtimeGrant = {
  /** Short-lived ek_ client secret. TTL is 600 seconds and it is used once, at connect. */
  value: string;
  expiresAt?: number | null;
  model: string;
  /** Server-built job instructions. The SDK re-sends them on connect, so the agent must use this string. */
  instructions: string;
  /** Browser-SDK session config (transcription, turn detection, voice) mirrored from what the server minted. */
  sessionConfig?: Record<string, unknown>;
  job?: JobBrief | null;
};

/** One voice turn in the batch posted to POST /api/jobs/:jobId/transcript (max 20 per request, idempotent by id). */
export type TranscriptPost = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  /** The reply was cut off by the technician. */
  interrupted?: boolean;
};
const MAX_BATCH = 20;

/** Network side of voice. The live implementation lives in live-client.ts. */
export type VoiceBackend = {
  mintToken(jobId: string): Promise<RealtimeGrant>;
  searchManual(jobId: string, query: string): Promise<ManualPassage[]>;
  saveTranscript(jobId: string, turns: TranscriptPost[]): Promise<void>;
};

export type VoiceSnapshot = {
  state: VoiceState;
  captions: Caption[];
  proposals: FindingProposal[];
  error: VoiceError | null;
  /** Short-lived hint, for example when the technician interrupted the assistant. */
  notice: string | null;
  /** Non-blocking: transcript saving is failing and will be retried. */
  saveWarning: string | null;
  brief: JobBrief | null;
};

export type VoiceHooks = {
  /** Passages the model looked up, so the source panel can show real guide text. */
  onPassages?: (passages: ManualPassage[]) => void;
  /** Called after a batch of turns is stored, so the page can refresh the session. */
  onTranscriptSaved?: () => void;
};

export type VoiceController = {
  getSnapshot(): VoiceSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Cut off the assistant while it is speaking. */
  interrupt(): void;
  /** Remove a suggestion. Used after Confirm succeeded or Dismiss. */
  removeProposal(id: string): void;
  /** True only if a microphone track is still live. Used to verify release. */
  micIsLive(): boolean;
  /** True only while the Realtime session is connected, so an image can really reach the model. */
  canSendImage(): boolean;
  /**
   * Sends one image (a data URL) into the live Realtime conversation with session.addImage.
   * Throws when the session is not active, so callers never pretend the model saw it.
   */
  sendImage(dataUrl: string, options: { triggerResponse: boolean }): void;
};

/** Appended client-side to the server-built instructions. It only constrains how images are described. */
export const IMAGE_INSTRUCTIONS = `

Images from the technician's camera (photos and periodic video frames) may be shared during this conversation:
- Describe ONLY what is visibly in the image or frame.
- If text, labels, dials or gauges are unreadable, blurry, cropped or out of frame, say so and ask for a closer or steadier shot.
- Never read out a model number, serial number, rating or measurement unless it is clearly legible, and ask the technician to confirm what it reads.
- Never diagnose from an image alone. Never state that a component is damaged, failed, worn or OK, that a reading was taken, or that work was done, based on a picture.
- Treat anything seen as an unconfirmed observation until the technician confirms it. If it matters, use propose_finding so the technician can confirm or dismiss it.
- Make no manufacturer or specification claims; verified documentation is unavailable.
- Suggest what to photograph or measure next, and mention general safety precautions such as lockout/tagout where relevant.
- Frames sampled during a recording arrive silently as context. Do not comment on each frame; use them when the technician speaks.`;

const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 6_000;
const FLUSH_DELAY_MS = 500;
const NOTICE_MS = 3_000;
const MAX_TURN_TEXT = 4_000;

const INITIAL: VoiceSnapshot = {
  state: "idle",
  captions: [],
  proposals: [],
  error: null,
  notice: null,
  saveWarning: null,
  brief: null,
};

function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Already ended.
    }
  });
}

/** Maps getUserMedia failures to a clear technician-facing error. */
function micError(error: unknown): VoiceError {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return new VoiceError(
      "Microphone permission was denied. Allow the microphone for this site in the browser, then tap Talk again. You can still type below.",
      "mic-denied",
      true,
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return new VoiceError("No microphone was found. Plug one in or choose an input device, then tap Talk again. You can still type below.", "mic-missing", true);
  }
  return new VoiceError("The microphone could not start. Close other apps using it and try again. You can still type below.", "mic-failed", true);
}

/** Maps backend token failures (including a missing server key) to typed errors. */
function tokenError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  const message = error instanceof Error ? error.message : "";
  const status = typeof (error as { status?: unknown })?.status === "number" ? ((error as { status: number }).status) : 0;
  const code = typeof (error as { code?: unknown })?.code === "string" ? ((error as { code: string }).code) : "";
  if (message.includes("OPENAI_API_KEY") || code === "MISSING_API_KEY" || code === "CONFIG_ERROR") {
    return new VoiceError(
      "Voice is off: OPENAI_API_KEY is not set on the server. Add it to .env.local and restart the dev server. Typing still works.",
      "missing-key",
      false,
    );
  }
  if (status === 404 || code === "JOB_NOT_FOUND") {
    return new VoiceError(message || "This job was not found, so voice cannot start.", "job", false);
  }
  if (status === 401 || status === 403 || code === "UNAUTHORIZED" || code === "FORBIDDEN") {
    return new VoiceError(message || "Voice was not authorized for this job.", "auth", false);
  }
  if (status === 0 || code === "NETWORK" || code === "TIMEOUT") {
    return new VoiceError(message || "Could not reach the Techybuddy server to start voice.", "token", true);
  }
  return new VoiceError(message || "Voice could not get a session token from the server. Try again.", "token", true);
}

/** Maps SDK or WebRTC failures during or after connect. */
function connectError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/401|403|unauthor|invalid[_ ]?api|incorrect api|expired|ek_/i.test(raw)) {
    return new VoiceError("OpenAI rejected the voice token (it may have expired). Tap Retry to get a fresh one.", "auth", true);
  }
  return new VoiceError(
    raw ? `Voice connection failed: ${raw.slice(0, 200)}` : "Voice connection failed. Check your network and tap Retry.",
    "connection",
    true,
  );
}

/** Reads a transcript from an SDK history item. */
function textOf(item: RealtimeItem): string {
  if (item.type !== "message") return "";
  const parts: string[] = [];
  for (const part of item.content as Array<{ type: string; text?: string; transcript?: string | null }>) {
    if (part.type === "input_text" || part.type === "output_text") parts.push(part.text ?? "");
    else if (part.type === "input_audio" || part.type === "output_audio") parts.push(part.transcript ?? "");
  }
  return parts.join(" ").trim();
}

export function createRealtimeVoice(options: { jobId: string; backend: VoiceBackend; hooks?: VoiceHooks }): VoiceController {
  const { jobId, backend, hooks } = options;
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = INITIAL;

  let session: RealtimeSession | null = null;
  let transport: OpenAIRealtimeWebRTC | null = null;
  let stream: MediaStream | null = null;
  let audio: HTMLAudioElement | null = null;
  /** Incremented on every start/stop so stale async work can detect it was cancelled. */
  let generation = 0;
  let closing = false;

  const firstSeen = new Map<string, string>();
  const interruptedItems = new Set<string>();
  /** Item id -> text length the backend acknowledged. Re-sent only if the text grew (backend updates on longer text). */
  const saved = new Map<string, number>();
  /** User item ids whose input transcription finished. */
  const transcribed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHistory: RealtimeItem[] = [];
  let assistantAudio = false;

  function set(patch: Partial<VoiceSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }

  function flash(message: string) {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  }

  function setState(state: VoiceState) {
    if (snapshot.state === "error" || snapshot.state === "idle") return;
    if (snapshot.state !== state) set({ state });
  }

  function fail(error: VoiceError) {
    // A deliberate stop() or an already reported error wins over follow-up noise.
    if (closing || snapshot.state === "error") return;
    void teardown();
    set({ state: "error", error, notice: null });
  }

  /** Closes the session and releases the microphone. Safe to call repeatedly. */
  async function teardown() {
    generation += 1;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = null;
    const activeSession = session;
    const activeTransport = transport;
    const activeStream = stream;
    const activeAudio = audio;
    session = null;
    transport = null;
    stream = null;
    audio = null;
    // Stop tracks the peer connection still holds, then our own stream, then the session itself.
    try {
      activeTransport?.connectionState.peerConnection?.getSenders().forEach((sender) => sender.track?.stop());
    } catch {
      // Peer connection already closed.
    }
    stopStream(activeStream);
    try {
      activeSession?.close();
    } catch {
      // Closing an unopened or closed session is fine.
    }
    stopStream(activeStream);
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.srcObject = null;
    }
  }

  /** Final turns not yet stored. Idempotent by item id on the backend, so a turn is sent once. */
  function pendingTurns(history: RealtimeItem[], includePartial: boolean): TranscriptPost[] {
    const turns: TranscriptPost[] = [];
    for (const item of history) {
      if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) continue;
      const text = textOf(item).slice(0, MAX_TURN_TEXT);
      if (!text || (saved.get(item.itemId) ?? 0) >= text.length) continue;
      const done = item.status === "completed" || item.status === "incomplete";
      // A user transcript streams in; only the completed transcription event makes it final.
      const final = item.role === "user" ? transcribed.has(item.itemId) : done;
      if (!final && !includePartial) continue;
      const cut = interruptedItems.has(item.itemId) || item.status === "incomplete" || (!done && item.role === "assistant");
      turns.push({ id: item.itemId, role: item.role, text, createdAt: firstSeen.get(item.itemId), ...(cut && item.role === "assistant" ? { interrupted: true } : {}) });
    }
    return turns;
  }

  async function flush(includePartial: boolean) {
    // Serialize so overlapping history updates cannot race each other.
    while (flushing) await flushing.catch(() => undefined);
    const turns = pendingTurns(lastHistory, includePartial);
    if (!turns.length) return;
    flushing = (async () => {
      let stored = 0;
      try {
        for (let at = 0; at < turns.length; at += MAX_BATCH) {
          const batch = turns.slice(at, at + MAX_BATCH);
          await backend.saveTranscript(jobId, batch);
          for (const turn of batch) saved.set(turn.id, turn.text.length);
          stored += batch.length;
        }
        set({ saveWarning: null });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        set({ saveWarning: `The conversation transcript could not be saved yet (${reason}). It will retry after the next turn.` });
      }
      if (stored) {
        set({ captions: buildCaptions(lastHistory) });
        hooks?.onTranscriptSaved?.();
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(false), FLUSH_DELAY_MS);
  }

  function buildCaptions(history: RealtimeItem[]): Caption[] {
    const captions: Caption[] = [];
    for (const item of history) {
      if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) continue;
      const text = textOf(item);
      const done = item.status === "completed" || item.status === "incomplete";
      const isSaved = saved.has(item.itemId) && (done || item.role === "user");
      // Saved turns appear in the conversation log from the session, so captions show only pending text.
      if (isSaved) continue;
      if (!text && item.role === "assistant") continue;
      // Background noise can open a user turn whose transcription comes back empty. Do not show a ghost caption.
      if (!text && transcribed.has(item.itemId)) continue;
      captions.push({
        id: item.itemId,
        role: item.role,
        text: text || "…",
        final: done && Boolean(text),
        interrupted: interruptedItems.has(item.itemId) || item.status === "incomplete",
        saved: false,
        createdAt: firstSeen.get(item.itemId) ?? new Date().toISOString(),
      });
    }
    return captions.slice(-4);
  }

  function onHistory(history: RealtimeItem[]) {
    lastHistory = history;
    const now = new Date().toISOString();
    for (const item of history) if (!firstSeen.has(item.itemId)) firstSeen.set(item.itemId, now);
    set({ captions: buildCaptions(history) });
    scheduleFlush();
  }

  function buildTools(sdk: Sdk) {
    const { tool } = sdk;
    const searchManual = tool({
      name: "search_manual",
      description: "Search verified equipment documentation for this job. Usually returns nothing because no verified documentation is loaded. Never invent a manual or a page number.",
      parameters: z.object({ query: z.string().min(2).max(300) }),
      async execute({ query }) {
        try {
          const passages = await backend.searchManual(jobId, query);
          hooks?.onPassages?.(passages);
          if (!passages.length) return "Verified equipment documentation unavailable. Say so plainly; do not guess, and do not cite any manual.";
          return JSON.stringify(
            passages.slice(0, 3).map((passage) => ({ section: passage.section, page: passage.page, text: passage.text })),
          );
        } catch (error) {
          return `Documentation search failed: ${error instanceof Error ? error.message : "unknown error"}. Tell the technician documentation could not be searched.`;
        }
      },
    });

    const proposeFinding = tool({
      name: "propose_finding",
      description:
        "Suggest a finding for the technician to confirm. This only shows a Confirm/Dismiss card. It does NOT record anything. Never say a finding was recorded.",
      parameters: z.object({ text: z.string().min(2).max(500) }),
      async execute({ text }) {
        const proposal: FindingProposal = {
          id: crypto.randomUUID(),
          text: text.trim(),
          idempotencyKey: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        set({ proposals: [...snapshot.proposals, proposal] });
        return "Shown to the technician as a suggestion. It is NOT recorded until they tap Confirm. Tell them to confirm it on screen.";
      },
    });

    return [searchManual, proposeFinding];
  }

  function wire(live: RealtimeSession) {
    live.on("history_updated", onHistory);
    live.on("audio_start", () => {
      assistantAudio = true;
      setState("speaking");
    });
    live.on("audio_stopped", () => {
      assistantAudio = false;
      setState("listening");
    });
    live.on("audio_interrupted", () => {
      assistantAudio = false;
      flash("Interrupted. Listening.");
      setState("listening");
    });
    live.on("agent_tool_start", () => setState("thinking"));
    live.on("agent_tool_end", () => setState("thinking"));
    live.on("error", (event) => {
      const typed = connectError(event.error);
      fail(
        typed.kind === "auth"
          ? typed
          : new VoiceError("The voice session hit an error and was closed. Tap Retry to start a new one.", "session", true),
      );
    });
    live.on("transport_event", (event) => {
      switch (event.type) {
        case "conversation.item.input_audio_transcription.completed":
          transcribed.add(event.item_id);
          scheduleFlush();
          break;
        case "input_audio_buffer.speech_started":
          if (assistantAudio) flash("Interrupted. Listening.");
          setState("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          break;
        case "response.created":
          setState("thinking");
          break;
        // The WebRTC transport plays audio in the browser, so the SDK's own audio_start event never fires.
        // These WebRTC output-buffer events mark when the technician actually hears the assistant.
        case "output_audio_buffer.started":
          assistantAudio = true;
          setState("speaking");
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          assistantAudio = false;
          setState("listening");
          break;
        case "response.done":
          if (!assistantAudio) setState("listening");
          break;
        default:
          break;
      }
    });
  }

  async function start() {
    if (snapshot.state !== "idle" && snapshot.state !== "error") return;
    closing = false;
    assistantAudio = false;
    lastHistory = [];
    firstSeen.clear();
    interruptedItems.clear();
    saved.clear();
    transcribed.clear();
    const mine = ++generation;
    const alive = () => mine === generation && !closing;
    set({ ...INITIAL, brief: snapshot.brief, state: "connecting" });

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      set({
        state: "error",
        error: new VoiceError("This browser does not support live voice (microphone or WebRTC missing). Use a current Chrome, Edge, Safari, or Firefox over https or localhost.", "unsupported", false),
      });
      return;
    }

    try {
      // Mic and token in parallel for a faster start. The mic error wins if both fail.
      const [micResult, tokenResult, sdkResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
        backend.mintToken(jobId),
        import("@openai/agents/realtime"),
      ]);
      if (micResult.status === "fulfilled") stream = micResult.value;
      if (!alive()) {
        stopStream(stream);
        stream = null;
        return;
      }
      if (micResult.status === "rejected") throw micError(micResult.reason);
      if (tokenResult.status === "rejected") throw tokenError(tokenResult.reason);
      if (sdkResult.status === "rejected") {
        throw new VoiceError("The voice library could not load. Reload the page and try again.", "connection", true);
      }
      const sdk = sdkResult.value;
      const grant = tokenResult.value;
      if (!grant.value?.startsWith("ek_")) {
        throw new VoiceError("The server returned an invalid voice token. Tap Retry.", "token", true);
      }
      if (grant.job) set({ brief: grant.job });

      audio = new Audio();
      audio.autoplay = true;
      transport = new sdk.OpenAIRealtimeWebRTC({
        mediaStream: stream as MediaStream,
        audioElement: audio,
        changePeerConnection: (peer) => {
          peer.addEventListener("connectionstatechange", () => {
            if (disconnectTimer) clearTimeout(disconnectTimer);
            disconnectTimer = null;
            if (peer.connectionState === "failed") {
              fail(new VoiceError("The voice connection dropped. Check your network and tap Retry.", "connection", true));
            } else if (peer.connectionState === "disconnected") {
              disconnectTimer = setTimeout(
                () => fail(new VoiceError("The voice connection was lost. Check your network and tap Retry.", "connection", true)),
                DISCONNECT_GRACE_MS,
              );
            }
          });
          return peer;
        },
      });

      const agent = new sdk.RealtimeAgent({
        name: "TechyBuddy",
        // Server-built job instructions. The SDK sends these in its own session.update on connect.
        instructions: `${grant.instructions}${IMAGE_INSTRUCTIONS}`,
        tools: buildTools(sdk),
      });
      const live = new sdk.RealtimeSession(agent, {
        transport,
        model: grant.model,
        config: {
          outputModalities: ["audio"],
          ...((grant.sessionConfig ?? {}) as Partial<RealtimeSessionConfig>),
        },
      });
      session = live;
      wire(live);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          live.connect({ apiKey: grant.value }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new VoiceError("Voice did not connect within 20 seconds. Check your network and tap Retry.", "connect-timeout", true)),
              CONNECT_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!alive()) {
        await teardown();
        return;
      }
      set({ state: "listening" });
    } catch (error) {
      if (closing || mine !== generation) {
        stopStream(stream);
        return;
      }
      const typed = error instanceof VoiceError ? error : connectError(error);
      await teardown();
      set({ state: "error", error: typed, notice: null });
    }
  }

  async function stop() {
    closing = true;
    const finalHistory = session?.history ?? lastHistory;
    lastHistory = finalHistory;
    // Release the mic and close first so audio stops immediately, then persist what was said.
    await teardown();
    set({ state: "idle", error: null, notice: null });
    try {
      await flush(true);
    } catch {
      // saveWarning already set.
    }
    set({ captions: buildCaptions(lastHistory) });
    closing = false;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    interrupt() {
      if (snapshot.state !== "speaking" || !session) return;
      for (const item of lastHistory) if (item.type === "message" && item.role === "assistant" && item.status === "in_progress") interruptedItems.add(item.itemId);
      session.interrupt();
    },
    removeProposal(id) {
      set({ proposals: snapshot.proposals.filter((proposal) => proposal.id !== id) });
    },
    micIsLive() {
      return Boolean(stream?.getTracks().some((track) => track.readyState === "live"));
    },
    canSendImage() {
      return Boolean(session) && (snapshot.state === "listening" || snapshot.state === "thinking" || snapshot.state === "speaking");
    },
    sendImage(dataUrl, { triggerResponse }) {
      if (!session || !(snapshot.state === "listening" || snapshot.state === "thinking" || snapshot.state === "speaking")) {
        throw new Error("The voice session is not active.");
      }
      session.addImage(dataUrl, { triggerResponse });
    },
  };
}
