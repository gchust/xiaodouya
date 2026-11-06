import { describe, expect, it } from 'vitest';
import { colorDistance, contrastRatio } from '../src/themes/contrast';
import {
  type Palette,
  type PaletteKey,
  paletteFor,
  parseThemePref,
  resolveScheme,
  themeIds,
} from '../src/themes/palettes';
import { applyPalette, colors, themedStyles } from '../src/themes/runtime';

// WCAG 2.2 AA：正文 4.5:1；图形和界面元件（导航短条、开关、进度条、勾选框里的勾）3:1。
// App 里的按钮文字是 14–16 号，达不到“大字”的标准，所以按钮上的字也按 4.5 算。
const TEXT = 4.5;
const GRAPHIC = 3;

const surfaces: PaletteKey[] = ['paper', 'card', 'sand'];

/** 写在 paper、card、sand 上的文字。 */
const textOnSurfaces: PaletteKey[] = [
  'ink',
  'inkSoft',
  'muted',
  'accentText',
  'dangerText',
  'greenText',
  'warnText',
  'sleepText',
];

/** [文字, 底]：按钮、Toast、横幅。 */
const labelPairs: [PaletteKey, PaletteKey][] = [
  ['onAccent', 'accentFill'],
  ['onDanger', 'dangerFill'],
  ['onGreen', 'greenFill'],
  ['onSleep', 'sleepFill'],
  // 深色按钮、Toast、选中的胶囊：ink 底 + paper 字（ink 和 paper 的对比上面已经覆盖）。
  ['onInkMuted', 'ink'],
  ['accentLight', 'ink'],
];

/** 不写字但要看得出来的元件，和它所在的底。 */
const graphicPairs: [PaletteKey, PaletteKey][] = [
  ['accent', 'paper'],
  ['accent', 'card'],
  ['danger', 'card'],
  // 选中的勾选框是 greenFill 实心 + onGreen 的勾，靠勾表达选中，勾和底的对比在 labelPairs 里按 4.5 算。
];

const cases = themeIds.flatMap((theme) =>
  (['light', 'dark'] as const).map((scheme) => ({
    theme,
    scheme,
    palette: paletteFor(theme, scheme),
  })),
);

function ratio(p: Palette, fg: PaletteKey, bg: PaletteKey) {
  return contrastRatio(p[fg], p[bg]);
}

describe('theme contrast (WCAG AA)', () => {
  for (const { theme, scheme, palette } of cases) {
    describe(`${theme} ${scheme}`, () => {
      for (const fg of textOnSurfaces) {
        for (const bg of surfaces) {
          it(`${fg} on ${bg} ≥ ${TEXT}`, () => {
            expect(ratio(palette, fg, bg)).toBeGreaterThanOrEqual(TEXT);
          });
        }
      }
      for (const [fg, bg] of labelPairs) {
        it(`${fg} on ${bg} ≥ ${TEXT}`, () => {
          expect(ratio(palette, fg, bg)).toBeGreaterThanOrEqual(TEXT);
        });
      }
      for (const [fg, bg] of graphicPairs) {
        it(`${fg} against ${bg} ≥ ${GRAPHIC}`, () => {
          expect(ratio(palette, fg, bg)).toBeGreaterThanOrEqual(GRAPHIC);
        });
      }
    });
  }
});

