/** Dashboard owns model eligibility; missing approval never enables inference. */
export async function requireActiveModel(client, version) {
  if (!/^[a-f0-9]{20}$/.test(version ?? "")) throw new Error("Invalid model identity");
  const result = await client.query(
    "SELECT status,reason FROM financing_model.model_eligibility WHERE model_version=$1",
    [version],
  );
  if (result.rows[0]?.status !== "active")
    throw new Error("Model suspended: " + (result.rows[0]?.reason ?? "quality_review_required"));
}
