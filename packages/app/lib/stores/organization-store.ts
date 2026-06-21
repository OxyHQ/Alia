import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface OrganizationState {
  selectedOrgId: string | null;
  setSelectedOrg: (orgId: string | null) => void;
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set) => ({
      selectedOrgId: null,
      setSelectedOrg: (orgId) => set({ selectedOrgId: orgId }),
    }),
    {
      name: 'organization-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
