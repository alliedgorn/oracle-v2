/**
 * Auto-link Den Book ID references in message content.
 * Converts various ID patterns to clickable markdown links.
 */
export function autolinkIds(content: string): string {
  if (!content) return '';
  return content
    // FT#80 → link to forum thread
    .replace(/\bFT#(\d+)\b/g, '[FT#$1](/forum?thread=$1)')
    // MSG#1234 → link to forum message
    .replace(/\bMSG#(\d+)\b/g, '[MSG#$1](/forum?msg=$1)')
    // T#56 → link to task on board
    .replace(/\bT#(\d+)\b/g, '[T#$1](/board?task=$1)')
    // thread #58, Thread #58, thread#58 → link to forum thread
    .replace(/\b[Tt]hread\s?#(\d+)\b/g, '[Thread #$1](/forum?thread=$1)')
    // task #139, Task #139, task#139 → link to board task
    .replace(/\b[Tt]ask\s?#(\d+)\b/g, '[Task #$1](/board?task=$1)')
    // schedule #14, Schedule #14 → link to scheduler
    .replace(/\b[Ss]chedule\s?#(\d+)\b/g, '[Schedule #$1](/scheduler)')
    // Spec #22, spec #22, spec#22 → link to spec review
    .replace(/\b[Ss]pec\s?#(\d+)\b/g, '[Spec #$1](/specs?spec=$1)')
    // @beast → link to beast profile (lowercase word after @, not @all/@team patterns)
    .replace(/@(karo|gnarl|zaghnal|bertus|leonard|mara|rax|pip|nyx|dex|flint|quill|snap|vigil|talon|sable|gorn)\b/gi,
      (_, name) => `[@${name.toLowerCase()}](/beast/${name.toLowerCase()})`);
}
