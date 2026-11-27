// SPDX-License-Identifier: Apache-2.0
export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const listOr = (value, fallback = []) => Array.isArray(value) ? value : fallback;

export function stored(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(fallback) ? Array.isArray(value) : isRecord(value)) return value;
  } catch { /* Recover just this key. */ }
  localStorage.removeItem(key);
  return fallback;
}
