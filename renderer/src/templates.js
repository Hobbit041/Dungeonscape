/**
 * templates.js — factory functions for default/empty data shapes.
 * Single source of truth for what a blank channel / ambient / soundboard
 * button / scene / soundscape looks like on disk.
 */

export const MIXER_SIZE      = 8;
export const SOUNDBOARD_SIZE = 49;   // full 7×7 backing model; visible grid is 4–7 cols × 4–7 rows

export function makeChannelSettings(channelNr = 0) {
  return {
    channel: channelNr, name: '', volume: 1, pan: 0,
    link: false, solo: false, mute: false,
    repeat: { repeat: 'all', minDelay: 0, maxDelay: 0 },
    randomize: false,
    playbackRate: { rate: 1, preservePitch: 1, random: 0 },
    timing: { startTime: 0, stopTime: 0, skipFirstTiming: false, fadeIn: 0, fadeOut: 0, skipFirstFade: false },
    autoPlay: false,
    imageSrc: '',
    effects: {
      equalizer: {
        highPass: { enable: false, frequency: 50,   q: 1 },
        peaking1: { enable: false, frequency: 500,  q: 1, gain: 1 },
        peaking2: { enable: false, frequency: 1000, q: 1, gain: 1 },
        lowPass:  { enable: false, frequency: 2000, q: 1 }
      },
      delay: { enable: false, delayTime: 0.25, volume: 0.5 }
    }
  };
}

/** Empty mixer channel entry (slot 0..MIXER_SIZE-1). */
export function makeEmptyChannel(channelNr) {
  return {
    channel: channelNr,
    soundData: { soundSelect: 'filepicker_single', source: '', playlistName: '', soundName: '' },
    settings: makeChannelSettings(channelNr)
  };
}

/** Channel entry used by `clearChannel` — same shape but with defaults for the
 *  reset-specific case (no autoplay, name reset, etc). */
export function makeResetChannel(channelNr) {
  return {
    channel: channelNr,
    soundData: { soundSelect: 'filepicker_single', source: '', playlistName: '', soundName: '' },
    settings: makeChannelSettings(channelNr)
  };
}

/** Empty ambient channel entry (slot 0..AMBIENT_SIZE-1). */
export function makeEmptyAmbient(channelNr) {
  return {
    channel: channelNr,
    settings: { volume: 1, name: '', imageSrc: '' },
    soundData: { playlist: [], shuffle: false }
  };
}

/** Empty soundboard button entry (slot 0..SOUNDBOARD_SIZE-1). */
export function makeEmptySoundboardButton(btnNr) {
  return {
    channel: 100 + btnNr,
    soundData: { soundSelect: 'filepicker_single', source: '', playlistName: '', soundName: '' },
    playbackRate: { rate: 1, preservePitch: 1, random: 0 },
    name: '', volume: 1, randomizeVolume: 0,
    repeat: { repeat: 'none', minDelay: 0, maxDelay: 0 },
    randomize: false, interrupt: false, imageSrc: ''
  };
}

/** Array of empty ambient entries. */
export function makeEmptyAmbientArray(size) {
  return Array.from({ length: size }, (_, i) => makeEmptyAmbient(i));
}

/** Array of empty soundboard buttons. */
export function makeEmptySoundboardArray(size = SOUNDBOARD_SIZE) {
  return Array.from({ length: size }, (_, i) => makeEmptySoundboardButton(i));
}

/** Array of empty mixer channel entries. */
export function makeEmptyChannelArray(size = MIXER_SIZE) {
  return Array.from({ length: size }, (_, i) => makeEmptyChannel(i));
}