describe('warnings stay the same in every theme', () => {
  // 发烧、失败的红，成功的绿，提醒的赤陶：换主题不能换掉，更不能变淡。
  const semantic: PaletteKey[] = [
    'danger',
    'dangerText',
    'dangerFill',
    'green',
    'greenText',
    'warn',
    'warnText',
    'temp',
  ];
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: identical across themes`, () => {
      const base = paletteFor('paper', scheme);
      for (const theme of themeIds) {
        const p = paletteFor(theme, scheme);
        for (const key of semantic)
          expect(`${theme}.${key}=${p[key]}`).toBe(`${theme}.${key}=${base[key]}`);
      }
    });
  }

  // 体温：38℃ 以上是 dangerText，37.5–38℃ 是 warnText，同一个弹层里加减一下就换。
  // 只靠文字区分不够，颜色本身要一眼分得开。
  it('fever and slightly-high are clearly different colors', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = paletteFor('paper', scheme);
      expect(colorDistance(p.dangerText, p.warnText)).toBeGreaterThanOrEqual(20);
      expect(colorDistance(p.danger, p.warn)).toBeGreaterThanOrEqual(20);
    }
  });

  // 疫苗本里 `已接种`（绿）和 `可以预约了`（点缀色）挨着：海盐、抹茶的点缀色也偏绿，要和成功的绿分得开。
  it('accent never looks like the success green', () => {
    for (const { theme, scheme, palette } of cases) {
      expect(
        `${theme} ${scheme} ${colorDistance(palette.accentText, palette.greenText) >= 20}`,
      ).toBe(`${theme} ${scheme} true`);
      expect(`${theme} ${scheme} ${colorDistance(palette.accent, palette.green) >= 20}`).toBe(
        `${theme} ${scheme} true`,
      );
    }
  });

  it('danger text is never the accent text', () => {
    for (const { theme, scheme, palette } of cases) {
      expect(`${theme} ${scheme} ${palette.dangerText}`).not.toBe(
        `${theme} ${scheme} ${palette.accentText}`,
      );
    }
  });
});

describe('default theme keeps the original look', () => {
  // 原来的成长册配色（SPEC 第 1 节）：纸、卡片、墨、强调色都不变。红色故意改得更红（F-142），
  // 和 37.5–38℃ 的赤陶色分得开，所以不在这里。
  it('surfaces and accent are unchanged', () => {
    const p = paletteFor('paper', 'light');
    expect({
      paper: p.paper,
      card: p.card,
      sand: p.sand,
      line: p.line,
      ink: p.ink,
      inkSoft: p.inkSoft,
      accent: p.accent,
      accentLight: p.accentLight,
      green: p.green,
      sleep: p.sleep,
    }).toEqual({
      paper: '#f6f1ea',
      card: '#fffdf9',
      sand: '#efe6d9',
      line: '#ebe2d6',
      ink: '#2b2622',
      inkSoft: '#4a423c',
      accent: '#c0714f',
      accentLight: '#e9a585',
      green: '#6f9a6a',
      sleep: '#7d8fb8',
    });
  });
});

describe('every color is a valid #rrggbb or rgba()', () => {
  for (const { theme, scheme, palette } of cases) {
    it(`${theme} ${scheme}`, () => {
      for (const [key, value] of Object.entries(palette)) {
        expect(`${key}=${value}`).toMatch(/=(#[0-9a-f]{6}|rgba\(\d+,\d+,\d+,(0|1|0?\.\d+)\))$/);
      }
    });
  }
});

describe('theme preference', () => {
  it('falls back to the default for missing or broken data', () => {
    expect(parseThemePref(null)).toEqual({ theme: 'paper', appearance: 'system' });
    expect(parseThemePref('{not json')).toEqual({ theme: 'paper', appearance: 'system' });
    expect(parseThemePref('[]')).toEqual({ theme: 'paper', appearance: 'system' });
  });

  it('keeps a valid choice and drops unknown values field by field', () => {
    expect(parseThemePref('{"theme":"lavender","appearance":"dark"}')).toEqual({
      theme: 'lavender',
      appearance: 'dark',
    });
    // 新版本加的主题，回到旧版本时不能整个丢掉深浅的选择。
    expect(parseThemePref('{"theme":"ocean","appearance":"light"}')).toEqual({
      theme: 'paper',
      appearance: 'light',
    });
  });

  it('follows the system unless light or dark is chosen', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });
});

describe('switching themes at runtime', () => {
  it('module-level style sheets pick up the new palette', () => {
    applyPalette(paletteFor('paper', 'light'));
    let built = 0;
    const s = themedStyles(() => {
      built += 1;
      return { card: { backgroundColor: colors.card, color: colors.ink } };
    });
    expect(s.card.backgroundColor).toBe('#fffdf9');
    expect(s.card.backgroundColor).toBe('#fffdf9');
    expect(built).toBe(1);

    applyPalette(paletteFor('lavender', 'dark'));
    expect(colors.paper).toBe(paletteFor('lavender', 'dark').paper);
    expect(s.card).toEqual({
      backgroundColor: paletteFor('lavender', 'dark').card,
      color: paletteFor('lavender', 'dark').ink,
    });
    expect(built).toBe(2);
    expect({ ...s }).toEqual({ card: s.card });

    // 同一套颜色再应用一次不用重新生成。
    applyPalette(paletteFor('lavender', 'dark'));
    void s.card;
    expect(built).toBe(2);
    applyPalette(paletteFor('paper', 'light'));
  });
});
