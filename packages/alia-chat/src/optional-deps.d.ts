// NativeWind types — extends RN components with className prop
/// <reference types="nativewind/types" />

// Type declarations for optional peer dependencies.
// These prevent TypeScript errors when the deps aren't installed.
// At runtime, the host app provides the actual packages.
//
// NOTE: Only declare modules for packages NOT installed in the monorepo.
// Installed packages (lucide-react-native, zeego, expo-image, etc.)
// have their own real types — ambient declarations here would shadow them.

declare module 'livekit-client' {
  export interface RemoteTrack {
    kind?: string;
    mediaStreamTrack?: MediaStreamTrack;
    attach(): HTMLMediaElement;
    detach(): HTMLMediaElement[];
  }
  export class Room {
    on<Args extends unknown[]>(event: string, listener: (...args: Args) => void): this;
    off<Args extends unknown[]>(event: string, listener: (...args: Args) => void): this;
    localParticipant: LocalParticipant;
    remoteParticipants: Map<string, RemoteParticipant>;
    connect(url: string, token: string, options?: Record<string, unknown>): Promise<void>;
    disconnect(): Promise<void>;
    state: string;
  }
  export class LocalParticipant {
    publishData(data: Uint8Array, options?: DataPublishOptions): Promise<void>;
    getTrackPublications(): Map<string, RemoteTrackPublication>;
    getTrackPublication(source: string): RemoteTrackPublication | undefined;
    setMicrophoneEnabled(enabled: boolean): Promise<void>;
    audioTrackPublications: Map<string, RemoteTrackPublication>;
    trackPublications: Map<string, RemoteTrackPublication>;
  }
  export class RemoteParticipant {
    getTrackPublications(): Map<string, RemoteTrackPublication>;
    audioTrackPublications: Map<string, RemoteTrackPublication>;
    trackPublications: Map<string, RemoteTrackPublication>;
    identity: string;
  }
  export class RemoteTrackPublication {
    track: RemoteTrack | null;
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
  export interface AudioPlaybackStatus {
    didJustFinish?: boolean;
    isLoaded?: boolean;
    playing?: boolean;
  }
  export interface AudioPlayer {
    addListener(event: 'playbackStatusUpdate', listener: (status: AudioPlaybackStatus) => void): { remove(): void };
    play(): void;
    pause(): void;
    seekTo(seconds: number): void;
    remove(): void;
    release(): void;
  }
  /** A URI object, a bundled asset module id (number), or a required asset. */
  export type AudioSource = { uri: string } | number;
  export interface RecordingPreset {
    isMeteringEnabled?: boolean;
    [key: string]: unknown;
  }
  export interface AudioMode {
    [key: string]: unknown;
  }
  export interface AudioRecorderState {
    metering?: number;
    isRecording?: boolean;
    durationMillis?: number;
  }
  export function createAudioPlayer(source: AudioSource): AudioPlayer;
  export function useAudioRecorder(preset: RecordingPreset): AudioRecorder;
  export function useAudioRecorderState(recorder: AudioRecorder, interval: number): AudioRecorderState;
  export function requestRecordingPermissionsAsync(): Promise<{ granted: boolean }>;
  export function getRecordingPermissionsAsync(): Promise<{ granted: boolean }>;
  export function setAudioModeAsync(mode: AudioMode): Promise<void>;
  export const RecordingPresets: { HIGH_QUALITY: RecordingPreset };
  export class AudioRecorder {
    constructor(preset: RecordingPreset);
    prepareToRecordAsync(): Promise<void>;
    record(): void;
    stop(): Promise<void>;
    uri: string | null;
  }
}

declare module 'expo-clipboard' {
  export function setStringAsync(text: string): Promise<boolean>;
  export function getStringAsync(): Promise<string>;
}

declare module 'expo-image-picker' {
  export interface ImagePickerAsset {
    uri: string;
    fileName?: string | null;
    fileSize?: number;
    mimeType?: string;
  }
  export interface ImagePickerOptions {
    allowsMultipleSelection?: boolean;
    mediaTypes?: string;
    aspect?: [number, number];
    quality?: number;
  }
  export interface ImagePickerResult {
    canceled: boolean;
    assets: ImagePickerAsset[];
  }
  export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
  export const MediaTypeOptions: { Images: string; Videos: string; All: string };
}
