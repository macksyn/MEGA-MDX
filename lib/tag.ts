// lib/tag.ts — one place for building WhatsApp @mentions (LID-safe)

export interface Taggable {
  id:     string;    // JID as WhatsApp gave it: 1234@lid or 234801...@s.whatsapp.net
  phone?: string;    // resolved phone number, if known (digits only)
  name?:  string;    // display name, if known
  aliases?: string[]; // other names this person goes by (pushName, first name, ...)
  alt?:   string[];  // other numbers that identify the same person (LID <-> phone)
}

/** Bare number part: '1234:5@lid' -> '1234' (strips server AND device suffix). */
export const bare = (jid: string): string => jid.split('@')[0].split(':')[0];

/** Normalised JID for the `mentions` array: '1234:5@lid' -> '1234@lid'. */
export const toJid = (jid: string): string =>
  `${bare(jid)}@${jid.split('@')[1] || 's.whatsapp.net'}`;

/** The visible text part: '@1234'. Must match the number inside the mentioned JID. */
export const tag = (jid: string): string => `@${bare(jid)}`;

/** Tag from any record that has a userId (e.g. BirthdayDoc). */
export const tagOf = (p: { userId: string }): string => tag(p.userId);

/** Many people at once -> "@a, @b and @c" + the matching mentions array. */
export function tagList(jids: string[]): { text: string; mentions: string[] } {
  const unique = [...new Set(jids.map(toJid))];
  const tags   = unique.map(tag);
  const text   = tags.length <= 1
    ? (tags[0] || '')
    : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
  return { text, mentions: unique };
}

/** Build a ready-to-send payload: { text, mentions }. */
export const withMentions = (text: string, jids: string[]) =>
  ({ text, mentions: [...new Set(jids.map(toJid))] });

// Escape for RegExp, and treat straight/curly apostrophes as the same character
// (models usually type ' even when the WhatsApp name has ’).
const esc = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’‘`]/g, "['’‘`]");

/**
 * Repair text written by the AI: turns raw LIDs, phone numbers and "@Name"
 * into proper "@<id>" tags and returns the mentions array to send with it.
 * Idempotent — running it twice changes nothing.
 *
 * opts.plainIds: people who must NOT be tagged (e.g. the person the bot is replying
 * to). "@Alex" / their raw ID is written as plain "Alex" instead, with no mention.
 */
export function fixTags(
  text: string,
  people: Taggable[],
  opts: { plainIds?: string[] } = {}
): { text: string; mentions: string[] } {
  const plain    = new Set((opts.plainIds || []).map(bare));
  const isPlain  = (p: Taggable) => plain.has(bare(p.id));
  const mentions = new Set<string>();
  const byDigits = new Map<string, Taggable>();

  for (const p of people) {
    byDigits.set(bare(p.id), p);
    if (p.phone) byDigits.set(p.phone.replace(/\D/g, ''), p);
    for (const a of p.alt || []) byDigits.set(a.replace(/\D/g, ''), p);
  }

  // 1) "@Name" -> "@<id>"  (every known name/alias, longest first so "Ada Obi" wins over "Ada")
  const names: { name: string; p: Taggable }[] = [];
  for (const p of people) {
    for (const n of [p.name, ...(p.aliases || [])]) {
      if (n && n.trim()) names.push({ name: n.trim(), p });
    }
  }
  names.sort((a, b) => b.name.length - a.name.length);
  for (const { name, p } of names) {
    const re = new RegExp(`@${esc(name)}(?![\\w])`, 'gi');
    text = text.replace(re, () => {
      if (isPlain(p)) return name;                 // talk TO them, don't ping them
      mentions.add(toJid(p.id));
      return tag(p.id);
    });
  }

  // 2) raw LID / phone number (with or without @, :device, @lid, @s.whatsapp.net) -> "@<id>"
  text = text.replace(
    /(?<!\d)@?(\d{6,20})(?::\d+)?(?:@(?:lid|s\.whatsapp\.net))?(?!\d)/g,
    (match, digits: string) => {
      const p = byDigits.get(digits);
      if (!p) return match;
      if (isPlain(p)) return p.name || 'you';
      mentions.add(toJid(p.id));
      return tag(p.id);
    }
  );

  return { text, mentions: [...mentions] };
}
