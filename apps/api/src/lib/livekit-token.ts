import { AccessToken } from 'livekit-server-sdk';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

export function isLiveKitConfigured(): boolean {
  return !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
}

export function getLiveKitUrl(): string {
  return process.env.LIVEKIT_URL || 'ws://localhost:7880';
}

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

  return await token.toJwt();
}

export async function createAgentToken(roomName: string): Promise<string> {
  if (!isLiveKitConfigured()) {
    throw new Error('LiveKit is not configured.');
  }

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: 'alia-agent',
    ttl: '10m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    agent: true,
  });

  return await token.toJwt();
}
