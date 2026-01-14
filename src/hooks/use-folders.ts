import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from "react";
import { ChatFolder } from "@/lib/types";

interface ApiResponse<T> {
  data: T;
  error?: string;
}

// Global cache for folders
interface FolderCache {
  data: ChatFolder[];
  timestamp: number;
  loading: boolean;
}

const CACHE_TTL = 30000; // 30 seconds
const globalCache = new Map<string, FolderCache>();
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(listener => listener());
}

function getSnapshot() {
  return globalCache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFolders(userId?: string) {
  const cacheKey = userId || "public"; // Use userId as cache key or 'public'
  
  const [localFolders, setLocalFolders] = useState<ChatFolder[]>(() => {
    const cached = globalCache.get(cacheKey);
    return cached?.data || [];
  });
  
  const [loading, setLoading] = useState(() => {
    const cached = globalCache.get(cacheKey);
    return !cached;
  });
  
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fetchFolders = useCallback(async (force = false) => {
    if (!userId) return; // Don't fetch if no user

    const cached = globalCache.get(cacheKey);
    const now = Date.now();

    if (!force && cached && (now - cached.timestamp) < CACHE_TTL) {
      setLocalFolders(cached.data);
      setLoading(false);
      return;
    }

    if (cached?.loading) return;

    globalCache.set(cacheKey, {
      data: cached?.data || [],
      timestamp: cached?.timestamp || 0,
      loading: true
    });
    notifyListeners();

    try {
      if (!cached?.data) setLoading(true);
      setError(null);

      const response = await fetch("/api/folders"); // Default fetches for current user
      
      if (!response.ok) {
        throw new Error(`Error: ${response.status}`);
      }

      const json: ApiResponse<ChatFolder[]> = await response.json();
      
      if (json.error) throw new Error(json.error);

      // Map _id to id if necessary, though Typegoose/Mongoose might send _id.
      // Let's ensure id property existence.
      const folders = (json.data || []).map((f: any) => ({
        ...f,
        id: f._id || f.id,
        // Ensure color is valid or default
        color: f.color || 'gray'
      }));

      globalCache.set(cacheKey, {
        data: folders,
        timestamp: Date.now(),
        loading: false
      });
      notifyListeners();

      if (isMountedRef.current) {
        setLocalFolders(folders);
      }

    } catch (err: any) {
      const cached = globalCache.get(cacheKey);
      if (cached) {
        globalCache.set(cacheKey, { ...cached, loading: false });
        notifyListeners();
      }
      if (isMountedRef.current) {
        setError(err.message || "Unknown error");
      }
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [userId, cacheKey]);

  useEffect(() => {
    isMountedRef.current = true;
    const cached = globalCache.get(cacheKey);

    if (cached !== undefined && cached.timestamp > 0) {
      setLocalFolders(cached.data);
      setLoading(false);
      if (Date.now() - cached.timestamp > CACHE_TTL) {
        fetchFolders(true);
      }
    } else {
      fetchFolders();
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [cacheKey, fetchFolders]);

  const createFolder = useCallback(async (name: string, color: string = 'gray') => {
    try {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });

      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to create folder");

      const newFolder = { ...json.data, id: json.data._id || json.data.id };

      const updatedFolders = [...localFolders, newFolder].sort((a, b) => a.name.localeCompare(b.name));
      setLocalFolders(updatedFolders);
      
      globalCache.set(cacheKey, {
        data: updatedFolders,
        timestamp: Date.now(),
        loading: false
      });
      notifyListeners();

      return newFolder;
    } catch (err) {
      throw err;
    }
  }, [localFolders, cacheKey]);

  const updateFolder = useCallback(async (id: string, updates: Partial<ChatFolder>) => {
    const previousFolders = localFolders;
    const updatedFolders = localFolders.map(f => f.id === id ? { ...f, ...updates } : f);
    
    setLocalFolders(updatedFolders);
    globalCache.set(cacheKey, { data: updatedFolders, timestamp: Date.now(), loading: false });
    notifyListeners();

    try {
      const response = await fetch(`/api/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const json = await response.json();
        throw new Error(json.error || "Failed to update folder");
      }
    } catch (err) {
      // Rollback
      setLocalFolders(previousFolders);
      globalCache.set(cacheKey, { data: previousFolders, timestamp: Date.now(), loading: false });
      notifyListeners();
      throw err;
    }
  }, [localFolders, cacheKey]);

  const deleteFolder = useCallback(async (id: string) => {
    const previousFolders = localFolders;
    const updatedFolders = localFolders.filter(f => f.id !== id);
    
    setLocalFolders(updatedFolders);
    globalCache.set(cacheKey, { data: updatedFolders, timestamp: Date.now(), loading: false });
    notifyListeners();

    try {
      const response = await fetch(`/api/folders/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const json = await response.json();
        throw new Error(json.error || "Failed to delete folder");
      }
    } catch (err) {
      setLocalFolders(previousFolders);
      globalCache.set(cacheKey, { data: previousFolders, timestamp: Date.now(), loading: false });
      notifyListeners();
      throw err;
    }
  }, [localFolders, cacheKey]);

  return {
    folders: localFolders,
    loading,
    error,
    refreshFolders: () => fetchFolders(true),
    createFolder,
    updateFolder,
    deleteFolder
  };
}
