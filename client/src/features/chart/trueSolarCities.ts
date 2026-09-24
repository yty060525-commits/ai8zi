/** 常用城市经度(°东)预设，供首页「真太阳时」下拉。数值取公开地理坐标，近似到 0.1°。
 *  单独成模块：ChartPage 静态引用它渲染下拉，而不必把 325KB 的历法引擎拽进首屏包。 */
export const TRUE_SOLAR_CITIES: ReadonlyArray<{ name: string; longitude: number }> = [
  { name: '北京', longitude: 116.4 }, { name: '上海', longitude: 121.5 }, { name: '广州', longitude: 113.3 },
  { name: '深圳', longitude: 114.1 }, { name: '成都', longitude: 104.1 }, { name: '重庆', longitude: 106.5 },
  { name: '武汉', longitude: 114.3 }, { name: '西安', longitude: 108.9 }, { name: '杭州', longitude: 120.2 },
  { name: '南京', longitude: 118.8 }, { name: '郑州', longitude: 113.6 }, { name: '长沙', longitude: 113.0 },
  { name: '昆明', longitude: 102.7 }, { name: '兰州', longitude: 103.8 }, { name: '沈阳', longitude: 123.4 },
  { name: '哈尔滨', longitude: 126.6 }, { name: '乌鲁木齐', longitude: 87.6 }, { name: '拉萨', longitude: 91.1 },
  { name: '台北', longitude: 121.5 }, { name: '青岛', longitude: 120.4 },
];
