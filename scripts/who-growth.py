#!/usr/bin/env python3
"""重新生成 packages/shared/src/health/whoGrowthData.ts（WHO 儿童生长标准的 LMS 表）。

只用标准库。数据必须来自 WHO 原始发布，不能用二手转载：

1. 从 WHO 的三个页面下载按性别分的百分位表（Excel），放进同一个目录：
   https://www.who.int/tools/child-growth-standards/standards/weight-for-age
   https://www.who.int/tools/child-growth-standards/standards/length-height-for-age
   https://www.who.int/tools/child-growth-standards/standards/head-circumference-for-age
   要的文件（`?sfvrsn=` 之前的文件名）：
   - “Tables · percentiles” 下按月的表：
     tab_wfa_{boys,girls}_p_0_5.xlsx  tab_lhfa_{boys,girls}_p_0_2.xlsx  tab_lhfa_{boys,girls}_p_2_5.xlsx
     tab_hcfa_{boys,girls}_p_0_5.xlsx
   - “Expanded tables” 下按天的百分位表（只取前 91 天）：
     {wfa,lhfa,hcfa}-{boys,girls}-percentiles-expanded-tables.xlsx
   前 13 周用按天的表：体重出生后几天先降后升，按周或按月的节点之间线性插值，第 1–2 天的中位数会差 1.5–2%。
   之后用按月的表，和按天的表比，插值误差不到 0.4%（P3、P50、P97，2026-11-13 核对）。
2. 运行：python3 scripts/who-growth.py <下载目录> > packages/shared/src/health/whoGrowthData.ts
3. 下载日期和 sfvrsn 写进生成文件开头的注释（改 SOURCE_NOTE），再跑 `pnpm check`。

表里的数是 Excel 的二进制浮点（0.34870000000000001），用 Python 的 repr 还原成 WHO 发布的位数（0.3487）。
"""

import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
DAYS_PER_MONTH = 30.4375  # WHO：1 month = 30.4375 days（expanded tables 的说明）
DAILY_UNTIL = 91  # 13 周

SOURCE_NOTE = """\
 * 下载日期 2026-11-13，文件的 sfvrsn：
 * - weight-for-age：tab_wfa_boys_p_0_5 a0b3ed5_7、tab_wfa_girls_p_0_5 666fe445_7、
 *   wfa-boys-percentiles-expanded-tables c2f79259_11、wfa-girls-percentiles-expanded-tables 54cfa5e8_9
 * - length/height-for-age：tab_lhfa_boys_p_0_2 308931b2_12、tab_lhfa_girls_p_0_2 770a5ab8_9、
 *   tab_lhfa_boys_p_2_5 d6758a88_9、tab_lhfa_girls_p_2_5 5716360d_9、
 *   lhfa-boys-percentiles-expanded-tables bc36d818_9、lhfa-girls-percentiles-expanded-tables 478569a5_9
 * - head-circumference-for-age：tab_hcfa_boys_p_0_5 d6284c4c_5、tab_hcfa_girls_p_0_5 ad755200_5、
 *   hcfa-boys-percentiles-expanded-tables c266c88f_7、hcfa-girls-percentiles-expanded-tables 71b282d1_13"""


def column(ref: str) -> int:
    n = 0
    for c in re.match(r'[A-Z]+', ref).group(0):
        n = n * 26 + ord(c) - 64
    return n - 1


def rows(path: Path) -> list[list[str]]:
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(f'{NS}si'):
            shared.append(''.join(t.text or '' for t in si.iter(f'{NS}t')))
    sheet = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))[0]
    out = []
    for r in ET.fromstring(z.read(sheet)).iter(f'{NS}row'):
        cells: dict[int, str] = {}
        for c in r.iter(f'{NS}c'):
            v = c.find(f'{NS}v')
            if v is None:
                continue
            cells[column(c.get('r'))] = shared[int(v.text)] if c.get('t') == 's' else v.text
        if cells:
            out.append([cells.get(i, '') for i in range(max(cells) + 1)])
    return out


def num(x: float) -> str:
    text = repr(x)
    return text[:-2] if text.endswith('.0') else text


