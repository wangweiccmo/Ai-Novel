import { createContext, useContext } from "react";

export type AuthUser = {
  id: string;
  displayName: string;
  isAdmin: boolean;
};

export type AuthSession = {
  expireAt: number | null;
};

export type AuthStatus = "loading" | "authenticated" | "dev_fallback" | "unauthenticated";

export type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  session: AuthSession | null;
};

export function computeNextAuthRefreshDelayMs({
  expireAtSec,
  nowMs = Date.now(),
}: {
  expireAtSec: number | null;
  nowMs?: number;
}): number {
  const defaultDelayMs = 5 * 60_000;
  const minDelayMs = 30_000;
  const clockSkewGuardSec = 60;
  const maxLeadSec = 5 * 60;
  const minLeadSec = 30;
  const leadFraction = 0.2;
  const maxTimeoutDelayMs = 2_000_000_000;

  if (typeof expireAtSec !== "number") return defaultDelayMs;
  if (!Number.isFinite(expireAtSec)) return defaultDelayMs;

  const nowSec = nowMs / 1000;
  const remainingSec = expireAtSec - (nowSec + clockSkewGuardSec);
  if (!Number.isFinite(remainingSec)) return defaultDelayMs;
  if (remainingSec <= 0) return minDelayMs;

  const leadSec = Math.min(maxLeadSec, Math.max(minLeadSec, Math.floor(remainingSec * leadFraction)));
  const targetDelayMs = Math.floor((remainingSec - leadSec) * 1000);

  if (!Number.isFinite(targetDelayMs)) return defaultDelayMs;
  if (targetDelayMs <= minDelayMs) return minDelayMs;
  if (targetDelayMs >= maxTimeoutDelayMs) return maxTimeoutDelayMs;
  return targetDelayMs;
}

export type AuthApi = AuthState & {
  refresh: (opts?: { silent?: boolean; allowAuthProbe?: boolean }) => Promise<void>;
  login: (args: { userId: string; password: string }) => Promise<void>;
  register: (args: { userId: string; password: string; displayName?: string; email?: string }) => Promise<void>;
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
