export const FADE_MS      = 3000;  // crossfade between tracks (prev/next)
export const FADE_STOP_MS = 300;   // play/stop, scene switch

/**
 * Smoothly ramp a WebAudio GainNode to targetValue over durationMs milliseconds.
 * Cancels any in-flight ramp first so calls can be safely overlapped.
 */
export function fadeGainNode(gainNode, targetValue, durationMs, audioCtx) {
  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(targetValue, now + Math.max(durationMs, 1) / 1000);
}
