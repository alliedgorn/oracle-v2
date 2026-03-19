/**
 * Auto-link Den Book ID references in message content.
 * Converts FT#N, MSG#N, T#N patterns to clickable markdown links.
 */
export function autolinkIds(content: string): string {
  return content
    // FT#80 → link to forum thread
    .replace(/\bFT#(\d+)\b/g, '[FT#$1](/forum?thread=$1)')
    // MSG#1234 → link to forum message (thread context needed, link to search)
    .replace(/\bMSG#(\d+)\b/g, '[MSG#$1](/forum?msg=$1)')
    // T#56 → link to task on board
    .replace(/\bT#(\d+)\b/g, '[T#$1](/board?task=$1)');
}
