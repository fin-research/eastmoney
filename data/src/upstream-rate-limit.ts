import { ApiError } from "./http";

export async function requireUpstreamCapacity(
  binding: RateLimit,
  key: string,
  source: string,
): Promise<void> {
  const result = await binding.limit({ key });
  if (!result.success) {
    throw new ApiError(429, `${source} 请求过于频繁，请稍后重试`, {
      code: "RATE_LIMITED",
      source,
      stage: "rate_limit",
    });
  }
}
