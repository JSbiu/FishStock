export interface FuturesSessionRule {
  venue: string;
  nightEndMinutes?: number;
}

const SHFE_0230 = ['AU', 'AG'];
const SHFE_0100 = ['CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'SS', 'AO', 'AD'];
const SHFE_2300 = ['RB', 'HC', 'RU', 'BU', 'FU', 'SP', 'BR'];
const SHFE_DAY_ONLY = ['WR'];
const INE_0230 = ['SC'];
const INE_0100 = ['BC'];
const INE_2300 = ['LU', 'NR'];
const INE_DAY_ONLY = ['EC'];
const DCE_2300 = [
  'A', 'B', 'C', 'CS', 'M', 'Y', 'P', 'RR',
  'I', 'J', 'JM', 'L', 'V', 'PP', 'EG', 'EB', 'PG',
];
const DCE_DAY_ONLY = ['JD', 'LH', 'BB', 'FB', 'LG'];
const CZCE_2300 = [
  'CF', 'SR', 'TA', 'OI', 'MA', 'FG', 'RM', 'CY', 'UR',
  'SA', 'PF', 'PX', 'SH', 'PR', 'ZC',
];
const CZCE_DAY_ONLY = [
  'WH', 'PM', 'RI', 'RS', 'JR', 'LR', 'SF', 'SM', 'AP', 'CJ', 'PK',
];
const GFEX_DAY_ONLY = ['SI', 'LC', 'PS', 'PT', 'PD'];

function rules(
  products: readonly string[],
  venue: string,
  nightEndMinutes?: number,
): Array<readonly [string, FuturesSessionRule]> {
  return products.map((product) => [
    product,
    { venue, ...(nightEndMinutes === undefined ? {} : { nightEndMinutes }) },
  ] as const);
}

const FUTURES_SESSION_RULES = new Map<string, FuturesSessionRule>([
  ...rules(SHFE_0230, '上海期货交易所', 150),
  ...rules(SHFE_0100, '上海期货交易所', 60),
  ...rules(SHFE_2300, '上海期货交易所', 1_380),
  ...rules(SHFE_DAY_ONLY, '上海期货交易所'),
  ...rules(INE_0230, '上海国际能源交易中心', 150),
  ...rules(INE_0100, '上海国际能源交易中心', 60),
  ...rules(INE_2300, '上海国际能源交易中心', 1_380),
  ...rules(INE_DAY_ONLY, '上海国际能源交易中心'),
  ...rules(DCE_2300, '大连商品交易所', 1_380),
  ...rules(DCE_DAY_ONLY, '大连商品交易所'),
  ...rules(CZCE_2300, '郑州商品交易所', 1_380),
  ...rules(CZCE_DAY_ONLY, '郑州商品交易所'),
  ...rules(GFEX_DAY_ONLY, '广州期货交易所'),
]);

export function futuresProduct(symbol: string): string | undefined {
  return symbol.toUpperCase().match(/^([A-Z]{1,3})\d*\.CNF$/)?.[1];
}

export function futuresSessionRule(symbol: string): FuturesSessionRule | undefined {
  const product = futuresProduct(symbol);
  return product ? FUTURES_SESSION_RULES.get(product) : undefined;
}

export function isSupportedFuturesSymbol(symbol: string): boolean {
  return futuresSessionRule(symbol) !== undefined;
}

export function supportedFuturesProductCount(): number {
  return FUTURES_SESSION_RULES.size;
}
