export type ResearchContentBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: string[] };

export function parseResearchContent(content: string): ResearchContentBlock[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const blocks: ResearchContentBlock[] = [];
  let pending: string[] = [];
  const flush = () => { blocks.push(...parseTextBlocks(pending.join("\n"))); pending = []; };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll("\\|", "|").replaceAll("<br>", "\n"));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "", next = lines[i + 1] ?? "";
    if (line.trim().startsWith("|") && /^\s*\|[\s:|\-]+\|\s*$/.test(next) && next.includes("---")) {
      flush(); const headers = cells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i]?.trim().startsWith("|")) { rows.push(cells(lines[i]!)); i++; }
      i--; blocks.push({ kind: "table", headers, rows });
    } else pending.push(line);
  }
  flush(); return blocks;
}

function parseTextBlocks(content: string): ResearchContentBlock[] {
  return content
    .replaceAll("\r\n", "\n")
    .trim()
    .split(/\n{2,}/)
    .map((rawBlock): ResearchContentBlock | null => {
      const block = rawBlock.trim();
      if (!block) return null;

      const heading = block.match(/^(#{1,6})\s+([^\n]+)$/);
      const headingMarker = heading?.[1];
      const headingText = heading?.[2];
      if (headingMarker && headingText) {
        return {
          kind: "heading",
          level: headingMarker.length <= 2 ? 2 : 3,
          text: headingText.trim(),
        };
      }

      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const ordered = lines.length > 0 && lines.every((line) => /^\d+[.、]\s*/.test(line));
      const unordered = lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line));
      if (ordered || unordered) {
        return {
          kind: "list",
          ordered,
          items: lines.map((line) => line.replace(ordered ? /^\d+[.、]\s*/ : /^[-*]\s+/, "")),
        };
      }

      return { kind: "paragraph", text: block };
    })
    .filter((block): block is ResearchContentBlock => block !== null);
}
