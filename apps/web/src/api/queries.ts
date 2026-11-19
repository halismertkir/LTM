import type {
  ConversationSummary,
  Device,
  Me,
  MemoryKind,
  Page,
  PrivacySettings,
  Settings,
} from "@ltm/protocol";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./client";

export interface ConversationFilters {
  q: string;
  from?: number;
  to?: number;
}
export interface MemoryFilters {
  q: string;
  kind?: MemoryKind;
}

export const qk = {
  authStatus: ["authStatus"] as const,
  me: ["me"] as const,
  devices: ["devices"] as const,
  streams: ["streams"] as const,
  settings: ["settings"] as const,
  catalog: ["providerCatalog"] as const,
  conversationsAll: ["conversations"] as const,
  conversations: (f: ConversationFilters) => ["conversations", f] as const,
  conversation: (id: string) => ["conversation", id] as const,
  memoriesAll: ["memories"] as const,
  memories: (f: MemoryFilters) => ["memories", f] as const,
};

const PAGE_SIZE = 30;

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, retry: false });
}

/** Only call below the auth gate, where `/me` has resolved. */
export function useMeData(): Me {
  const { data } = useMe();
  if (!data) throw new Error("useMeData used before /me resolved");
  return data;
}

export function useDevices() {
  return useQuery({ queryKey: qk.devices, queryFn: api.devices });
}

export function useDeviceMap(): Map<string, Device> {
  const devices = useDevices();
  return useMemo(() => new Map((devices.data ?? []).map((d) => [d.id, d])), [devices.data]);
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings });
}

export function useCatalog() {
  return useQuery({ queryKey: qk.catalog, queryFn: api.providerCatalog, staleTime: 5 * 60_000 });
}

export function useConversations(f: ConversationFilters) {
  return useInfiniteQuery({
    queryKey: qk.conversations(f),
    queryFn: ({ pageParam, signal }) =>
      api.conversations(
        { q: f.q || undefined, from: f.from, to: f.to, limit: PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: qk.conversation(id),
    queryFn: ({ signal }) => api.conversation(id, signal),
  });
}

export function useMemories(f: MemoryFilters) {
  return useInfiniteQuery({
    queryKey: qk.memories(f),
    queryFn: ({ pageParam, signal }) =>
      api.memories(
        { q: f.q || undefined, kind: f.kind, limit: PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

type ConvPages = InfiniteData<Page<ConversationSummary>, string | undefined>;

function filtersOf(key: readonly unknown[]): ConversationFilters | undefined {
  return key[1] as ConversationFilters | undefined;
}

/**
 * Apply a live `conversation_updated` event to every cached timeline. Cards that are
 * already listed are replaced in place; a new conversation is inserted at the top of
 * unfiltered timelines, and filtered ones are refetched because we cannot evaluate `q`.
 */
export function upsertConversation(qc: QueryClient, conv: ConversationSummary): void {
  for (const query of qc.getQueryCache().findAll({ queryKey: qk.conversationsAll })) {
    const data = query.state.data as ConvPages | undefined;
    if (!data) continue;
    const found = data.pages.some((p) => p.items.some((c) => c.id === conv.id));
    const f = filtersOf(query.queryKey);
    if (found) {
      qc.setQueryData<ConvPages>(query.queryKey, {
        ...data,
        pages: data.pages.map((p) => ({
          ...p,
          items: p.items.map((c) => (c.id === conv.id ? conv : c)),
        })),
      });
    } else if (f && !f.q && f.from === undefined && f.to === undefined) {
      const [first, ...rest] = data.pages;
      if (!first) continue;
      const items = [conv, ...first.items].sort((a, b) => b.startMs - a.startMs);
      qc.setQueryData<ConvPages>(query.queryKey, {
        ...data,
        pages: [{ ...first, items }, ...rest],
      });
    } else {
      void qc.invalidateQueries({ queryKey: query.queryKey });
    }
  }
  void qc.invalidateQueries({ queryKey: qk.conversation(conv.id) });
}

export function removeConversation(qc: QueryClient, id: string): void {
  qc.setQueriesData<ConvPages>({ queryKey: qk.conversationsAll }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })),
        }
      : data,
  );
  qc.removeQueries({ queryKey: qk.conversation(id) });
}

/** The account-wide kill switch. Writes the full PrivacySettings object the route expects. */
export function usePauseCapture() {
  const qc = useQueryClient();
  const settings = useSettings();
  const mutation = useMutation({
    mutationFn: async (paused: boolean) => {
      const current: Settings =
        settings.data ?? (await qc.fetchQuery({ queryKey: qk.settings, queryFn: api.settings }));
      const body: PrivacySettings = { ...current.privacy, ingestPaused: paused };
      return api.putPrivacy(body);
    },
    onSuccess: (privacy) => {
      qc.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, privacy } : s));
      qc.setQueryData<Me>(qk.me, (m) => (m ? { ...m, ingestPaused: privacy.ingestPaused } : m));
    },
  });
  return mutation;
}
