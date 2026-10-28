import { get, writable } from "svelte/store";
import { isLoginRedirecting } from './auth-client.ts';

export type GlobalMessageKind = "success" | "error" | "warning" | "info";

export type GlobalMessage = {
  id: string;
  key?: string;
  kind: GlobalMessageKind;
  message: string;
  title: string;
};

type MessageOptions = {
  key?: string;
  title?: string;
  duration?: number;
};

type TimerState = {
  remaining: number;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout> | null;
  pauseReasons: Set<"pointer" | "focus">;
};

const DEFAULT_DURATION = 4500;
const MAX_VISIBLE_MESSAGES = 4;
const defaultTitles: Record<GlobalMessageKind, string> = {
  success: "操作成功",
  error: "操作未完成",
  warning: "请注意",
  info: "系统消息",
};

const store = writable<GlobalMessage[]>([]);
const timerStates = new Map<string, TimerState>();
let nextId = 0;

function clearTimer(id: string): void {
  const state = timerStates.get(id);
  if (state?.timeout) clearTimeout(state.timeout);
  timerStates.delete(id);
}

function dismiss(id: string): void {
  clearTimer(id);
  store.update((messages) =>
    messages.filter((message) => message.id !== id),
  );
}

function startTimer(id: string, duration: number): void {
  const pauseReasons = new Set(timerStates.get(id)?.pauseReasons ?? []);
  clearTimer(id);
  const state: TimerState = {
    remaining: duration,
    startedAt: Date.now(),
    timeout:
      pauseReasons.size > 0 ? null : setTimeout(() => dismiss(id), duration),
    pauseReasons,
  };
  timerStates.set(id, state);
}

function show(
  kind: GlobalMessageKind,
  message: string,
  options: MessageOptions = {},
): string {
  if (isLoginRedirecting()) return '';
  const normalizedMessage = message.trim();
  if (!normalizedMessage) return "";

  const current = get(store);
  const existing = options.key
    ? current.find((item) => item.key === options.key)
    : undefined;
  const id = existing?.id ?? `global-message-${Date.now()}-${nextId++}`;
  const nextMessage: GlobalMessage = {
    id,
    key: options.key,
    kind,
    message: normalizedMessage,
    title: options.title?.trim() || defaultTitles[kind],
  };

  let removedIds: string[] = [];
  store.update((messages) => {
    const withoutExisting = messages.filter((item) => item.id !== id);
    const nextMessages = [...withoutExisting, nextMessage];
    const visibleMessages = nextMessages.slice(-MAX_VISIBLE_MESSAGES);
    removedIds = nextMessages
      .slice(0, Math.max(0, nextMessages.length - MAX_VISIBLE_MESSAGES))
      .map((item) => item.id);
    return visibleMessages;
  });
  for (const removedId of removedIds) clearTimer(removedId);
  startTimer(id, Math.max(3000, options.duration ?? DEFAULT_DURATION));
  return id;
}

function pause(id: string, reason: "pointer" | "focus"): void {
  const state = timerStates.get(id);
  if (!state || state.pauseReasons.has(reason)) return;
  state.pauseReasons.add(reason);
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
    state.remaining = Math.max(
      0,
      state.remaining - (Date.now() - state.startedAt),
    );
  }
}

function resume(id: string, reason: "pointer" | "focus"): void {
  const state = timerStates.get(id);
  if (!state) return;
  state.pauseReasons.delete(reason);
  if (state.pauseReasons.size > 0 || state.timeout) return;
  if (state.remaining <= 0) {
    dismiss(id);
    return;
  }
  state.startedAt = Date.now();
  state.timeout = setTimeout(() => dismiss(id), state.remaining);
}

export const globalMessages = {
  subscribe: store.subscribe,
  success: (message: string, options?: MessageOptions) =>
    show("success", message, options),
  error: (message: string, options?: MessageOptions) =>
    show("error", message, options),
  warning: (message: string, options?: MessageOptions) =>
    show("warning", message, options),
  info: (message: string, options?: MessageOptions) =>
    show("info", message, options),
  dismiss,
  pause,
  resume,
  clear: (): void => {
    for (const message of get(store)) clearTimer(message.id);
    store.set([]);
  },
};
