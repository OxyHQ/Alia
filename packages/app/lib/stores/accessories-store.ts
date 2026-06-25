import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { errorMessage as getErrorMessage, errorStatus, errorResponseData } from '../errors/error-utils';

export type AccessorySlot = 'head' | 'face' | 'neck';
export type AccessoryLayer = 'front' | 'behind';
export type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface CatalogAccessory {
  _id: string;
  name: string;
  slug: string;
  slot: AccessorySlot;
  layer: AccessoryLayer;
  imageUrl: string;
  thumbnailUrl?: string;
  price: number;
  rarity: AccessoryRarity;
  isDefault: boolean;
}

interface AccessoriesStoreState {
  catalog: CatalogAccessory[];
  owned: string[];
  loading: boolean;
  error: string | null;
  loadCatalog: () => Promise<void>;
  loadOwned: () => Promise<void>;
  purchaseAccessory: (id: string) => Promise<boolean>;
  isOwned: (id: string) => boolean;
  getById: (id: string) => CatalogAccessory | undefined;
  getBySlot: (slot: AccessorySlot) => CatalogAccessory[];
  getSlots: () => AccessorySlot[];
}

export const useAccessoriesStore = create<AccessoriesStoreState>((set, get) => ({
  catalog: [],
  owned: [],
  loading: false,
  error: null,

  loadCatalog: async () => {
    try {
      set({ loading: true, error: null });
      const res = await apiClient.get(API_ROUTES.accessories.list);
      set({ catalog: res.data.accessories, loading: false });
    } catch (error: unknown) {
      console.error('Error loading accessories catalog:', error);
      set({ error: getErrorMessage(error), loading: false });
    }
  },

  loadOwned: async () => {
    try {
      const res = await apiClient.get(API_ROUTES.accessories.me);
      set({ owned: res.data.owned });
    } catch (error: unknown) {
      console.error('Error loading owned accessories:', error);
    }
  },

  purchaseAccessory: async (id: string) => {
    try {
      const res = await apiClient.post(API_ROUTES.accessories.purchase(id));
      set({ owned: res.data.owned });
      return true;
    } catch (error: unknown) {
      const status = errorStatus(error);
      const data = errorResponseData(error);
      if (status === 402) {
        throw new Error(data?.error || 'Insufficient credits');
      }
      if (status === 400) {
        throw new Error(data?.error || 'Cannot purchase this accessory');
      }
      console.error('Error purchasing accessory:', error);
      throw new Error(data?.error || 'Failed to purchase accessory');
    }
  },

  isOwned: (id: string) => {
    const { owned, catalog } = get();
    const accessory = catalog.find((a) => a._id === id);
    if (accessory?.isDefault) return true;
    return owned.includes(id);
  },

  getById: (id: string) => {
    return get().catalog.find((a) => a._id === id);
  },

  getBySlot: (slot: AccessorySlot) => {
    return get().catalog.filter((a) => a.slot === slot);
  },

  getSlots: () => {
    const slots = new Set(get().catalog.map((a) => a.slot));
    return Array.from(slots) as AccessorySlot[];
  },
}));
