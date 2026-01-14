import { useState, useCallback, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { ChatHistory } from '@/lib/types';
import { toast } from 'sonner';

export function useChatHistory() {
  const { data: session, status } = useSession();
  const isAuthenticated = status === 'authenticated';
  const [chats, setChats] = useState<ChatHistory[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchChats = useCallback(async () => {
    if (!isAuthenticated) {
      // Local storage fallback for unauthenticated users
      const localConvsString = localStorage.getItem('alia-conversations') || '[]';
      const localConvs = JSON.parse(localConvsString);
      // Map local to ChatHistory type
      const mapped = localConvs
        .filter((c: any) => c.messages && c.messages.length > 0)
        .map((c: any) => ({
           id: c._id || c.id,
           title: c.title,
           updatedAt: c.updatedAt,
           // Local chats probably don't have folders/icons yet unless stored
           folderId: c.folderId || null,
           icon: c.icon,
           iconColor: c.iconColor,
           isFavorite: c.isFavorite
        }));
      setChats(mapped);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = await res.json();
        // Ensure mapping if needed (mongo _id to id)
        const mapped = data.map((c: any) => ({
            ...c,
            id: c._id || c.id
        }));
        setChats(mapped);
      }
    } catch (e) {
      console.error("Error fetching history", e);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchChats();
    
    const handleUpdate = () => fetchChats();
    window.addEventListener('chat-updated', handleUpdate);
    return () => window.removeEventListener('chat-updated', handleUpdate);
  }, [fetchChats]);

  const updateChat = useCallback(async (chatId: string, updates: Partial<ChatHistory>) => {
    // Optimistic update
    const prevChats = [...chats];
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, ...updates } : c));

    if (!isAuthenticated) {
        // Update local storage
        const localConvs = JSON.parse(localStorage.getItem('alia-conversations') || '[]');
        const updatedLocal = localConvs.map((c: any) => 
            (c._id === chatId || c.id === chatId) ? { ...c, ...updates } : c
        );
        localStorage.setItem('alia-conversations', JSON.stringify(updatedLocal));
        return;
    }

    try {
        const res = await fetch(`/api/conversations/${chatId}`, {
            method: 'PUT', // or PATCH
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        
        if (!res.ok) throw new Error("Failed to update chat");
    } catch (e) {
        setChats(prevChats); // Rollback
        toast.error("Error al actualizar la conversación");
        console.error(e);
    }
  }, [chats, isAuthenticated]);

  const deleteChat = useCallback(async (chatId: string) => {
      // Optimistic
      const prevChats = [...chats];
      setChats(prev => prev.filter(c => c.id !== chatId));

      if (!isAuthenticated) {
          const localConvs = JSON.parse(localStorage.getItem('alia-conversations') || '[]');
          const filtered = localConvs.filter((c: any) => c._id !== chatId && c.id !== chatId);
          localStorage.setItem('alia-conversations', JSON.stringify(filtered));
          return;
      }

      try {
          const res = await fetch(`/api/conversations/${chatId}`, { method: 'DELETE' });
          if (!res.ok) throw new Error("Failed to delete");
      } catch (e) {
          setChats(prevChats);
          toast.error("Error al eliminar");
      }
  }, [chats, isAuthenticated]);

  return {
    chats,
    loading,
    reload: fetchChats,
    updateChat,
    deleteChat
  };
}
