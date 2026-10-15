// musicHold.ts — the music pauses while Bit listens to you, and comes back after.
//
// Over a song, Bit hears the song: commands get lyrics mixed in ("pause the
// music or let it go") and the end of your sentence gets lost. So:
//   - "Hey Bit": the backend pauses what's playing the moment it's sure it
//     heard its name (it knows first);
//   - push-to-talk and answering in a conversation: this module asks it to
//     (/media/hold) when the microphone opens;
//   - once the whole exchange is over (the answer has been spoken and it isn't
//     listening for a reply), it asks the backend to resume exactly what it
//     paused (/media/release).
// A command about the music itself ("pause", "play X on YouTube") is settled
// in the backend (media.py): nothing is resumed against your wishes.

import type { VoiceState } from "../shared/types";
import type { Backend } from "./backend";
import { log } from "./log";

/** Everything quiet this long: the exchange is over (covers the moment between a reply and listening for the answer). */
const QUIET_MS = 1500;
/** A reply is being turned into speech: wait this long at most for it to start. */
const SPEECH_DUE_MS = 8000;
/** Safety net: nothing has happened for this long (a stuck state), resume anyway. */
const STUCK_MS = 120_000;

let getBackend: () => Backend | null = () => null;
let enabled = true;
let held = false; // something may be paused for listening
let releasing = false;
let voice: VoiceState = "idle";
let turns = 0;
let hearing = false; // "Hey Bit" is hearing a sentence (or waiting for the command)
let speechDue = 0;
let lastActivity = 0;
let timer: NodeJS.Timeout | null = null;

export function startMusicHold(backend: () => Backend | null): void {
  getBackend = backend;
}

/** Off in the self-test: it must never pause or resume your real music. */
export function setMusicHold(on: boolean): void {
  enabled = on;
  if (!on) {
    held = false;
    stopTimer();
  }
}

/** "Hey Bit" events: once it's sure ("listening") the backend has paused the music. */
export function musicOnWake(phase: string | undefined): void {
  if (!enabled) return;
  if (phase === "listening") {
    hearing = true;
    markHeld();
  } else if (phase === "command" || phase === "cancel") {
    hearing = false;
  }
  touch();
}

/** The robot's voice state: the microphone opening (push-to-talk, a conversation's answer) pauses the music. */
export function musicOnVoice(state: VoiceState): void {
  voice = state;
  if (!enabled) return;
  // Talking or recording mutes "Hey Bit", which drops any sentence it was hearing.
  if (state === "listening" || state === "speaking") hearing = false;
  if (state === "listening") {
    void getBackend()?.send<{ paused: boolean }>("/media/hold", "POST");
    markHeld();
  }
  if (state === "speaking") speechDue = 0;
  touch();
}

/** A conversation turn is being worked out (or has finished). */
export function musicTurn(delta: 1 | -1): void {
  turns = Math.max(0, turns + delta);
  touch();
}

/** A reply was sent to be spoken: the voice starts once it's synthesised. */
export function musicSpeechDue(): void {
  speechDue = Date.now() + SPEECH_DUE_MS;
  touch();
}

function markHeld(): void {
  held = true;
  timer ??= setInterval(tick, 300);
}

function touch(): void {
  lastActivity = Date.now();
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick(): void {
  if (!held || releasing) return;
  const backend = getBackend();
  if (!backend?.ready) return;
  const now = Date.now();
  const busy = voice !== "idle" || turns > 0 || hearing || now < speechDue;
  if (now - lastActivity < (busy ? STUCK_MS : QUIET_MS)) return;
  releasing = true;
  void backend.send<{ resumed: boolean; busy?: boolean }>("/media/release", "POST").then((res) => {
    releasing = false;
    if (res.data?.busy) {
      touch(); // "Hey Bit" is hearing a new sentence: ask again once that's over
      return;
    }
    held = false;
    stopTimer();
    if (res.data?.resumed) log("music: resumed after listening");
  });
}
