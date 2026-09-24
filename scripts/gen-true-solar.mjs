// One-time generator: crawl DataV 行政区划 GeoJSON centroids → 省→市→区 longitude tree.
// Run:  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/gen-true-solar.mjs
// Output: client/src/features/chart/trueSolarData.generated.json  (committed, lazy-loaded)
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
const OUT = new URL('../client/src/features/chart/trueSolarData.generated.json', import.meta.url);
const CONC = 8;

const cache = new Map();
async function get(adcode) {
  if (cache.has(adcode)) return cache.get(adcode);
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${BASE}/${adcode}_full.json`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { if (r.status === 404) { cache.set(adcode, null); return null; } throw new Error(String(r.status)); }
      const j = await r.json();
      cache.set(adcode, j);
      return j;
    } catch (e) { if (a === 2) { cache.set(adcode, null); return null; } await new Promise(r => setTimeout(r, 400 * (a + 1))); }
  }
}

// keep only real admin children with a numeric center + short name; drop 海域/功能区 empties
function kids(json) {
  if (!json || !Array.isArray(json.features)) return [];
  return json.features
    .filter(f => f && f.properties && Array.isArray(f.properties.center)
      && typeof f.properties.name === 'string' && f.properties.name
      && Number.isFinite(f.properties.adcode)
      && Number.isFinite(f.properties.center[0]))
    .map(f => ({ name: f.properties.name, adcode: f.properties.adcode, lng: round1(f.properties.center[0]) }))
    .filter(k => k.lng > 70 && k.lng < 140); // mainland longitudes only
}
const round1 = (n) => Math.round(n * 10) / 10;

async function pool(items, worker) {
  const ret = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await worker(items[idx], idx); }
  }));
  return ret;
}

const nat = await get('100000');
const MUNICIPALITY = new Set([110000, 120000, 310000, 500000]); // 京津冀沪渝：省下直接是区，不再下探到街道
const provinces = kids(nat).filter(p => p.name && (p.name.includes('省') || p.name.includes('市') || p.name.includes('自治区') || p.name.includes('特别行政区')));
const tree = await pool(provinces, async (prov) => {
  const level2 = kids(await get(String(prov.adcode)));
  const isMuni = MUNICIPALITY.has(prov.adcode);
  const cities = await pool(level2, async (city) => {
    // 直辖市的 level2 已是「区」，不再取子级(否则会把街道当区)；普通省的 level2 是地级市，下探一区
    const level3 = isMuni ? [] : kids(await get(String(city.adcode)));
    const node = { name: city.name, lng: city.lng };
    if (level3.length) node.districts = level3.map(d => ({ name: d.name, lng: d.lng }));
    return node;
  });
  return { name: prov.name, municipality: isMuni || undefined, cities: cities.filter(Boolean) };
});
const final = tree.filter(p => p.cities.length);
// DataV 不提供台湾细分(710000_full 404)，用公开地理坐标补一档，避免省列表缺台湾。
if (!final.some(p => p.name.includes('台湾'))) {
  final.push({ name: '台湾省', cities: [
    { name: '台北市', lng: 121.5 }, { name: '新北市', lng: 121.4 }, { name: '桃园市', lng: 121.3 },
    { name: '台中市', lng: 120.7 }, { name: '高雄市', lng: 120.3 }, { name: '台南市', lng: 120.2 },
    { name: '基隆市', lng: 121.7 }, { name: '新竹市', lng: 121.0 }, { name: '嘉义市', lng: 120.4 },
    { name: '宜兰市', lng: 121.8 }, { name: '花莲市', lng: 121.6 }, { name: '台东市', lng: 121.1 },
    { name: '彰化市', lng: 120.5 }, { name: '南投市', lng: 120.7 }, { name: '苗栗市', lng: 120.8 },
    { name: '屏东市', lng: 120.5 }, { name: '云林市', lng: 120.5 },
  ] });
}
final.sort((a, b) => 0); // keep crawl order; 台湾 appended last is fine
const fs = await import('node:fs');
fs.writeFileSync(OUT, JSON.stringify(final) /* single-line, minified */);
const districtCount = final.reduce((s, p) => s + p.cities.reduce((a, c) => a + (c.districts?.length || 0), 0), 0);
console.log('provinces', final.length, 'cities', final.reduce((s,p)=>s+p.cities.length,0), 'districts', districtCount, 'bytes', JSON.stringify(final).length);
