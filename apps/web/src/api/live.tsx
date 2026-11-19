import { type LiveEvent, type StreamInfo, zLiveEvent } from "@ltm/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer } from "react";
import { api, urls } from "./client";
import { qk, removeConversation, upsertConversation } from "./queries";

export interface LiveCaption {
  key: string;
  text: string;
  startMs: number;
  origin: "server_stt" | "edge_stt";
}

interface LiveState {
  streams: Record<string, StreamInfo>;
  captions: Record<string, LiveCaption[]>;
  connected: boolean;
}

type Action =
  | { type: "reset"; streams: StreamInfo[] }
  | { type: "connected"; value: boolean }
  | { type: "event"; event: LiveEvent };

const MAX_CAPTIONS = 3;

function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "reset": {
      const streams: Record<string, StreamInfo> = {};
      for (const s of action.streams) if (s.active) streams[s.id] = s;
      const captions: Record<string, LiveCaption[]> = {};
      for (const id of Object.keys(streams)) captions[id] = state.captions[id] ?? [];
      return { ...state, streams, captions };
    }
    case "connected":
      return state.connected === action.value ? state : { ...state, connected: action.value };
    case "event": {
      const e = action.event;
      if (e.type === "stream_started") {
        return { ...state, streams: { ...state.streams, [e.stream.id]: e.stream } };
      }
      if (e.type === "stream_ended") {
        const { [e.streamId]: _gone, ...streams } = state.streams;
        const { [e.streamId]: _c, ...captions } = state.captions;
        return { ...state, streams, captions };
      }
      if (e.type === "segment") {
        const prev = state.captions[e.streamId] ?? [];
        const caption: LiveCaption = {
          key: e.segment.id ?? `${e.segment.startMs}-${prev.length}`,
          text: e.segment.text,
          startMs: e.segment.startMs,
          origin: e.segment.origin,
        };
        // Re-delivered segments (same id) replace the earlier caption instead of duplicating it.
        const next = [...prev.filter((c) => c.key !== caption.key), caption]
          .sort((a, b) => a.startMs - b.startMs)
          .slice(-MAX_CAPTIONS);
        return { ...state, captions: { ...state.captions, [e.streamId]: next } };
      }
      return state;
    }
  }
}

export interface Live {
  streams: StreamInfo[];
  captions: Record<string, LiveCaption[]>;
  connected: boolean;
}

const LiveContext = createContext<Live>({ streams: [], captions: {}, connected: false });

/** Subscribes to `/events` (SSE) and keeps the query cache in step with what devices hear. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(reducer, { streams: {}, captions: {}, connected: false });
  const streams = useQuery({ queryKey: qk.streams, queryFn: api.activeStreams });

  useEffect(() => {
    if (streams.data) dispatch({ type: "reset", streams: streams.data });
  }, [streams.data]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(urls.events());
    es.onopen = () => {
      dispatch({ type: "connected", value: true });
      // Events that happened while disconnected are gone; resync the snapshot.
      void qc.invalidateQueries({ queryKey: qk.streams });
    };
    es.onerror = () => dispatch({ type: "connected", value: false });
    es.onmessage = (msg: MessageEvent<string>) => {
      let json: unknown;
      try {
        json = JSON.parse(msg.data);
      } catch {
        return;
      }
      const parsed = zLiveEvent.safeParse(json);
      if (!parsed.success) return;
      const event = parsed.data;
      dispatch({ type: "event", event });
      switch (event.type) {
        case "conversation_updated":
          upsertConversation(qc, event.conversation);
          break;
        case "conversation_deleted":
          removeConversation(qc, event.conversationId);
          break;
        case "memory_created":
          void qc.invalidateQueries({ queryKey: qk.memoriesAll });
          break;
        case "stream_started":
        case "stream_ended":
          // Device `online` flags follow open streams.
          void qc.invalidateQueries({ queryKey: qk.devices });
          break;
        case "segment":
          break;
      }
    };
    return () => es.close();
  }, [qc]);

  const value = useMemo<Live>(
    () => ({
      streams: Object.values(state.streams).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      captions: state.captions,
      connected: state.connected,
    }),
    [state],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}
