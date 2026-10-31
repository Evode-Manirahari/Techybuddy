/**
 * Browser camera for the job workspace: live preview, photos, and video recording.
 * - Everything is local to this browser tab. Nothing here talks to the Techybuddy backend.
 * - Photos and sampled recording frames reach the model only through the live Realtime session
 *   (session.addImage with a JPEG data URL). With no active session they stay local and the UI says so.
 * - The camera stream is video-only. Recording is video-only too (see RECORDING_AUDIO_NOTE).
 */

export type CameraErrorKind = "insecure" | "unsupported" | "denied" | "missing" | "in-use" | "failed" | "recorder-unsupported" | "recorder" | "send" | "capture";

export type CameraError = {
  kind: CameraErrorKind;
  message: string;
  /** Retry (re-open the camera) can plausibly help. */
  retryable: boolean;
};

export type Photo = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  /** Encoded JPEG size, in bytes (approximate, from the data URL length). */
  bytes: number;
  takenAt: string;
  /** Set only when session.addImage ran without throwing. */
  sharedAt: string | null;
};

export type Clip = {
  url: string;
  mimeType: string;
  bytes: number;
  durationSec: number;
  filename: string;
};

export type CameraSnapshot = {
  preview: "off" | "starting" | "on";
  stream: MediaStream | null;
  recording: boolean;
  elapsedSec: number;
  /** Frames sent to the model during the current or last recording. */
  framesShared: number;
  photos: Photo[];
  clip: Clip | null;
  error: CameraError | null;
  notice: string | null;
};

export type ImageSink = {
  canSendImage(): boolean;
  sendImage(dataUrl: string, options: { triggerResponse: boolean }): void;
};

export type CameraController = {
  getSnapshot(): CameraSnapshot;
  subscribe(listener: () => void): () => void;
  /** Registers the on-screen <video>. Frames are captured from it. */
  setVideoElement(element: HTMLVideoElement | null): void;
  /** First tap opens the preview; while the preview is on, each tap is the shutter. */
  camera(): Promise<void>;
  record(): Promise<void>;
  stopRecording(): void;
  /** Stops recording and the camera, and releases every track. */
  stopAll(): void;
  /** True while any camera track is live. Used to verify release. */
  cameraIsLive(): boolean;
  /** Called on unmount: stopAll plus revoking the clip URL. */
  dispose(): void;
};

export const MAX_LONG_SIDE = 1024;
export const JPEG_QUALITY = 0.7;
/** Realtime events travel over a WebRTC data channel, which has a message size limit (about 256 KB in Chrome). */
export const MAX_DATA_URL_CHARS = 200_000;
export const FRAME_INTERVAL_MS = 5_000;
export const MAX_FRAMES_PER_RECORDING = 24;
export const MAX_RECORDING_SEC = 300;
const MAX_PHOTOS = 12;
const NOTICE_MS = 5_000;

export const RECORDING_AUDIO_NOTE = "Recording is video only. Audio is not added, so it cannot disturb the live microphone used for the voice session.";

const INITIAL: CameraSnapshot = { preview: "off", stream: null, recording: false, elapsedSec: 0, framesShared: 0, photos: [], clip: null, error: null, notice: null };

