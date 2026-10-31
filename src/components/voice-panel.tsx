"use client";

import { useState, useSyncExternalStore } from "react";
import type { VoiceController, VoiceSnapshot, VoiceState } from "../frontend/realtime-voice";
import type { CameraController } from "../frontend/camera";
import { CameraControls, useCameraSnapshot } from "./camera-panel";
import { Banner, Button } from "./ui";

const EMPTY: VoiceSnapshot = { state: "idle", captions: [], proposals: [], error: null, notice: null, saveWarning: null, brief: null };

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Voice is off",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Voice unavailable",
};

const STATE_HINT: Record<VoiceState, string> = {
  idle: "Tap the button and speak. Typing always works too.",
  connecting: "Opening the microphone and a secure voice connection.",
  listening: "Go ahead. You can interrupt at any time.",
  thinking: "Working on a reply.",
  speaking: "Talk over it, or tap Interrupt.",
  error: "Voice stopped. Typing still works.",
};

/** Shared by the workspace and the panel so both read one snapshot. */
export function useVoiceSnapshot(controller: VoiceController | null): VoiceSnapshot {
  return useSyncExternalStore(
    controller ? controller.subscribe : () => () => undefined,
    controller ? controller.getSnapshot : () => EMPTY,
    () => EMPTY,
  );
}

type Props = {
  controller: VoiceController;
  camera: CameraController;
  /** Saves a suggested finding through the idempotent findings route. */
  onConfirmProposal: (id: string) => void;
  confirmingProposal: string | null;
};

export function VoicePanel({ controller, camera, onConfirmProposal, confirmingProposal }: Props) {
  const voice = useVoiceSnapshot(controller);
  const cameraState = useCameraSnapshot(camera);
  const [starting, setStarting] = useState(false);
  const active = voice.state === "connecting" || voice.state === "listening" || voice.state === "thinking" || voice.state === "speaking";

  async function toggle() {
    if (voice.state === "speaking") {
      controller.interrupt();
      return;
    }
    if (active || starting) return;
    setStarting(true);
    try {
      await controller.start();
    } finally {
      setStarting(false);
    }
  }

  const buttonLabel = voice.state === "speaking" ? "Interrupt" : voice.state === "connecting" ? "Connecting…" : active ? STATE_LABEL[voice.state] : "Talk to TechyBuddy";
  const buttonDisabled = voice.state === "connecting" || voice.state === "listening" || voice.state === "thinking";

  return (
    <div className="flex flex-col gap-4" aria-label="Voice conversation">
      <div className="flex flex-col items-center gap-4 rounded-[18px] border border-line bg-surface px-4 py-6 text-center shadow-[0_24px_70px_oklch(0.18_0_0/0.10)] sm:flex-row sm:text-left">
        <div className="relative flex h-40 w-40 shrink-0 items-center justify-center">
          {voice.state === "listening" ? <span className="mic-ring absolute inset-3 rounded-full border-4 border-amber" aria-hidden="true" /> : null}
          {voice.state === "thinking" || voice.state === "connecting" ? (
            <span className="think-ring absolute inset-2 rounded-full border-4 border-dashed border-line-strong" aria-hidden="true" />
          ) : null}
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={buttonDisabled}
            aria-label={active ? `Voice conversation: ${STATE_LABEL[voice.state]}` : "Talk to TechyBuddy"}
            className="relative z-10 flex h-32 w-32 items-center justify-center rounded-full bg-amber px-3 text-center text-lg leading-tight font-semibold text-amber-ink transition disabled:opacity-90"
          >
            {buttonLabel}
          </button>
        </div>
        <div className="w-full" aria-live="polite">
          <p className="text-xl font-semibold" data-testid="voice-status">
            {STATE_LABEL[voice.state]}
          </p>
          <p className="text-base text-muted">{STATE_HINT[voice.state]}</p>
          {voice.state === "speaking" ? (
            <div className="mt-2 flex h-8 items-end justify-center gap-1 sm:justify-start" aria-hidden="true">
              {[0, 1, 2, 3].map((bar) => (
                <span key={bar} className="speak-bar h-8 w-2 rounded-full bg-amber" style={{ animationDelay: `${bar * 0.12}s` }} />
              ))}
            </div>
          ) : null}
          {voice.notice ? <p className="rise-in mt-2 text-base font-semibold text-amber-ink">{voice.notice}</p> : null}
        </div>
      </div>

      <div className="rounded-[18px] border border-line bg-surface p-4">
        <CameraControls
          camera={camera}
          voiceActive={voice.state === "listening" || voice.state === "thinking" || voice.state === "speaking"}
          anythingRunning={active || cameraState.preview !== "off" || cameraState.recording}
          onStopAll={() => {
            camera.stopAll();
            void controller.stop();
          }}
        />
      </div>

      {voice.error ? (
        <div data-testid="voice-error">
          <Banner
            action={
              voice.error.retryable ? (
                <Button variant="secondary" onClick={() => void controller.start()}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {voice.error.message}
          </Banner>
        </div>
      ) : null}

      {voice.proposals.map((proposal) => (
        <div key={proposal.id} className="rise-in rounded-[18px] border border-amber/60 bg-amber-soft p-4" role="group" aria-label="AI suggested finding">
          <p className="text-sm font-semibold tracking-wide text-amber-ink uppercase">AI suggests recording this finding</p>
          <p className="mt-1 text-base break-words">{proposal.text}</p>
          <p className="mt-1 text-sm text-muted">Nothing is saved until you confirm it matches what you observed.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button variant="primary" onClick={() => onConfirmProposal(proposal.id)} disabled={confirmingProposal === proposal.id}>
              {confirmingProposal === proposal.id ? "Saving…" : "Confirm"}
            </Button>
            <Button variant="secondary" onClick={() => controller.removeProposal(proposal.id)} disabled={confirmingProposal === proposal.id}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}

      {voice.captions.length ? (
        <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-surface p-4" role="log" aria-live="polite" aria-label="Live captions">
          <p className="text-sm font-semibold tracking-wide text-muted uppercase">Live captions</p>
          {voice.captions.map((caption) => (
            <p key={caption.id} className={`text-base leading-relaxed break-words ${caption.final ? "text-ink" : "text-muted"}`}>
              <span className="font-semibold text-amber-ink">{caption.role === "user" ? "You" : "TechyBuddy"}: </span>
              {caption.text}
              {caption.interrupted && caption.role === "assistant" ? <span className="text-sm text-muted"> (interrupted)</span> : null}
            </p>
          ))}
        </div>
      ) : null}

      {voice.saveWarning ? <p className="text-sm text-muted">{voice.saveWarning}</p> : null}
    </div>
  );
}
