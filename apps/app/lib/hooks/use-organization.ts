import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { generateAPIUrl } from '../generate-api-url';
import { useAuthStore } from '../stores/auth-store';

export interface Organization {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ownerId: string;
  role?: 'owner' | 'admin' | 'member';
  credits: {
    paid: number;
  };
  settings: {
    billingEmail?: string;
    apiCallLimit?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  _id: string;
  organizationId: string;
  userId: {
    _id: string;
    email: string;
    name: string;
    image?: string;
  };
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
  updatedAt: string;
}

function getAPIHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ======================
// Organizations
// ======================

async function fetchOrganizations(): Promise<Organization[]> {
  const apiUrl = generateAPIUrl('/organization');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch organizations');
  }

  const data = await response.json();
  return data.organizations;
}

export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });
}

async function fetchOrganization(id: string): Promise<Organization> {
  const apiUrl = generateAPIUrl(`/organization/${id}`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch organization');
  }

  const data = await response.json();
  return data.organization;
}

export function useOrganization(id: string) {
  return useQuery({
    queryKey: ['organization', id],
    queryFn: () => fetchOrganization(id),
    enabled: !!id,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 1,
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { name: string; slug: string; description?: string }) => {
      const apiUrl = generateAPIUrl('/organization');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create organization');
      }

      const result = await response.json();
      return result.organization;
    },
    onSuccess: (newOrg) => {
      // Add to organizations list cache
      queryClient.setQueryData<Organization[]>(['organizations'], (old) => {
        if (!old) return [newOrg];
        return [newOrg, ...old];
      });

      // Set individual organization cache
      queryClient.setQueryData(['organization', newOrg._id], newOrg);
    },
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Organization> }) => {
      const apiUrl = generateAPIUrl(`/organization/${id}`);
      const response = await fetch(apiUrl, {
        method: 'PATCH',
        headers: getAPIHeaders(),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update organization');
      }

      const result = await response.json();
      return result.organization;
    },
    onSuccess: (updatedOrg) => {
      // Update organizations list cache
      queryClient.setQueryData<Organization[]>(['organizations'], (old) => {
        if (!old) return [updatedOrg];
        return old.map((org) => (org._id === updatedOrg._id ? updatedOrg : org));
      });

      // Update individual organization cache
      queryClient.setQueryData(['organization', updatedOrg._id], updatedOrg);
    },
  });
}

export function useDeleteOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const apiUrl = generateAPIUrl(`/organization/${id}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: getAPIHeaders(),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete organization');
      }

      return id;
    },
    onSuccess: (id) => {
      // Remove from organizations list cache
      queryClient.setQueryData<Organization[]>(['organizations'], (old) => {
        if (!old) return [];
        return old.filter((org) => org._id !== id);
      });

      // Remove individual organization cache
      queryClient.removeQueries({ queryKey: ['organization', id] });
    },
  });
}

// ======================
// Members
// ======================

async function fetchMembers(orgId: string): Promise<OrganizationMember[]> {
  const apiUrl = generateAPIUrl(`/organization/${orgId}/members`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch members');
  }

  const data = await response.json();
  return data.members;
}

export function useOrganizationMembers(orgId: string) {
  return useQuery({
    queryKey: ['organization-members', orgId],
    queryFn: () => fetchMembers(orgId),
    enabled: !!orgId,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 1,
  });
}
