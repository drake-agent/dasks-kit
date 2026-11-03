// Allowed task lanes: the built-in LANES (claude, codex, none and the server-managed spec-rework/failed-terminal) plus
// config.json `lanes`. Never narrower than the built-in list, so a config change can never make old data invalid.
import { CONFIG_LANES, LANES } from './schema.ts';

export function isAllowedLane(lane: string): boolean {
  return typeof lane === 'string' && ((LANES as readonly string[]).includes(lane) || CONFIG_LANES.includes(lane));
}

/** Sorted lane names for pickers (the board UI). */
export function laneList(): string[] {
  return [...new Set([...LANES, ...CONFIG_LANES])].sort();
}

/** Changes whenever the lane list changes: part of any cache built from lane checks. */
export function lanesKey(): string {
  return CONFIG_LANES.join(',');
}