def lms(path: Path, unit: str) -> list[tuple[float, str, str, str]]:
    """返回 [(年龄天数, L, M, S)]。`unit` 是 Day 或 Month；按天的表第一列有的叫 Age。"""
    table = rows(path)
    head = table[0]
    first = ('Day', 'Age') if unit == 'Day' else ('Month',)
    if head[0] not in first or head[1:4] != ['L', 'M', 'S']:
        sys.exit(f'{path.name}: 表头是 {head[:4]}，不是 [{unit}, L, M, S]')
    per = 1 if unit == 'Day' else DAYS_PER_MONTH
    out = []
    for r in table[1:]:
        age = int(float(r[0])) * per
        out.append((age, num(age), *(num(float(x)) for x in r[1:4])))
    return out


def first_weeks(path: Path):
    return [r for r in lms(path, 'Day') if r[0] <= DAILY_UNTIL]


def after_first_weeks(path: Path):
    return [r for r in lms(path, 'Month') if r[0] > DAILY_UNTIL]


def merge(*parts):
    out = sorted((r for part in parts for r in part), key=lambda r: r[0])
    for a, b in zip(out, out[1:]):
        if a[0] >= b[0]:
            sys.exit(f'第 {a[0]} 天和第 {b[0]} 天的顺序不对')
    return [r[1:] for r in out]


def emit(name: str, data: list) -> str:
    lines = [f'  {name}: [']
    for day, l, m, s in data:
        lines.append(f'    [{day}, {l}, {m}, {s}],')
    lines.append('  ],')
    return '\n'.join(lines)


def main() -> None:
    src = Path(sys.argv[1])
    out = []
    for sex, who in (('female', 'girls'), ('male', 'boys')):
        weight = merge(
            first_weeks(src / f'wfa-{who}-percentiles-expanded-tables.xlsx'),
            after_first_weeks(src / f'tab_wfa_{who}_p_0_5.xlsx'),
        )
        length = merge(
            first_weeks(src / f'lhfa-{who}-percentiles-expanded-tables.xlsx'),
            after_first_weeks(src / f'tab_lhfa_{who}_p_0_2.xlsx'),
        )
        height = merge(lms(src / f'tab_lhfa_{who}_p_2_5.xlsx', 'Month'))
        head = merge(
            first_weeks(src / f'hcfa-{who}-percentiles-expanded-tables.xlsx'),
            after_first_weeks(src / f'tab_hcfa_{who}_p_0_5.xlsx'),
        )
        out.append(
            f'  {sex}: {{\n'
            + '\n'.join(
                '  ' + emit(n, d).replace('\n', '\n  ')
                for n, d in (('weight', weight), ('length', length), ('height', height), ('head', head))
            )
            + '\n  },'
        )
    print(f"""// 由 scripts/who-growth.py 生成，不要手改。
/**
 * WHO Child Growth Standards 的 LMS 参数，按性别和指标分，每行 [年龄（天）, L, M, S]。
 *
 * 来源（WHO 原始发布，不是转载）：https://www.who.int/tools/child-growth-standards/standards
 * 的 Weight-for-age、Length/height-for-age、Head circumference for age 三页，“Tables · percentiles”
 * 下按月的 Excel（Birth to 5 years；身长分 Birth to 2 years 的卧位身长和 2 to 5 years 的立位身高），
 * 前 91 天（13 周）用 “Expanded tables” 下按天的百分位表。方法见 WHO Child Growth Standards: Length/height-for-age,
 * weight-for-age, weight-for-length, weight-for-height and body mass index-for-age: Methods and
 * development（WHO，2006）和 Head circumference-for-age, arm circumference-for-age, triceps
 * skinfold-for-age and subscapular skinfold-for-age: Methods and development（WHO，2007）。
{SOURCE_NOTE}
 *
 * 月换成天按 WHO expanded tables 说明里的 1 month = 30.4375 days。`length` 是 0–24 个月的卧位身长，
 * `height` 是 24–60 个月的立位身高，两段在 24 个月（730.5 天）不连续（差约 0.7 cm），不能连起来插值。
 */
export type LmsRow = readonly [ageDays: number, l: number, m: number, s: number];

export const WHO_GROWTH_LMS = {{
{chr(10).join(out)}
}} as const satisfies Record<
  'female' | 'male',
  Record<'weight' | 'length' | 'height' | 'head', readonly LmsRow[]>
>;""")


if __name__ == '__main__':
    main()
