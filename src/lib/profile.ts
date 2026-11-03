// Project profile (docs/cards.md "Project profile"): what a project can do today and what it still lacks, read from its
// latest code, next to the goal's `why`. Milestone progress counts closed cards, so it cannot say this. One optional
// `profile` block per goal file; a writer replaces the whole block and the server stamps as_of and by.

export const MAX_PROFILE_ITEMS = 10;
export const MAX_PROFILE_AREA = 40;
export const MAX_PROFILE_TEXT = 200;

export interface ProfileFeature { area: string; text: string; ref?: string }
export interface ProfileGap { text: string; must: boolean; why?: string }
export interface Profile { as_of: string; by: string; features: ProfileFeature[]; gaps: ProfileGap[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of at most `max` characters, trimmed; `need` = must not be empty. '' for an absent optional value. */
function line(v: unknown, where: string, max: number, need: boolean): string {
  if (v === undefined || v === null) { if (need) throw new Error(`${where} is missing`); return ''; }
  if (typeof v !== 'string') throw new Error(`${where} must be a string`);
  const s = v.trim();
  if (need && !s) throw new Error(`${where} is empty`);
  if (s.length > max || /[\r\n]/.test(s)) throw new Error(`${where} must be one line of at most ${max} characters`);
  return s;
}

function list(v: unknown, where: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${where} must be a list`);
  if (v.length > MAX_PROFILE_ITEMS) throw new Error(`${where} has ${v.length} items (at most ${MAX_PROFILE_ITEMS})`);
  return v;
}

function onlyKeys(o: Record<string, unknown>, keys: string[], where: string, what: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${where}.${k} is not a ${what} field`);
}

/** The writer's part (features, gaps), checked and trimmed. as_of and by may be sent back as read; they are ignored.
 *  Throws an Error with a plain message. */
export function cleanProfileInput(v: unknown): Pick<Profile, 'features' | 'gaps'> {
  if (!isObj(v)) throw new Error('profile must be {features, gaps}');
  onlyKeys(v, ['features', 'gaps', 'as_of', 'by'], 'profile', 'profile');
  const features = list(v.features, 'profile.features').map((f, i) => {
    const w = `profile.features[${i}]`;
    if (!isObj(f)) throw new Error(`${w} must be {area, text, ref?}`);
    onlyKeys(f, ['area', 'text', 'ref'], w, 'feature');
    const ref = line(f.ref, `${w}.ref`, MAX_PROFILE_TEXT, false);
    return { area: line(f.area, `${w}.area`, MAX_PROFILE_AREA, true), text: line(f.text, `${w}.text`, MAX_PROFILE_TEXT, true), ...(ref ? { ref } : {}) };
  });
  const gaps = list(v.gaps, 'profile.gaps').map((g, i) => {
    const w = `profile.gaps[${i}]`;
    if (!isObj(g)) throw new Error(`${w} must be {text, must, why?}`);
    onlyKeys(g, ['text', 'must', 'why'], w, 'gap');
    if (typeof g.must !== 'boolean') throw new Error(`${w}.must must be true or false`);
    const why = line(g.why, `${w}.why`, MAX_PROFILE_TEXT, false);
    return { text: line(g.text, `${w}.text`, MAX_PROFILE_TEXT, true), must: g.must, ...(why ? { why } : {}) };
  });
  if (!features.length && !gaps.length) throw new Error('profile needs at least one feature or gap (send null to remove it)');
  return { features, gaps };
}

/** A stored profile (as read from a goal file): the writer's part plus the stamps. Throws on any problem. */
export function cleanStoredProfile(v: unknown): Profile {
  const p = cleanProfileInput(v);
  const o = v as Record<string, unknown>;
  return { as_of: line(o.as_of, 'profile.as_of', 40, true), by: line(o.by, 'profile.by', 120, true), ...p };
}
