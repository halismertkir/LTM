import type {
  ConversationSummary,
  DayDetail,
  DaySummary,
  Device,
  Me,
  MemoryKind,
  Page,
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
import { api, isApiError } from "./client";

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
  daysAll: ["days"] as const,
  dayAll: ["day"] as const,
  day: (date: string) => ["day", date] as const,
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

export function useDays() {
  return useInfiniteQuery({
    queryKey: qk.daysAll,
    queryFn: ({ pageParam, signal }) => api.days({ limit: 14, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** A day on which nothing was captured — what the server's 404 for a day means. */
export function emptyDay(date: string, timeZone: string): DayDetail {
  return {
    date,
    status: "none",
    headline: null,
    summary: null,
    conversationCount: 0,
    speechMinutes: 0,
    openActionItems: 0,
    updatedAt: null,
    timeZone,
    digest: null,
    highlights: [],
    decisions: [],
    people: [],
    conversations: [],
    actionItems: [],
    statusDetail: null,
  };
}

/**
 * One day's detail. The server answers 404 for a day on which nothing was captured; that is
 * an empty day, not an error. `enabled: false` skips the request when the day list already
 * shows there is nothing (the caller then renders `emptyDay`).
 */
export function useDay(date: string, tz: string, enabled = true) {
  return useQuery({
    queryKey: qk.day(date),
    enabled,
    queryFn: async ({ signal }) => {
      try {
        return await api.day(date, signal);
      } catch (e) {
        if (isApiError(e, "not_found")) return emptyDay(date, tz);
        throw e;
      }
    },
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

type DayPages = InfiniteData<Page<DaySummary>, string | undefined>;

/** Apply a live `day_updated` event: replace the listed day, or add a new one at the top. */
export function upsertDay(qc: QueryClient, day: DaySummary): void {
  qc.setQueryData<DayPages>(qk.daysAll, (data) => {
    if (!data) return data;
    const found = data.pages.some((p) => p.items.some((d) => d.date === day.date));
    if (found) {
      return {
        ...data,
        pages: data.pages.map((p) => ({
          ...p,
          items: p.items.map((d) => (d.date === day.date ? day : d)),
        })),
      };
    }
    const [first, ...rest] = data.pages;
    if (!first) return data;
    const items = [day, ...first.items].sort((a, b) => b.date.localeCompare(a.date));
    return { ...data, pages: [{ ...first, items }, ...rest] };
  });
  qc.setQueryData<DayDetail>(qk.day(day.date), (d) => (d ? { ...d, ...day } : d));
  // The digest text, highlights and lists are not in the summary event.
  void qc.invalidateQueries({ queryKey: qk.day(day.date) });
}

/** Patch a conversation inside any cached day detail that lists it. */
export function patchDayConversation(qc: QueryClient, conv: ConversationSummary): void {
  for (const query of qc.getQueryCache().findAll({ queryKey: qk.dayAll })) {
    const data = query.state.data as DayDetail | undefined;
    if (!data) continue;
    if (data.conversations.some((c) => c.id === conv.id)) {
      qc.setQueryData<DayDetail>(query.queryKey, {
        ...data,
        conversations: data.conversations.map((c) => (c.id === conv.id ? conv : c)),
      });
    } else {
      // A new conversation may belong to this day; only the server knows its zone boundaries.
      void qc.invalidateQueries({ queryKey: query.queryKey });
    }
  }
}

/** Reflect the kill switch everywhere it is cached. */
export function setIngestPaused(qc: QueryClient, paused: boolean): void {
  qc.setQueryData<Settings>(qk.settings, (s) =>
    s ? { ...s, privacy: { ...s.privacy, ingestPaused: paused } } : s,
  );
  qc.setQueryData<Me>(qk.me, (m) => (m ? { ...m, ingestPaused: paused } : m));
}

/** The account-wide kill switch (`POST /capture/pause`). */
export function usePauseCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => api.capturePause(paused),
    onSuccess: (state) => setIngestPaused(qc, state.ingestPaused),
  });
}
