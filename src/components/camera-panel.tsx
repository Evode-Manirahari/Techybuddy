"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { MAX_FRAMES_PER_RECORDING, MAX_RECORDING_SEC, RECORDING_AUDIO_NOTE, type CameraController, type CameraSnapshot } from "../frontend/camera";
import { Banner, Button } from "./ui";

const EMPTY: CameraSnapshot = { preview: "off", stream: null, recording: false, elapsedSec: 0, framesShared: 0, photos: [], clip: null, error: null, notice: null };

export function useCameraSnapshot(controller: CameraController): CameraSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => EMPTY);
}

function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function megabytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

const icon = "h-5 w-5 shrink-0";

function CameraIcon() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

type Props = {
  camera: CameraController;
  /** True while the Realtime session is connected, so images can really reach the AI. */
  voiceActive: boolean;
  /** Anything running at all: voice, preview or recording. Enables Stop. */
  anythingRunning: boolean;
  onStopAll: () => void;
};

/** The Camera, Record and Stop controls (Talk lives in the voice panel) plus the real preview, photos and clip. */
export function CameraControls({ camera, voiceActive, anythingRunning, onStopAll }: Props) {
  const state = useCameraSnapshot(camera);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep the on-screen <video> and the controller in sync with the real stream.
  useEffect(() => {
    const element = videoRef.current;
    camera.setVideoElement(element);
    if (element && element.srcObject !== state.stream) element.srcObject = state.stream;
    return () => camera.setVideoElement(null);
  }, [camera, state.stream, state.preview]);

  const previewOn = state.preview === "on";
  const starting = state.preview === "starting";

  let status: ReactNode;
  if (state.recording) {
    status = (
      <>
        Recording <span className="font-semibold tabular-nums">{clock(state.elapsedSec)}</span> of {clock(MAX_RECORDING_SEC)}.{" "}
        {voiceActive
          ? `Frames sent to the AI: ${state.framesShared} of ${MAX_FRAMES_PER_RECORDING} (one about every 5 seconds).`
          : "Voice is off, so no frames are sent to the AI."}
      </>
    );
  } else if (starting) {
    status = "Opening the camera. Allow access if the browser asks.";
  } else if (previewOn) {
    status = voiceActive ? "Camera is on. Tap Take photo to show the AI what you see." : "Camera is on. Start Talk first if you want the AI to see photos.";
  } else {
    status = "Camera is off.";
  }

  return (
    <div className="flex flex-col gap-3" aria-label="Camera controls">
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        <Button
          variant={previewOn ? "accent" : "secondary"}
          onClick={() => void camera.camera()}
          disabled={starting}
          aria-pressed={previewOn}
          aria-label={previewOn ? "Take photo" : "Camera"}
          className="flex-col gap-0.5 px-2 text-sm sm:flex-row sm:gap-2 sm:px-5 sm:text-base"
          data-testid="camera-button"
        >
          <CameraIcon />
          {starting ? "Opening…" : previewOn ? "Take photo" : "Camera"}
        </Button>
        <Button
          variant={state.recording ? "danger" : "secondary"}
          onClick={() => void camera.record()}
          disabled={state.recording || starting}
          aria-pressed={state.recording}
          aria-label={state.recording ? `Recording ${clock(state.elapsedSec)}` : "Record"}
          title={state.recording ? "Recording. Tap Stop to finish." : undefined}
          className="flex-col gap-0.5 px-2 text-sm sm:flex-row sm:gap-2 sm:px-5 sm:text-base"
          data-testid="record-button"
        >
          <RecordIcon />
          <span className="tabular-nums">{state.recording ? clock(state.elapsedSec) : "Record"}</span>
        </Button>
        <Button
          variant="primary"
          onClick={onStopAll}
          disabled={!anythingRunning}
          title={anythingRunning ? "Stops voice, recording and camera" : "Nothing is running"}
          className="flex-col gap-0.5 px-2 text-sm sm:flex-row sm:gap-2 sm:px-5 sm:text-base"
          data-testid="stop-button"
        >
          <StopIcon />
          Stop
        </Button>
      </div>

      <p className="text-base text-muted" role="status" aria-live="polite" data-testid="camera-status">
        {status}
      </p>
      {state.notice ? (
        <Banner tone="amber">
          <span data-testid="camera-notice">{state.notice}</span>
        </Banner>
      ) : null}
      {state.error ? (
        <div data-testid="camera-error">
          <Banner
            action={
              state.error.retryable ? (
                <Button variant="secondary" onClick={() => void (state.error?.kind === "recorder" ? camera.record() : camera.camera())}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {state.error.message}
          </Banner>
        </div>
      ) : null}

      {previewOn ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Live camera preview"
          className="aspect-video max-h-[60dvh] w-full rounded-[13px] bg-black object-contain"
          data-testid="camera-preview"
        />
      ) : null}
      {state.recording ? <p className="text-sm text-muted">{RECORDING_AUDIO_NOTE}</p> : null}

      {state.photos.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Photos taken in this tab">
          {state.photos.map((photo) => (
            <li key={photo.id} className="min-w-0 rounded-[13px] border border-line bg-surface-2 p-2" data-testid="photo-item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.dataUrl} alt={`Photo taken at ${time(photo.takenAt)}`} className="aspect-[4/3] w-full rounded-[10px] bg-black object-contain" />
              <p className="mt-1 text-sm font-semibold text-ink">{photo.sharedAt ? `Shown to AI at ${time(photo.sharedAt)}` : "Not shown to AI"}</p>
              <p className="text-xs text-muted">
                {photo.sharedAt ? `${photo.width}×${photo.height}, ${megabytes(photo.bytes)}` : `Taken ${time(photo.takenAt)}, on this screen only`}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {state.clip ? (
        <div className="flex flex-col gap-2 rounded-[13px] border border-line bg-surface-2 p-3" data-testid="clip">
          <p className="text-sm font-semibold tracking-wide text-muted uppercase">Recorded clip</p>
          <video src={state.clip.url} controls playsInline className="aspect-video max-h-[60dvh] w-full rounded-[10px] bg-black" aria-label="Recorded clip" />
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={state.clip.url}
              download={state.clip.filename}
              className="inline-flex min-h-11 items-center justify-center rounded-[13px] border border-line-strong bg-surface px-5 text-base font-semibold text-ink hover:bg-surface-2"
            >
              Download clip
            </a>
            <span className="text-sm text-muted">
              {clock(state.clip.durationSec)} · {megabytes(state.clip.bytes)} · {state.clip.mimeType}
            </span>
          </div>
        </div>
      ) : null}

      <p className="text-sm text-muted">
        Photos and clips stay in this browser tab only. They are not uploaded or saved to the job and are gone when you leave or reload. A photo you take while Talk is on is sent to the AI over the live voice session.
      </p>
    </div>
  );
}
