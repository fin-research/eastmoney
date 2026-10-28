export function reportImageFilename(
  reportDate: string,
  mobile: boolean,
): string {
  const mobileSuffix = mobile ? "-移动端" : "";
  return `资金管理部-市场点评-${reportDate}${mobileSuffix}.png`;
}
