import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import type { GrantableConnector } from '@/lib/constants/capability-families';
import { queryKeys } from '@/lib/hooks/query-keys';
import type { LinkedFile, LinkedSkill } from '@/lib/hooks/agents/use-agent-autosave';
import { useLibraryStore, type LibraryFile } from '@/lib/stores/library-store';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * What the agent editor offers to attach: skills, connectors, library files.
 *
 * Each of these used to be a `useEffect` + `useState` pair inside the editor
 * route. They are asked for when the editor opens, not when a picker does, so
 * the editor calls these hooks and hands the answers down.
 */

/** One page of skills, or none: a failure leaves the picker short, not broken. */
async function skillsAt(url: string): Promise<LinkedSkill[]> {
  try {
    const response = await apiClient.get(url);
    return response.data.skills ?? [];
  } catch {
    return [];
  }
}

/**
 * The catalogue and this account's own, one entry per id.
 *
 * The owner's own copy wins over the catalogue's when both list a skill, since
 * it is the one they can see edited.
 */
export function mergeSkillsById(
  catalogue: readonly LinkedSkill[],
  mine: readonly LinkedSkill[],
): LinkedSkill[] {
  const byId = new Map<string, LinkedSkill>();
  for (const skill of [...catalogue, ...mine]) byId.set(skill._id, skill);
  return [...byId.values()];
}

/**
 * Skills an agent may be given: the public catalogue plus this account's own.
 *
 * Attaching one is its own authorization — the agent's skills reach its
 * conversations whether or not the person also installed them.
 */
export function useAttachableSkills() {
  return useQuery({
    queryKey: queryKeys.skills.attachable,
    queryFn: async (): Promise<LinkedSkill[]> => {
      const [catalogue, mine] = await Promise.all([
        skillsAt(API_ROUTES.skills.catalogue),
        skillsAt(API_ROUTES.skills.mine),
      ]);
      return mergeSkillsById(catalogue, mine);
    },
  });
}

/**
 * The rows this owner can grant, from the one endpoint that knows all four
 * instanced families.
 *
 * Fetched once for the editor rather than per section: MCP connectors, Oxy
 * apps, integrations and this owner's other agents are four different tables
 * and this is the only place that joins them into grant strings. A failure
 * leaves the section empty — the rest of the editor does not depend on it.
 *
 * The agent being edited goes with the request so the server can leave it out
 * of its own list.
 */
export function useGrantableConnectors(agentId: string) {
  return useQuery({
    queryKey: queryKeys.agents.capabilityConnectors(agentId),
    queryFn: async (): Promise<GrantableConnector[]> => {
      try {
        const response = await apiClient.get<{
          connectors: GrantableConnector[];
        }>(API_ROUTES.agents.capabilityConnectors(agentId));
        return response.data.connectors ?? [];
      } catch {
        return [];
      }
    },
  });
}

/** The person's library, loaded when the editor opens, for the knowledge picker. */
export function useKnowledgeLibrary(): LibraryFile[] {
  const libraryFiles = useLibraryStore((state) => state.files);
  const loadLibraryFiles = useLibraryStore((state) => state.loadFiles);
  useEffect(() => {
    loadLibraryFiles();
  }, [loadLibraryFiles]);
  return libraryFiles;
}

/** The skills still attachable: not already linked, and matching the search. */
export function unlinkedSkills(
  all: readonly LinkedSkill[],
  linked: readonly LinkedSkill[],
  search: string,
): LinkedSkill[] {
  const needle = search.toLowerCase();
  return all.filter(
    (skill) =>
      !linked.some((entry) => entry._id === skill._id) &&
      (!search ||
        skill.displayName.toLowerCase().includes(needle) ||
        skill.name.includes(needle)),
  );
}

/** The library files still attachable: not already linked, and matching the search. */
export function unlinkedFiles(
  all: readonly LibraryFile[],
  linked: readonly LinkedFile[],
  search: string,
): LibraryFile[] {
  return all.filter(
    (file) =>
      !linked.some((entry) => entry._id === file._id) &&
      (!search || file.name.toLowerCase().includes(search.toLowerCase())),
  );
}

/** A library file as the agent row links it. */
export function linkedFileFrom(file: LibraryFile): LinkedFile {
  return {
    _id: file._id,
    name: file.name,
    type: file.type,
    category: file.category,
    url: file.url,
  };
}
