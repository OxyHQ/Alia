import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { log } from './logger.js';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const TOKEN_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export function isLiveKitConfigured(): boolean {
  return !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
}

export function getLiveKitUrl(): string {
  return process.env.LIVEKIT_URL || 'ws://localhost:7880';
}

/** Get the HTTP URL for the LiveKit server (for RoomServiceClient). */
function getLiveKitHttpUrl(): string {
  const wsUrl = getLiveKitUrl();
  // Convert ws:// to http:// and wss:// to https://
  return wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

let _roomService: RoomServiceClient | null = null;

function getRoomService(): RoomServiceClient {
  if (!_roomService) {
    if (!isLiveKitConfigured()) {
      throw new Error('LiveKit is not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
    }
    _roomService = new RoomServiceClient(getLiveKitHttpUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return _roomService;
}

// ============== TOKEN GENERATION ==============

export async function createVoiceToken(userId: string, roomName: string): Promise<string> {
  if (!isLiveKitConfigured()) {
    throw new Error('LiveKit is not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
  }

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: '10m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await withTimeout(token.toJwt(), TOKEN_TIMEOUT_MS, 'LiveKit token generation');
}

export async function createAgentToken(roomName: string, identity = 'alia-agent'): Promise<string> {
  if (!isLiveKitConfigured()) {
    throw new Error('LiveKit is not configured.');
  }

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '30m', // Agents may run longer
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    agent: true,
  });

  return await withTimeout(token.toJwt(), TOKEN_TIMEOUT_MS, 'LiveKit agent token generation');
}

// ============== ROOM MANAGEMENT ==============

/**
 * Create a LiveKit room. Rooms are auto-created on first join,
 * but explicit creation lets us set options like emptyTimeout.
 */
export async function createVoiceRoom(roomName: string): Promise<void> {
  const service = getRoomService();
  await service.createRoom({
    name: roomName,
    emptyTimeout: 300,       // 5 minutes before auto-delete if empty
    departureTimeout: 30,    // 30s grace period after last participant leaves
    maxParticipants: 5,      // user + primary agent + cohost agent + buffer
  });
}

/** Delete a LiveKit room explicitly (for cleanup). */
export async function deleteVoiceRoom(roomName: string): Promise<void> {
  try {
    const service = getRoomService();
    await service.deleteRoom(roomName);
  } catch (err) {
    // Room may already be deleted or API unreachable; log and continue
    log.providers.warn({ err, roomName }, 'Could not delete LiveKit room');
  }
}
