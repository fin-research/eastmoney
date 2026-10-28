export function stripCommentarySourceLinks(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/giu, "$1")
    .replace(/<(?:https?:\/\/|www\.)[^>]+>/giu, "")
    .replace(/(?:https?:\/\/|www\.)[^\s<>()\[\]{}，。；：、！？,;!?]+/giu, "")
    .replace(/[ \t]+([，。；：、,.!！?？;:])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}