function cameraError(error: unknown): CameraError {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { kind: "denied", retryable: true, message: "Camera permission was denied. Allow the camera for this site in the browser settings, then tap Camera again." };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { kind: "missing", retryable: true, message: "No camera was found on this device. Connect one, then tap Camera again." };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { kind: "in-use", retryable: true, message: "The camera is in use by another app or tab, or could not start. Close the other app and tap Camera again." };
  }
  const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 160)})` : "";
  return { kind: "failed", retryable: true, message: `The camera could not start${detail}.` };
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  const candidates = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Draws the current frame to a canvas and returns a JPEG data URL small enough for the data channel. */
function encodeFrame(video: HTMLVideoElement): { dataUrl: string; width: number; height: number } {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("The camera has no picture yet. Wait a moment and try again.");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare an image from the camera.");
  // Start at the longest side <= 1024 and only shrink further if the data URL is too big to send.
  for (const [longSide, quality] of [
    [MAX_LONG_SIDE, JPEG_QUALITY],
    [MAX_LONG_SIDE, 0.5],
    [768, 0.5],
    [640, 0.4],
  ] as const) {
    const scale = Math.min(1, longSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (!dataUrl.startsWith("data:image/jpeg")) throw new Error("This browser could not encode a JPEG image.");
    if (dataUrl.length <= MAX_DATA_URL_CHARS) return { dataUrl, width, height };
  }
  throw new Error("The photo is too large to send. Move to a plainer view and try again.");
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Already ended.
    }
  });
}

export function createCamera(options: { sink: ImageSink }): CameraController {
  const { sink } = options;
  const listeners = new Set<() => void>();
  let snapshot: CameraSnapshot = INITIAL;
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented when the camera is closed so a late getUserMedia result cannot revive it. */
  let generation = 0;
  let clipUrl: string | null = null;
  let disposed = false;

  function set(patch: Partial<CameraSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }

  function flash(message: string) {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  }

  function revokeClip() {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = null;
  }

  function clearTimers() {
    if (timer) clearInterval(timer);
    if (frameTimer) clearInterval(frameTimer);
    timer = null;
    frameTimer = null;
  }

  async function openStream(): Promise<boolean> {
    if (stream && stream.getTracks().some((track) => track.readyState === "live")) return true;
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      set({ error: { kind: "insecure", retryable: false, message: "The camera needs a secure connection. Open this page over https (or on localhost) and try again." } });
      return false;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      set({ error: { kind: "unsupported", retryable: false, message: "This browser cannot open the camera (getUserMedia is missing). Use a current Chrome, Edge, Safari or Firefox over https." } });
      return false;
    }
    const mine = ++generation;
    set({ preview: "starting", error: null });
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (mine !== generation || disposed) {
        stopStream(opened);
        return false;
      }
      stream = opened;
      for (const track of opened.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (stream !== opened) return;
          const wasRecording = Boolean(recorder);
          closeCamera();
          set({ error: { kind: "failed", retryable: true, message: `The camera stopped unexpectedly${wasRecording ? ", so the recording ended" : ""}. Tap Camera to open it again.` } });
        });
      }
      set({ preview: "on", stream: opened });
      return true;
    } catch (error) {
      if (mine !== generation) return false;
      stream = null;
      set({ preview: "off", stream: null, error: cameraError(error) });
      return false;
    }
  }

  function closeCamera() {
    generation += 1;
    finishRecording();
    const closing = stream;
    stream = null;
    stopStream(closing);
    if (video) video.srcObject = null;
    set({ preview: "off", stream: null });
  }

  async function camera() {
    disposed = false;
    if (snapshot.preview === "starting") return;
    if (snapshot.preview === "off") {
      await openStream();
      return;
    }
    // Preview is on: this tap is the shutter.
    try {
      if (!video) throw new Error("The preview is not on screen.");
      const frame = encodeFrame(video);
      const takenAt = new Date().toISOString();
      const photo: Photo = {
        id: crypto.randomUUID(),
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        bytes: Math.round((frame.dataUrl.length - frame.dataUrl.indexOf(",") - 1) * 0.75),
        takenAt,
        sharedAt: null,
      };
      let sendFailure: CameraError | null = null;
      let notice: string | null = null;
      if (sink.canSendImage()) {
        try {
          sink.sendImage(frame.dataUrl, { triggerResponse: true });
          photo.sharedAt = new Date().toISOString();
        } catch (error) {
          sendFailure = { kind: "send", retryable: false, message: `The photo was not sent to the AI: ${error instanceof Error ? error.message : "unknown error"}. It is kept on this screen only.` };
        }
      } else {
        notice = "Start Talk first so the AI can see the photo. This photo stays on your screen only.";
      }
      set({ photos: [photo, ...snapshot.photos].slice(0, MAX_PHOTOS), error: sendFailure ?? snapshot.error });
      if (notice) flash(notice);
    } catch (error) {
      set({ error: { kind: "capture", retryable: false, message: error instanceof Error ? error.message : "The photo could not be taken." } });
    }
  }

  function sampleFrame() {
    if (!video || !recorder) return;
    if (snapshot.framesShared >= MAX_FRAMES_PER_RECORDING) return;
    if (!sink.canSendImage()) return;
    try {
      const frame = encodeFrame(video);
      sink.sendImage(frame.dataUrl, { triggerResponse: false });
      const framesShared = snapshot.framesShared + 1;
      set({ framesShared });
      if (framesShared === MAX_FRAMES_PER_RECORDING) flash(`Sent ${MAX_FRAMES_PER_RECORDING} frames to the AI, the limit for one recording. Recording continues without sending more.`);
    } catch (error) {
      set({ error: { kind: "send", retryable: false, message: `A recording frame was not sent to the AI: ${error instanceof Error ? error.message : "unknown error"}. Recording continues.` } });
    }
  }

  async function record() {
    disposed = false;
    if (snapshot.recording) return;
    if (typeof MediaRecorder === "undefined") {
      set({ error: { kind: "recorder-unsupported", retryable: false, message: "This browser cannot record video (MediaRecorder is missing). Photos still work." } });
      return;
    }
    const ready = await openStream();
    if (!ready || !stream || disposed) return;
    const mimeType = pickMimeType();
    let created: MediaRecorder;
    try {
      created = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
      set({ error: { kind: "recorder-unsupported", retryable: false, message: `Video recording could not start: ${error instanceof Error ? error.message : "unsupported format"}. Photos still work.` } });
      return;
    }
    revokeClip();
    chunks = [];
    recorder = created;
    const actualType = created.mimeType || mimeType || "video/webm";
    created.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    created.onerror = () => {
      if (recorder !== created) return;
      recorder = null;
      clearTimers();
      set({ recording: false, error: { kind: "recorder", retryable: true, message: "The recorder reported an error and stopped. Tap Record to try again." } });
    };
    created.onstop = () => {
      const parts = chunks;
      chunks = [];
      if (disposed) return;
      if (!parts.length) {
        set({ error: { kind: "recorder", retryable: true, message: "The recording produced no video data." } });
        return;
      }
      const blob = new Blob(parts, { type: actualType });
      revokeClip();
      clipUrl = URL.createObjectURL(blob);
      const extension = actualType.includes("mp4") ? "mp4" : "webm";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      set({
        clip: {
          url: clipUrl,
          mimeType: actualType,
          bytes: blob.size,
          durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
          filename: `techybuddy-clip-${stamp}.${extension}`,
        },
      });
    };
    startedAt = Date.now();
    set({ recording: true, elapsedSec: 0, framesShared: 0, clip: null, error: null });
    try {
      created.start(1000);
    } catch (error) {
      recorder = null;
      set({ recording: false, error: { kind: "recorder", retryable: true, message: `Recording could not start: ${error instanceof Error ? error.message : "unknown error"}.` } });
      return;
    }
    timer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      set({ elapsedSec });
      if (elapsedSec >= MAX_RECORDING_SEC) {
        finishRecording();
        flash("Recording stopped at the 5-minute limit.");
      }
    }, 1000);
    frameTimer = setInterval(sampleFrame, FRAME_INTERVAL_MS);
  }

  /** Stops the recorder if it is running. The clip is built in onstop. */
  function finishRecording() {
    clearTimers();
    const active = recorder;
    recorder = null;
    if (active && active.state !== "inactive") {
      try {
        active.stop();
      } catch {
        // Already stopped.
      }
    }
    if (snapshot.recording) set({ recording: false });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVideoElement(element) {
      video = element;
      if (video && stream && video.srcObject !== stream) video.srcObject = stream;
    },
    camera,
    record,
    stopRecording: finishRecording,
    stopAll() {
      closeCamera();
      if (noticeTimer) clearTimeout(noticeTimer);
      set({ notice: null, error: null });
    },
    cameraIsLive() {
      return Boolean(stream?.getTracks().some((track) => track.readyState === "live"));
    },
    dispose() {
      disposed = true;
      closeCamera();
      revokeClip();
      if (noticeTimer) clearTimeout(noticeTimer);
    },
  };
}
