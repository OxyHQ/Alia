// Type declarations for optional peer dependencies.
// These prevent TypeScript errors when the deps aren't installed.
// At runtime, the host app provides the actual packages.

declare module 'livekit-client' {
  export class Room {
    on(event: any, listener: (...args: any[]) => void): this;
    off(event: any, listener: (...args: any[]) => void): this;
    localParticipant: LocalParticipant;
    remoteParticipants: Map<string, RemoteParticipant>;
    connect(url: string, token: string, options?: any): Promise<void>;
    disconnect(): Promise<void>;
    state: string;
  }
  export class LocalParticipant {
    publishData(data: Uint8Array, options?: DataPublishOptions): Promise<void>;
    getTrackPublications(): Map<string, any>;
    getTrackPublication(source: string): any;
    setMicrophoneEnabled(enabled: boolean): Promise<void>;
    audioTrackPublications: Map<string, any>;
    trackPublications: Map<string, any>;
  }
  export class RemoteParticipant {
    getTrackPublications(): Map<string, RemoteTrackPublication>;
    audioTrackPublications: Map<string, RemoteTrackPublication>;
    trackPublications: Map<string, RemoteTrackPublication>;
    identity: string;
  }
  export class RemoteTrackPublication {
    track: any;
    source: string;
    kind: string;
    isSubscribed: boolean;
    trackSid: string;
  }
  export interface DataPublishOptions {
    reliable?: boolean;
    topic?: string;
  }
  export const RoomEvent: Record<string, string>;
  export const Track: { Source: Record<string, string>; Kind: Record<string, string> };
  export const DataPacket_Kind: Record<string, number>;
  export enum DisconnectReason {
    UNKNOWN_REASON = 0,
    CLIENT_INITIATED = 1,
    DUPLICATE_IDENTITY = 2,
    SERVER_SHUTDOWN = 3,
    PARTICIPANT_REMOVED = 4,
    ROOM_DELETED = 5,
    STATE_MISMATCH = 6,
    JOIN_FAILURE = 7,
  }
}

declare module 'expo-audio' {
  export function createAudioPlayer(source: any): any;
  export function useAudioRecorder(preset: any): any;
  export function useAudioRecorderState(recorder: any, interval: number): any;
  export function requestRecordingPermissionsAsync(): Promise<{ granted: boolean }>;
  export function setAudioModeAsync(mode: any): Promise<void>;
  export const RecordingPresets: { HIGH_QUALITY: any };
  export class AudioRecorder {
    constructor(preset: any);
    prepareToRecordAsync(): Promise<void>;
    record(): void;
    stop(): Promise<void>;
    uri: string | null;
  }
}
