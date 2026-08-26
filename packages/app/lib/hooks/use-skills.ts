/**
 * Skills, as the app consumes them.
 *
 * A skill is an Agent Skill (<https://agentskills.io>): a directory with a
 * `SKILL.md` and optional bundled files, addressed by `name`. Three lists
 * matter and they answer different questions — the CATALOGUE is what exists,
 * INSTALLED is what this account can use, and MINE is what this account wrote or
 * imported. A skill can be in all three.
 *
 * Installing is what makes a skill reachable by the model, so every mutation
 * that changes an install invalidates `installed` — the composer's picker and
 * the system prompt's index are both downstream of it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';

/** The spec's fields, plus what Alia knows about where a skill came from. */
export interface Skill {
  readonly _id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly allowedTools: string[];
  readonly specMetadata: Record<string, string>;
  readonly source: 'builtin' | 'registry' | 'github' | 'upload' | 'authored';
  readonly sourceRepo: string | null;
  readonly sourcePath: string | null;
  readonly sourceUrl: string | null;
  readonly publisher: string | null;
  readonly tags: string[];
  readonly icon: string | null;
  readonly color: string | null;
  readonly ownerOxyUserId: string | null;
  readonly visibility: 'private' | 'public';
  readonly installCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstalledSkill extends Skill {
  readonly enabled: boolean;
  readonly autoInvoke: boolean;
  readonly pinnedVersion: number | null;
  readonly installedVersion: number;
}

export interface SkillFile {
  readonly path: string;
  readonly kind: 'reference' | 'script' | 'asset';
  readonly mime: string;
  readonly bytes: number;
}

export interface SkillDetail {
  readonly skill: Skill;
  readonly version: {
    readonly version: number;
    readonly body: string;
    readonly sourceCommit: string | null;
    readonly bytes: number;
    readonly createdAt: string;
  } | null;
  readonly files: SkillFile[];
}

export interface CatalogueFilters {
  query?: string;
  source?: Skill['source'];
  tag?: string;
  publisher?: string;
}

export function useSkillCatalogue(filters: CatalogueFilters = {}) {
  return useQuery({
    queryKey: queryKeys.skills.catalogue(filters as Record<string, string | undefined>),
    queryFn: async (): Promise<Skill[]> => {
      const response = await apiClient.get(API_ROUTES.skills.catalogue, { params: filters });
      return response.data.skills ?? [];
    },
  });
}

export function useInstalledSkills() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.skills.installed,
    enabled: isAuthenticated,
    queryFn: async (): Promise<InstalledSkill[]> => {
      const response = await apiClient.get(API_ROUTES.skills.installed);
      return response.data.skills ?? [];
    },
  });
}

export function useMySkills() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.skills.mine,
    enabled: isAuthenticated,
    queryFn: async (): Promise<Skill[]> => {
      const response = await apiClient.get(API_ROUTES.skills.mine);
      return response.data.skills ?? [];
    },
  });
}

export function useSkill(idOrName: string | undefined) {
  return useQuery({
    queryKey: queryKeys.skills.detail(idOrName ?? ''),
    enabled: Boolean(idOrName),
    queryFn: async (): Promise<SkillDetail> => {
      const response = await apiClient.get(API_ROUTES.skills.get(idOrName!));
      return response.data;
    },
  });
}

/**
 * Everything that changes what the model can reach.
 *
 * They share one invalidation set on purpose: installing, enabling and pinning
 * are the same question from the runtime's point of view — which skills does
 * this account's next turn carry.
 */
function useShelfMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.skills.installed });
      void client.invalidateQueries({ queryKey: ['skills', 'catalogue'] });
    },
  });
}

export function useInstallSkill() {
  return useShelfMutation((id: string) => apiClient.post(API_ROUTES.skills.install(id)));
}

export function useUninstallSkill() {
  return useShelfMutation((id: string) => apiClient.delete(API_ROUTES.skills.install(id)));
}

export interface InstallPatch {
  enabled?: boolean;
  autoInvoke?: boolean;
  /** `null` follows the latest version again. */
  pinnedVersion?: number | null;
}

export function useUpdateInstall() {
  return useShelfMutation(({ id, patch }: { id: string; patch: InstallPatch }) =>
    apiClient.patch(API_ROUTES.skills.install(id), patch),
  );
}

export interface ImportSkillInput {
  /** `owner/repo`, a github.com URL, or a tree URL into one skill directory. */
  source: string;
  name?: string;
}

export function useImportSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ImportSkillInput) => {
      const response = await apiClient.post(API_ROUTES.skills.import, input);
      return response.data as { commit: string; skills: Skill[]; rejected: { directory: string; reason: string }[] };
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export interface AuthoredSkillInput {
  /** A complete SKILL.md. The editor sends this; the fields below are for a first draft. */
  document?: string;
  name?: string;
  description?: string;
  body?: string;
  displayName?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  tags?: string[];
  icon?: string;
}

export function useCreateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthoredSkillInput) => {
      const response = await apiClient.post(API_ROUTES.skills.create, input);
      return response.data.skill as Skill;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

/**
 * A new version, which is how a skill's CONTENT changes.
 *
 * Editing `displayName` or tags is a patch; editing the instructions is a
 * version, because a pinned install has to be able to stay where it is.
 */
export function useCreateSkillVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: AuthoredSkillInput }) => {
      const response = await apiClient.post(API_ROUTES.skills.newVersion(id), input);
      return response.data as { skill: Skill; version: { version: number } | null; unchanged: boolean };
    },
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.skills.detail(variables.id) });
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export interface SkillPatch {
  displayName?: string;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  visibility?: 'private' | 'public';
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SkillPatch }) =>
      apiClient.patch(API_ROUTES.skills.update(id), patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useDeleteSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(API_ROUTES.skills.delete(id)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

/** A draft `SKILL.md` written by the model. Persists nothing; the editor saves it. */
export function useGenerateSkillDraft() {
  return useMutation({
    mutationFn: async ({ prompt, language }: { prompt: string; language: string }) => {
      const response = await apiClient.post(API_ROUTES.skills.generate, { prompt, language });
      return response.data as {
        document: string;
        frontmatter: { name: string; description: string };
        body: string;
        warnings: string[];
      };
    },
  });
}
