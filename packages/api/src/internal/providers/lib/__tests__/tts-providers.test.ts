import { describe, it, expect } from 'vitest';
import {
  resolveVoiceForProvider,
  ttsOutputFormat,
  parsePcmSampleRate,
  pcmToWav,
} from '../tts-providers.js';

describe('resolveVoiceForProvider', () => {
  it('passes OpenAI voice names through for openai/openrouter', () => {
    expect(resolveVoiceForProvider('openai', 'nova')).toBe('nova');
    expect(resolveVoiceForProvider('openrouter', 'echo')).toBe('echo');
    expect(resolveVoiceForProvider('openai', 'NOVA')).toBe('nova');
  });

  it('falls back to a default OpenAI voice for unknown names on openai', () => {
    expect(resolveVoiceForProvider('openai', 'not-a-voice')).toBe('nova');
    // An ElevenLabs id (show path) is not an OpenAI voice → default.
    expect(resolveVoiceForProvider('openai', 'kPzsL2i3teMYv0FxEYQ6')).toBe('nova');
  });

  it('maps OpenAI voices to Gemini prebuilt voices', () => {
    expect(resolveVoiceForProvider('google', 'nova')).toBe('Kore');
    expect(resolveVoiceForProvider('google', 'echo')).toBe('Puck');
    expect(resolveVoiceForProvider('google', 'onyx')).toBe('Charon');
  });

  it('defaults google to a valid Gemini voice for unknown/ElevenLabs voices', () => {
    expect(resolveVoiceForProvider('google', 'kPzsL2i3teMYv0FxEYQ6')).toBe('Kore');
    expect(resolveVoiceForProvider('google', '')).toBe('Kore');
  });

  it('maps OpenAI voices to ElevenLabs voice ids for digitalocean', () => {
    expect(resolveVoiceForProvider('digitalocean', 'nova')).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(resolveVoiceForProvider('digitalocean', 'echo')).toBe('pNInz6obpgDQGcFmaJgB');
  });

  it('passes ElevenLabs voice ids (show roster) through for digitalocean', () => {
    expect(resolveVoiceForProvider('digitalocean', 'kPzsL2i3teMYv0FxEYQ6')).toBe('kPzsL2i3teMYv0FxEYQ6');
    expect(resolveVoiceForProvider('digitalocean', 'pNInz6obpgDQGcFmaJgB')).toBe('pNInz6obpgDQGcFmaJgB');
  });

  it('defaults digitalocean to an ElevenLabs id for unknown voices', () => {
    expect(resolveVoiceForProvider('digitalocean', 'not-a-voice')).toBe('EXAVITQu4vr4xnSDxMaL');
  });
});

describe('ttsOutputFormat', () => {
  it('reports WAV for google and MP3 for digitalocean', () => {
    expect(ttsOutputFormat('google', 'mp3')).toBe('wav');
    expect(ttsOutputFormat('digitalocean', 'mp3')).toBe('mp3');
  });

  it('honours the requested format for openai', () => {
    expect(ttsOutputFormat('openai', 'mp3')).toBe('mp3');
    expect(ttsOutputFormat('openai', 'opus')).toBe('opus');
  });
});

describe('parsePcmSampleRate', () => {
  it('reads the rate from a Gemini mime type', () => {
    expect(parsePcmSampleRate('audio/L16;codec=pcm;rate=24000')).toBe(24000);
    expect(parsePcmSampleRate('audio/L16;codec=pcm;rate=16000')).toBe(16000);
  });

  it('defaults to 24000 when the rate is absent', () => {
    expect(parsePcmSampleRate(undefined)).toBe(24000);
    expect(parsePcmSampleRate('audio/L16;codec=pcm')).toBe(24000);
  });
});

describe('pcmToWav', () => {
  it('prepends a valid 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm, 24000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24000 * 2); // byte rate (16-bit mono)
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
