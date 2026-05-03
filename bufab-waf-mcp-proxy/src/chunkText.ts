const DEFAULT_MAX = 900;
const DEFAULT_OVERLAP = 120;

/**
 * Split markdown/plain text into overlapping chunks for embedding.
 */
export function chunkText(text: string, maxLen = DEFAULT_MAX, overlap = DEFAULT_OVERLAP): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
      continue;
    }
    if (buf.length + 2 + p.length <= maxLen) {
      buf = `${buf}\n\n${p}`;
    } else {
      merged.push(buf);
      buf = p;
    }
  }
  if (buf) {
    merged.push(buf);
  }

  const out: string[] = [];
  for (const block of merged) {
    if (block.length <= maxLen) {
      out.push(block);
      continue;
    }
    let start = 0;
    while (start < block.length) {
      const end = Math.min(start + maxLen, block.length);
      out.push(block.slice(start, end));
      if (end >= block.length) {
        break;
      }
      start = Math.max(end - overlap, start + 1);
    }
  }
  return out;
}
