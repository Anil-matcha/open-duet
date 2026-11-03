import { request } from "./api";

export interface UserProfile {
  name: string | null;
  avatar_url: string | null;
  bio: string | null;
  email: string | null;
  user_id: string | null;
  is_admin: boolean;
  updated_at?: string | null;
}

export interface ProfileDay {
  date: string;
  weekday: number; // 0=Sunday..6=Saturday
  tokens: number;
  messages: number;
}

export interface ProfileStats {
  days: ProfileDay[];
  tokens: number;
  messages: number;
  cost: number | null;
  activeDays: number;
  peak: { date: string; tokens: number; messages?: number } | null;
  currentStreak: number;
  currentStreakStart: string | null;
  longestStreak: number;
  longestStreakDates: { start: string; end: string } | null;
  busiestWeekday: number | null;
  providers: Array<{ provider: string; tokens: number; share: number }>;
  models: Array<{ provider: string; model: string; tokens: number; share: number }>;
  teammates: Array<{ agent: { id: number; name: string }; tokens: number }>;
}

const PROFILE_CACHE_KEY = "open_duet_user_profile_cache";

export function readCachedProfile(): Partial<UserProfile> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCachedProfile(profile: Partial<UserProfile>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage quota or blocked errors
  }
}

export const profileApi = {
  getProfile: async (): Promise<UserProfile> => {
    const profile = await request<UserProfile>("/profile");
    writeCachedProfile(profile);
    return profile;
  },

  updateProfile: async (data: {
    name?: string | null;
    avatar_url?: string | null;
    bio?: string | null;
  }): Promise<UserProfile> => {
    const res = await request<UserProfile & { ok: boolean }>("/profile", {
      method: "PUT",
      body: JSON.stringify(data),
    });
    writeCachedProfile(res);
    return res;
  },

  getAnnualStats: async (days: number = 365): Promise<ProfileStats> => {
    return await request<ProfileStats>(`/usage/annual?days=${days}`);
  },
};

