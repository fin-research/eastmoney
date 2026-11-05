import type { ArticleFeatures } from "./feature-extraction";

export function sqlText(value: string): string {
  return `'${value.replaceAll("\0", "").replaceAll("'", "''")}'`;
}

/**
 * Plain-SQL form of the graph rows for scripts that run `wrangler d1 execute --file`.
 * It replaces the article's nodes and claims and only then stamps the prompt version,
 * so an interrupted file leaves the article pending rather than half done.
 */
export function graphReplaceStatements(
  articleId: string,
  features: Pick<ArticleFeatures, "nodes" | "claims">,
  promptVersion: string,
  updatedAt: string,
): string[] {
  const id = sqlText(articleId);
  return [
    `DELETE FROM claim WHERE article_id = ${id}`,
    `DELETE FROM node WHERE article_id = ${id}`,
    ...features.nodes.map(
      (node, ordinal) =>
        `INSERT INTO node (article_id, ordinal, label, kind, fact, impact) VALUES (${id}, ${ordinal}, ${sqlText(node.label)}, ${sqlText(node.kind)}, ${sqlText(node.fact)}, ${sqlText(node.impact)})`,
    ),
    ...features.claims.map(
      (claim, ordinal) =>
        `INSERT INTO claim (article_id, ordinal, cause, cause_move, effect, effect_move, basis, mechanism) VALUES (${id}, ${ordinal}, ${sqlText(claim.cause)}, ${sqlText(claim.causeMove)}, ${sqlText(claim.effect)}, ${sqlText(claim.effectMove)}, ${sqlText(claim.basis)}, ${sqlText(claim.mechanism)})`,
    ),
    `UPDATE article SET prompt_version = ${sqlText(promptVersion)}, updated_at = ${sqlText(updatedAt)} WHERE id = ${id}`,
  ];
}
