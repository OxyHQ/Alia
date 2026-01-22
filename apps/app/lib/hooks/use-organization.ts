import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';

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

// ======================
// Organizations
// ======================

async function fetchOrganizations(): Promise<Organization[]> {
  const response = await apiClient.get('/organization');
  return response.data.organizations;
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
  const response = await apiClient.get(`/organization/${id}`);
  return response.data.organization;
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
      const response = await apiClient.post('/organization', data);
      return response.data.organization;
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
      const response = await apiClient.patch(`/organization/${id}`, data);
      return response.data.organization;
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
      await apiClient.delete(`/organization/${id}`);
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
  const response = await apiClient.get(`/organization/${orgId}/members`);
  return response.data.members;
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
