import { AUTH_SESSION_HINT_STORAGE_KEY, AUTH_USER_ID_STORAGE_KEY } from "./storageKeys";

export const DEFAULT_USER_ID = "local-user";
export { AUTH_SESSION_HINT_STORAGE_KEY, AUTH_USER_ID_STORAGE_KEY };

export function getCurrentUserId(): string {
  return localStorage.getItem(AUTH_USER_ID_STORAGE_KEY) ?? DEFAULT_USER_ID;
}

export function setCurrentUserId(userId: string): void {
  const value = userId.trim();
  if (!value) {
    localStorage.removeItem(AUTH_USER_ID_STORAGE_KEY);
    return;
  }
  localStorage.setItem(AUTH_USER_ID_STORAGE_KEY, value);
}

export function clearCurrentUserId(): void {
  localStorage.removeItem(AUTH_USER_ID_STORAGE_KEY);
}

export function hasAuthSessionHint(): boolean {
  return localStorage.getItem(AUTH_SESSION_HINT_STORAGE_KEY) === "1";
}

export function setAuthSessionHint(): void {
  localStorage.setItem(AUTH_SESSION_HINT_STORAGE_KEY, "1");
}

export function clearAuthSessionHint(): void {
  localStorage.removeItem(AUTH_SESSION_HINT_STORAGE_KEY);
}
