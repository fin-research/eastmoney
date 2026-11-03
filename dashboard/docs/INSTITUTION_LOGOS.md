# 券商研究所 Logo 资源

卖方观点使用本地静态图片，浏览器运行时不请求第三方资源。机构、别名、本地文件和官方来源 URL 的对应关系以 [sell-side-institutions.ts](../src/lib/sell-side-institutions.ts) 为准，图片在 `static/institution-logos/`。

- 页面只展示不含机构名称的方形品牌图形，原图按比例缩放到统一画布，不拉伸、不重绘、不改色。
- 新增机构：先从该机构官网或官方招聘、投资者关系站取得真实品牌图片，放入 `static/institution-logos/`，并在 `sell-side-institutions.ts` 登记别名与来源 URL。
- 未收录机构只展示机构名称，不生成文字缩写或仿制 Logo。
