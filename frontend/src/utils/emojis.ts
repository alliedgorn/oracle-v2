/** Unified emoji groups — single source of truth for all emoji pickers */

export const EMOJI_GROUPS = [
  { label: 'Faces', emojis: ['😊','😂','🤣','😍','🥰','😘','😎','🤔','😅','😢','😤','🤬','💢','🙄','😴','🤗','😇','🫡','🫠','🥹','🤯','🥳','🤓'] },
  { label: 'Gestures', emojis: ['👍','👎','👏','🙌','🤝','✌️','🤞','💪','🫶','👋','🦾','🙏','🤙','👀','👊'] },
  { label: 'Animals', emojis: ['🐾','🐺','🐻','🦁','🐊','🐴','🦘','🦝','🦦','🐦‍⬛','🐙','🦔','🐍','🦅','🦉','🦍','🐘','🦏','🐋','🦬','🐂','🦣','🫎','🦈','🐗','🦛','🦨','🫏'] },
  { label: 'Heavy', emojis: ['🏋️','🏔️','🪨','🔨','💎','🗿','⚓','🛡️','🏰','🌋','💣','🧱','⛰️','💥','☄️','🏗️','⛓️','🪐','⚒️','🚂'] },
  { label: 'Objects', emojis: ['🔥','❤️','⭐','💯','🎉','🏆','🚀','💡','⚡','🎯','⚠️','✅','❌','✔️','🍖','🥩','📦','🐛','📌','🔧','📋'] },
] as const;

/** Flat set of all emojis for quick membership checks */
export const ALL_EMOJIS = new Set(EMOJI_GROUPS.flatMap(g => g.emojis));

/** Category lookup sets for categorizing arbitrary emojis into groups */
const CATEGORY_SETS = Object.fromEntries(
  EMOJI_GROUPS.map(g => [g.label, new Set(g.emojis)])
) as Record<string, Set<string>>;

/** Categorize an arbitrary list of emojis into the standard groups */
export function categorizeEmojis(emojis: string[]): { label: string; emojis: string[] }[] {
  const grouped: Record<string, string[]> = {};
  for (const g of EMOJI_GROUPS) grouped[g.label] = [];
  grouped['Other'] = [];

  for (const e of emojis) {
    let placed = false;
    for (const g of EMOJI_GROUPS) {
      if (CATEGORY_SETS[g.label].has(e)) {
        grouped[g.label].push(e);
        placed = true;
        break;
      }
    }
    if (!placed) grouped['Other'].push(e);
  }

  return Object.entries(grouped)
    .filter(([, v]) => v.length > 0)
    .map(([label, emojis]) => ({ label, emojis }));
}
