/** 真太阳时选点数据：省 → 市 → 区(区县)。
 *  经度(lng)为各地行政区划**质心**经度，由 scripts/gen-true-solar.mjs 抓取阿里云 DataV 公开
 *  行政区划 GeoJSON(properties.center)生成到 trueSolarData.generated.json，再在此定型导出。
 *  直辖市(京津冀沪渝)省级直接辖「区」，其 cities 即区、municipality=true；台湾用公开地理坐标补录。
 *  数据 ~92KB，用 loadTrueSolarProvinces() 动态 import，避免把整表压进首屏包(与历法引擎同策略)。 */
export interface SolarDistrict { name: string; lng: number }
export interface SolarCity { name: string; lng: number; districts?: SolarDistrict[] }
export interface SolarProvince { name: string; municipality?: boolean; cities: SolarCity[] }

/** 惰性加载全量省市区表：ChartPage 用 useEffect 调一次填入下拉；构建器会拆成独立 chunk。
 *  结果 promise 记忆化：首屏不加载，触发后只 import 一次，后续调用复用同一(已解析)promise。 */
let provincesCache: Promise<SolarProvince[]> | null = null;
export function loadTrueSolarProvinces(): Promise<SolarProvince[]> {
  if (!provincesCache) {
    provincesCache = import('./trueSolarData.generated.json')
      .then((mod) => (mod.default ?? mod) as unknown as SolarProvince[]);
  }
  return provincesCache;
}
