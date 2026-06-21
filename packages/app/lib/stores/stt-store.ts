import { create } from 'zustand';

interface STTStore {
  isRecording: boolean;
  metering: number; // normalized 0–1
  setRecording: (v: boolean) => void;
  setMetering: (v: number) => void;
}

export const useSTTStore = create<STTStore>((set) => ({
  isRecording: false,
  metering: 0,
  setRecording: (isRecording) => set({ isRecording, ...(!isRecording && { metering: 0 }) }),
  setMetering: (metering) => set({ metering }),
}));
