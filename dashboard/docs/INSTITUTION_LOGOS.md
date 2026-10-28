# 券商研究所 Logo 资源

卖方观点使用本地静态图片，不在浏览器运行时请求第三方资源。页面只展示不含机构名称的方形品牌图形，并将原始图片按比例缩放到统一画布。不拉伸、不重绘、不改色。

| 机构 | 本地文件 | 官方来源 |
| --- | --- | --- |
| 中金公司 | `static/institution-logos/cicc.ico` | `https://sip.cicc.com/favicon.ico` |
| 中信证券 | `static/institution-logos/citics.ico` | `https://www.citics.com/newsite/favicon.ico` |
| 中信建投证券 | `static/institution-logos/csc.ico` | `https://www.csc108.com/favicon.ico` |
| 华泰证券 | `static/institution-logos/htsc.ico` | `https://www.htsc.com.cn/favicon.ico` |
| 国泰海通证券 | `static/institution-logos/gtht.png` | `https://www.gtht.com/favicon.ico` |
| 国信证券 | `static/institution-logos/guosen.ico` | `https://www.guosen.com.cn/favicon.ico` |
| 广发证券 | `static/institution-logos/gf.ico` | `https://new.gf.com.cn/images/favicon.ico` |
| 招商证券 | `static/institution-logos/cms.ico` | `https://www.newone.com.cn/favicon.ico` |
| 申万宏源证券 | `static/institution-logos/swhy.ico` | `https://www.swhysc.com/swhysc/favicon.ico` |
| 兴业证券 | `static/institution-logos/xyzq.png` | `https://www.xyzq.com.cn/xysec/views/theme/img/favicon.ico` |
| 中国银河证券 | `static/institution-logos/galaxy.ico` | `https://www.chinastock.com.cn/favicon.ico` |
| 中泰证券 | `static/institution-logos/zts.ico` | `https://www.zts.com.cn/favicon.ico` |
| 东方证券 | `static/institution-logos/dfzq.ico` | `https://www.dfzq.com.cn/favicon.ico` |
| 光大证券 | `static/institution-logos/ebscn.ico` | `https://webapps.ebscn.com/favicon.ico` |
| 国金证券 | `static/institution-logos/gjzq.ico` | `https://www.gjzq.com.cn/static/favicon.ico` |
| 财通证券 | `static/institution-logos/ctsec.png` | `https://www.ctsec.com/favicon.ico` |
| 浙商证券 | `static/institution-logos/stocke.ico` | `https://www.stocke.com.cn/favicon.ico` |
| 天风证券 | `static/institution-logos/tfzq.ico` | `https://www.tfzq.com/favicon.ico` |
| 华创证券 | `static/institution-logos/hczq.ico` | `https://www.hczq.com/favicon.ico` |
| 国盛证券 | `static/institution-logos/gszq.png` | `https://www.gszq.com/favicon.ico` |
| 德邦证券 | `static/institution-logos/tebon.ico` | `https://dsp.tebon.com.cn/wake_app/favicon.ico` |
| 国联民生证券 | `static/institution-logos/glms.ico` | `https://www.glsc.com.cn/gw.ico` |
| 平安证券 | `static/institution-logos/pingan.ico` | `https://stock.pingan.com/static/common/favicon.ico` |
| 中银证券 | `static/institution-logos/boci.ico` | `https://www.bocichina.com/favicon.ico` |
| 国海证券 | `static/institution-logos/ghzq.jpg` | `https://www.ghzq.com.cn/favicon.ico` |
| 东吴证券 | `static/institution-logos/dwzq.ico` | `https://www.dwzq.com.cn/favicon.ico` |
| 长江证券 | `static/institution-logos/cjsc.ico` | `https://www.95579.com/front/images/favicon.ico` |
| 西部证券 | `static/institution-logos/west.png` | `https://www.west95582.com/favicon.ico` |
| 方正证券 | `static/institution-logos/founder.ico` | `https://www.foundersc.com/favicon.ico` |
| 开源证券 | `static/institution-logos/kysec.ico` | `https://www.kysec.cn/favicon.ico` |
| 华西证券 | `static/institution-logos/hx168.ico` | `https://www.hx168.com.cn/favicon.ico` |
| 华福证券 | `static/institution-logos/hfzq.png` | `https://www.hfzq.com.cn/assets/favicon.ico` |

新增机构时必须先从该机构官网或官方招聘、投资者关系站取得真实品牌图片，再在 `src/lib/sell-side-institutions.ts` 增加别名映射。未收录机构只展示机构名称，不生成文字缩写或仿制 Logo。
