/** 真太阳时出生地：按「省 → 市」两级分组，经度(°东)取公开地理坐标近似到 0.1°。
 *  单独成模块：ChartPage 静态引用它渲染两级联动下拉，而不把 325KB 的历法引擎拽进首屏包。
 *  市级只收录常用代表城市；表里没有的可切「自定义经度」手填。 */
export interface SolarCity { name: string; longitude: number }
export interface SolarProvince { name: string; cities: SolarCity[] }

export const TRUE_SOLAR_PROVINCES: ReadonlyArray<SolarProvince> = [
  { name: '北京', cities: [{ name: '北京', longitude: 116.4 }] },
  { name: '天津', cities: [{ name: '天津', longitude: 117.2 }] },
  { name: '河北', cities: [{ name: '石家庄', longitude: 114.5 }, { name: '唐山', longitude: 118.2 }, { name: '保定', longitude: 115.5 }, { name: '秦皇岛', longitude: 119.6 }] },
  { name: '山西', cities: [{ name: '太原', longitude: 112.5 }, { name: '大同', longitude: 113.3 }, { name: '临汾', longitude: 111.5 }] },
  { name: '内蒙古', cities: [{ name: '呼和浩特', longitude: 111.7 }, { name: '包头', longitude: 109.8 }, { name: '赤峰', longitude: 118.9 }, { name: '海拉尔', longitude: 119.7 }] },
  { name: '辽宁', cities: [{ name: '沈阳', longitude: 123.4 }, { name: '大连', longitude: 121.6 }, { name: '鞍山', longitude: 123.0 }] },
  { name: '吉林', cities: [{ name: '长春', longitude: 125.3 }, { name: '吉林', longitude: 126.5 }, { name: '延吉', longitude: 129.5 }] },
  { name: '黑龙江', cities: [{ name: '哈尔滨', longitude: 126.6 }, { name: '齐齐哈尔', longitude: 123.9 }, { name: '牡丹江', longitude: 129.6 }] },
  { name: '上海', cities: [{ name: '上海', longitude: 121.5 }] },
  { name: '江苏', cities: [{ name: '南京', longitude: 118.8 }, { name: '苏州', longitude: 120.6 }, { name: '无锡', longitude: 120.3 }, { name: '南通', longitude: 120.9 }, { name: '徐州', longitude: 117.2 }] },
  { name: '浙江', cities: [{ name: '杭州', longitude: 120.2 }, { name: '宁波', longitude: 121.5 }, { name: '温州', longitude: 120.7 }, { name: '金华', longitude: 119.6 }] },
  { name: '安徽', cities: [{ name: '合肥', longitude: 117.3 }, { name: '芜湖', longitude: 118.4 }, { name: '阜阳', longitude: 115.8 }] },
  { name: '福建', cities: [{ name: '福州', longitude: 119.3 }, { name: '厦门', longitude: 118.1 }, { name: '泉州', longitude: 118.6 }] },
  { name: '江西', cities: [{ name: '南昌', longitude: 115.9 }, { name: '赣州', longitude: 114.9 }, { name: '九江', longitude: 116.0 }] },
  { name: '山东', cities: [{ name: '济南', longitude: 117.0 }, { name: '青岛', longitude: 120.4 }, { name: '烟台', longitude: 121.4 }, { name: '临沂', longitude: 118.3 }, { name: '潍坊', longitude: 119.1 }] },
  { name: '河南', cities: [{ name: '郑州', longitude: 113.6 }, { name: '洛阳', longitude: 112.4 }, { name: '南阳', longitude: 112.5 }, { name: '开封', longitude: 114.3 }] },
  { name: '湖北', cities: [{ name: '武汉', longitude: 114.3 }, { name: '宜昌', longitude: 111.3 }, { name: '襄阳', longitude: 112.1 }] },
  { name: '湖南', cities: [{ name: '长沙', longitude: 113.0 }, { name: '衡阳', longitude: 112.6 }, { name: '岳阳', longitude: 113.1 }] },
  { name: '广东', cities: [{ name: '广州', longitude: 113.3 }, { name: '深圳', longitude: 114.1 }, { name: '珠海', longitude: 113.6 }, { name: '汕头', longitude: 116.7 }, { name: '湛江', longitude: 110.4 }, { name: '佛山', longitude: 113.1 }] },
  { name: '广西', cities: [{ name: '南宁', longitude: 108.3 }, { name: '桂林', longitude: 110.3 }, { name: '柳州', longitude: 109.4 }] },
  { name: '海南', cities: [{ name: '海口', longitude: 110.3 }, { name: '三亚', longitude: 109.5 }] },
  { name: '重庆', cities: [{ name: '重庆', longitude: 106.5 }] },
  { name: '四川', cities: [{ name: '成都', longitude: 104.1 }, { name: '绵阳', longitude: 104.7 }, { name: '自贡', longitude: 104.8 }, { name: '西昌', longitude: 102.3 }, { name: '攀枝花', longitude: 101.7 }] },
  { name: '贵州', cities: [{ name: '贵阳', longitude: 106.7 }, { name: '遵义', longitude: 106.9 }] },
  { name: '云南', cities: [{ name: '昆明', longitude: 102.7 }, { name: '大理', longitude: 100.2 }, { name: '丽江', longitude: 100.2 }, { name: '景洪', longitude: 100.8 }] },
  { name: '西藏', cities: [{ name: '拉萨', longitude: 91.1 }, { name: '日喀则', longitude: 88.9 }] },
  { name: '陕西', cities: [{ name: '西安', longitude: 108.9 }, { name: '延安', longitude: 109.5 }, { name: '宝鸡', longitude: 107.2 }] },
  { name: '甘肃', cities: [{ name: '兰州', longitude: 103.8 }, { name: '天水', longitude: 105.7 }, { name: '敦煌', longitude: 94.7 }] },
  { name: '青海', cities: [{ name: '西宁', longitude: 101.8 }] },
  { name: '宁夏', cities: [{ name: '银川', longitude: 106.2 }, { name: '固原', longitude: 106.3 }] },
  { name: '新疆', cities: [{ name: '乌鲁木齐', longitude: 87.6 }, { name: '喀什', longitude: 76.0 }, { name: '哈密', longitude: 93.5 }, { name: '伊宁', longitude: 81.3 }] },
  { name: '台湾', cities: [{ name: '台北', longitude: 121.5 }, { name: '高雄', longitude: 120.3 }] },
  { name: '香港', cities: [{ name: '香港', longitude: 114.2 }] },
  { name: '澳门', cities: [{ name: '澳门', longitude: 113.5 }] },
];
