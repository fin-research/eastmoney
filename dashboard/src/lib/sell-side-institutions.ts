export interface InstitutionLogoProfile {
  key: string;
  label: string;
  src: string;
  sourceUrl: string;
}

interface InstitutionLogoDefinition extends InstitutionLogoProfile {
  aliases: readonly string[];
}

const institutionLogos: readonly InstitutionLogoDefinition[] = [
  logo("cicc", "中金公司", "cicc.ico", "https://sip.cicc.com/favicon.ico", [
    "中金",
    "中金固收",
    "中金研究",
    "中国国际金融",
  ]),
  logo(
    "citics",
    "中信证券",
    "citics.ico",
    "https://www.citics.com/newsite/favicon.ico",
    ["中信固收", "中信研究"],
  ),
  logo(
    "csc",
    "中信建投证券",
    "csc.ico",
    "https://www.csc108.com/favicon.ico",
    ["中信建投", "中信建投固收", "中信建投研究"],
  ),
  logo(
    "htsc",
    "华泰证券",
    "htsc.ico",
    "https://www.htsc.com.cn/favicon.ico",
    ["华泰固收", "华泰研究", "华泰联合"],
  ),
  logo(
    "gtht",
    "国泰海通证券",
    "gtht.png",
    "https://www.gtht.com/favicon.ico",
    [
      "国泰海通",
      "国泰君安",
      "国君固收",
      "国君研究",
      "海通证券",
      "海通固收",
      "海通研究",
    ],
  ),
  logo(
    "guosen",
    "国信证券",
    "guosen.ico",
    "https://www.guosen.com.cn/favicon.ico",
    ["国信固收", "国信研究"],
  ),
  logo(
    "gf",
    "广发证券",
    "gf.ico",
    "https://new.gf.com.cn/images/favicon.ico",
    ["广发固收", "广发研究"],
  ),
  logo(
    "cms",
    "招商证券",
    "cms.ico",
    "https://www.newone.com.cn/favicon.ico",
    ["招商固收", "招商研究"],
  ),
  logo(
    "swhy",
    "申万宏源证券",
    "swhy.ico",
    "https://www.swhysc.com/swhysc/favicon.ico",
    ["申万宏源", "申万固收", "申万研究"],
  ),
  logo(
    "xyzq",
    "兴业证券",
    "xyzq.png",
    "https://www.xyzq.com.cn/xysec/views/theme/img/favicon.ico",
    ["兴业固收", "兴业研究", "兴证固收", "兴证研究", "兴证"],
  ),
  logo(
    "galaxy",
    "中国银河证券",
    "galaxy.ico",
    "https://www.chinastock.com.cn/favicon.ico",
    ["银河证券", "银河固收", "银河研究"],
  ),
  logo(
    "zts",
    "中泰证券",
    "zts.ico",
    "https://www.zts.com.cn/favicon.ico",
    ["中泰固收", "中泰研究"],
  ),
  logo(
    "dfzq",
    "东方证券",
    "dfzq.ico",
    "https://www.dfzq.com.cn/favicon.ico",
    ["东方固收", "东方研究"],
  ),
  logo(
    "ebscn",
    "光大证券",
    "ebscn.ico",
    "https://webapps.ebscn.com/favicon.ico",
    ["光大固收", "光大研究"],
  ),
  logo(
    "gjzq",
    "国金证券",
    "gjzq.ico",
    "https://www.gjzq.com.cn/static/favicon.ico",
    ["国金固收", "国金研究"],
  ),
  logo(
    "ctsec",
    "财通证券",
    "ctsec.png",
    "https://www.ctsec.com/favicon.ico",
    ["财通固收", "财通研究"],
  ),
  logo(
    "stocke",
    "浙商证券",
    "stocke.ico",
    "https://www.stocke.com.cn/favicon.ico",
    ["浙商固收", "浙商研究"],
  ),
  logo(
    "tfzq",
    "天风证券",
    "tfzq.ico",
    "https://www.tfzq.com/favicon.ico",
    ["天风固收", "天风研究"],
  ),
  logo(
    "hczq",
    "华创证券",
    "hczq.ico",
    "https://www.hczq.com/favicon.ico",
    ["华创固收", "华创研究"],
  ),
  logo(
    "gszq",
    "国盛证券",
    "gszq.png",
    "https://www.gszq.com/favicon.ico",
    ["国盛固收", "国盛研究"],
  ),
  logo(
    "tebon",
    "德邦证券",
    "tebon.ico",
    "https://dsp.tebon.com.cn/wake_app/favicon.ico",
    ["德邦资管", "德邦固收", "德邦研究"],
  ),
  logo(
    "glms",
    "国联民生证券",
    "glms.ico",
    "https://www.glsc.com.cn/gw.ico",
    [
      "国联民生",
      "国联证券",
      "民生证券",
      "国联固收",
      "民生固收",
      "国联研究",
      "民生研究",
    ],
  ),
  logo(
    "pingan",
    "平安证券",
    "pingan.ico",
    "https://stock.pingan.com/static/common/favicon.ico",
    ["平安固收", "平安研究"],
  ),
  logo(
    "boci",
    "中银证券",
    "boci.ico",
    "https://www.bocichina.com/favicon.ico",
    ["中银国际", "中银固收", "中银研究"],
  ),
  logo(
    "ghzq",
    "国海证券",
    "ghzq.jpg",
    "https://www.ghzq.com.cn/favicon.ico",
    ["国海固收", "国海研究"],
  ),
  logo(
    "dwzq",
    "东吴证券",
    "dwzq.ico",
    "https://www.dwzq.com.cn/favicon.ico",
    ["东吴固收", "东吴研究"],
  ),
  logo(
    "cjsc",
    "长江证券",
    "cjsc.ico",
    "https://www.95579.com/front/images/favicon.ico",
    ["长江固收", "长江研究"],
  ),
  logo(
    "west",
    "西部证券",
    "west.png",
    "https://www.west95582.com/favicon.ico",
    ["西部固收", "西部研究"],
  ),
  logo(
    "founder",
    "方正证券",
    "founder.ico",
    "https://www.foundersc.com/favicon.ico",
    ["方正固收", "方正研究"],
  ),
  logo(
    "kysec",
    "开源证券",
    "kysec.ico",
    "https://www.kysec.cn/favicon.ico",
    ["开源固收", "开源研究"],
  ),
  logo(
    "hx168",
    "华西证券",
    "hx168.ico",
    "https://www.hx168.com.cn/favicon.ico",
    ["华西固收", "华西研究"],
  ),
  logo(
    "hfzq",
    "华福证券",
    "hfzq.png",
    "https://www.hfzq.com.cn/assets/favicon.ico",
    ["华福固收", "华福研究"],
  ),
];

export function resolveInstitutionLogo(
  institution: string,
): InstitutionLogoProfile | null {
  const normalized = normalizeInstitution(institution);
  return (
    institutionLogos.find((profile) =>
      profile.aliases.some((alias) =>
        normalized.includes(normalizeInstitution(alias)),
      ),
    ) ?? null
  );
}

function logo(
  key: string,
  label: string,
  fileName: string,
  sourceUrl: string,
  aliases: readonly string[],
): InstitutionLogoDefinition {
  return {
    key,
    label,
    src: `/institution-logos/${fileName}`,
    sourceUrl,
    aliases: [label, ...aliases],
  };
}

function normalizeInstitution(value: string): string {
  return value.replace(/[\s·•]/g, "").trim();
}
