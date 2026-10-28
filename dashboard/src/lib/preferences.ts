export const PREFERENCES_STORAGE_KEY = "eastmoney:preferences:v1";

export type MarketColorConvention =
  | "red-up-green-down"
  | "green-up-red-down";

export interface UserPreferences {
  marketColorConvention: MarketColorConvention;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  marketColorConvention: "red-up-green-down",
};

export function readPreferences(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): UserPreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(
      storage.getItem(PREFERENCES_STORAGE_KEY) ?? "null",
    ) as Partial<UserPreferences> | null;
    return {
      marketColorConvention:
        parsed?.marketColorConvention === "green-up-red-down"
          ? "green-up-red-down"
          : "red-up-green-down",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(
  preferences: UserPreferences,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  applyPreferences(preferences);
}

export function applyPreferences(preferences: UserPreferences): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.marketColorConvention =
    preferences.marketColorConvention;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
