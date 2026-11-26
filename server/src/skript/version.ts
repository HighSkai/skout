/** Skript versions such as `2.16.2`, `2.17.0-pre1` or `2.2-dev36`, compared numerically. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-releases (`-pre1`, `-beta2`, `-dev36`) sort before the release. */
  readonly pre: boolean;
  readonly text: string;
}

const VERSION = /(\d+)\.(\d+)(?:\.(\d+))?(-[\w.]+)?/;

export function parseVersion(text: string | undefined | null): Version | undefined {
  if (!text) return undefined;
  const m = VERSION.exec(text);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    pre: Boolean(m[4]) && /^-(pre|beta|alpha|dev|rc)/i.test(m[4]),
    text: m[0],
  };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || Number(b.pre) - Number(a.pre);
}

/** True when `version` is at least `major.minor[.patch]`. */
export function atLeast(version: Version, major: number, minor: number, patch = 0): boolean {
  return compareVersions(version, { major, minor, patch, pre: false, text: '' }) >= 0;
}

/**
 * The earliest version named in a docs `since` field, which is free text such
 * as `"2.5.2, 2.9.0 (enforce, offline players)"` or `"unknown (before 2.1)"`.
 */
export function earliestSince(since: string | undefined): Version | undefined {
  if (!since) return undefined;
  let earliest: Version | undefined;
  for (const match of since.matchAll(new RegExp(VERSION, 'g'))) {
    const v = parseVersion(match[0]);
    if (v && (!earliest || compareVersions(v, earliest) < 0)) earliest = v;
  }
  return earliest;
}
