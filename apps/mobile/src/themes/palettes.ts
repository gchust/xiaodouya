/**
 * 主题配色（F-142，issue #97）。设计意图和每个值的用途见 docs/design/SPEC.md 的“主题配色”。
 *
 * 这个文件不能引 React Native：对比度测试（test/themes.test.ts）要在 vitest 里直接加载它。
 *
 * 每套主题只换“纸、墨、点缀色”：页面底、卡片、文字、强调色。表示状态的颜色（发烧和失败的红、
 * 成功的绿、提醒的赤陶、睡眠的蓝）和记录类型的色点在所有主题里一样，只分浅色和深色，
 * 这样换了主题，警示不会被弱化，也不会和别的主题里意思不同。
 */
import { z } from 'zod';

export const themeIds = ['paper', 'lavender', 'mist', 'seaSalt', 'matcha'] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultThemeId: ThemeId = 'paper';

export const appearances = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof appearances)[number];
export type Scheme = 'light' | 'dark';

/** 存在这台手机上的选择。读的时候过 zod，坏了或者是将来的新主题名就回到默认。 */
export const themePrefSchema = z.object({
  theme: z.enum(themeIds).catch(defaultThemeId),
  appearance: z.enum(appearances).catch('system'),
});
export type ThemePref = z.infer<typeof themePrefSchema>;
export const defaultThemePref: ThemePref = { theme: defaultThemeId, appearance: 'system' };

export function parseThemePref(raw: string | null | undefined): ThemePref {
  if (!raw) return defaultThemePref;
  try {
    const parsed = themePrefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaultThemePref;
  } catch {
    return defaultThemePref;
  }
}

export function resolveScheme(appearance: Appearance, system: Scheme | null | undefined): Scheme {
  if (appearance === 'light' || appearance === 'dark') return appearance;
  return system === 'dark' ? 'dark' : 'light';
}

type Hex = `#${string}`;
type Rgba = `rgba(${string})`;

/** 随主题变的部分。 */
type Surfaces = {
  /** 页面底。 */
  paper: Hex;
  /** 卡片、弹层。 */
  card: Hex;
  /** 提示卡、头像底、小按钮底。 */
  sand: Hex;
  /** 卡片和导航的边框、图片占位。 */
  line: Hex;
  /** 列表分隔线。 */
  rule: Hex;
  /** 进度条的底、行分隔。 */
  track: Hex;
  /** 回忆页吸顶标签的半透明卡片底。 */
  cardGlass: Rgba;
  /** 主文字。 */
  ink: Hex;
  /** 次级正文。 */
  inkSoft: Hex;
  /** 辅助文字、占位文字。 */
  muted: Hex;
  /** 禁用的箭头、空心圆点的边。不承载要读的文字。 */
  hint: Hex;
  /** 开关关闭、波形未播放、没选中的圆点。 */
  off: Hex;
  /** 虚线框。 */
  dashed: Hex;
  /** 弹层顶部的拖动条。 */
  handle: Hex;
  /** 开关的圆钮。 */
  knob: Hex;
  /** 弹层后面的遮罩。 */
  scrim: Rgba;
  /** 强调色本身：导航短条、开关打开、进度条、选中的边框。 */
  accent: Hex;
  /** 强调色的文字（小字链接、`以后再说` 旁边的动作）。 */
  accentText: Hex;
  /** 有文字压在上面的强调色按钮（喂奶按钮、主按钮）。 */
  accentFill: Hex;
  onAccent: Hex;
  // 深色按钮、Toast、选中的胶囊是 ink 底 + paper 字。深色模式下两者对调（浅色按钮、深色字），
  // 仍然是页面上最显眼的那个，不用另外的令牌。
  /** ink 底上的次级文字。 */
  onInkMuted: Hex;
  /** ink 底上的强调色文字（Toast 的 `撤销`），以及看图时的封面圆点。 */
  accentLight: Hex;
};

/** 所有主题共用、只分浅深的部分。 */
type Semantic = {
  /** 发烧、失败、删除。 */
  danger: Hex;
  dangerText: Hex;
  dangerFill: Hex;
  onDanger: Hex;
  /** 成功、已接种、在线。 */
  green: Hex;
  greenText: Hex;
  greenFill: Hex;
  onGreen: Hex;
  /** 提醒但不紧急：37.5–38℃、低于参考量、存储快满、早于出生。不随主题变成别的颜色。 */
  warn: Hex;
  warnText: Hex;
  /** 睡眠。 */
  sleep: Hex;
  sleepText: Hex;
  sleepFill: Hex;
  onSleep: Hex;
  // 记录类型的色点，和 packages/shared 的 eventColors 一致（分享页用那一份，不跟主题）。
  feed: Hex;
  diaper: Hex;
  temp: Hex;
  med: Hex;
  bath: Hex;
  solids: Hex;
  growth: Hex;
  vaccine: Hex;
  wee: Hex;
  poo: Hex;
};

/** 不随主题也不随深浅变：压在照片、视频和黑底查看器上的颜色。 */
const media = {
  white: '#ffffff',
  black: '#000000',
  /** 照片上的小胶囊、关闭按钮的底。 */
  mediaChip: 'rgba(0,0,0,0.35)',
  mediaChipStrong: 'rgba(0,0,0,0.55)',
  /** 裁剪框外面的暗区。 */
  mediaMask: 'rgba(0,0,0,0.62)',
  mediaLine: 'rgba(255,255,255,0.55)',
  mediaFill: 'rgba(255,255,255,0.14)',
  /** 回忆封面上的时长、`共 N 项`、封面标签的底。 */
  veilSoft: 'rgba(43,38,34,0.55)',
  veil: 'rgba(43,38,34,0.6)',
  veilStrong: 'rgba(43,38,34,0.7)',
} as const satisfies Record<string, Hex | Rgba>;

export type Palette = Surfaces & Semantic & { -readonly [K in keyof typeof media]: string };
export type PaletteKey = keyof Palette;

const semanticLight: Semantic = {
  danger: '#c4483f',
  dangerText: '#a8322c',
  dangerFill: '#a8322c',
  onDanger: '#ffffff',
  green: '#6f9a6a',
  greenText: '#4c6e48',
  greenFill: '#567c52',
  onGreen: '#ffffff',
  warn: '#c0714f',
  warnText: '#94563c',
  sleep: '#7d8fb8',
  sleepText: '#54638a',
  sleepFill: '#5f709a',
  onSleep: '#ffffff',
  feed: '#c0714f',
  diaper: '#c9a24a',
  temp: '#b8645e',
  med: '#8a7a9e',
  bath: '#6f9aa0',
  solids: '#c9a24a',
  growth: '#6f9a6a',
  vaccine: '#6f9a6a',
  wee: '#d9c06a',
  poo: '#a07a3a',
};

// 深色：半夜看。状态色提亮一档但降低饱和，按钮底反而压暗，大块颜色不刺眼。
// 喂奶、睡眠、便便的色点和桌面小工具的深色版一致（SPEC“桌面小工具”）。
const semanticDark: Semantic = {
  danger: '#e5736a',
  dangerText: '#f28b82',
  dangerFill: '#94443f',
  onDanger: '#fbeeec',
  green: '#8fb889',
  greenText: '#9fc799',
  greenFill: '#4b6a47',
  onGreen: '#eef6ec',
  warn: '#d9a052',
  warnText: '#e6b36e',
  sleep: '#8b9cc6',
  sleepText: '#aebbdc',
  sleepFill: '#4c5a80',
  onSleep: '#e3e8f5',
  feed: '#d9876a',
  diaper: '#d1ad5a',
  temp: '#d9837b',
  med: '#a796bb',
  bath: '#84b0b6',
  solids: '#d1ad5a',
  growth: '#8fb889',
  vaccine: '#8fb889',
  wee: '#ddc77a',
  poo: '#b48a48',
};

function palette(surfaces: Surfaces, scheme: Scheme): Palette {
  return { ...surfaces, ...(scheme === 'dark' ? semanticDark : semanticLight), ...media };
}

type ThemeDef = { light: Surfaces; dark: Surfaces };

const themes: Record<ThemeId, ThemeDef> = {
  // 暖纸：原来的成长册配色，默认。深色版取自桌面小工具的深色卡片。
  paper: {
    light: {
      paper: '#f6f1ea',
      card: '#fffdf9',
      sand: '#efe6d9',
      line: '#ebe2d6',
      rule: '#f1eadf',
      track: '#efe7dc',
      cardGlass: 'rgba(255,253,249,0.92)',
      ink: '#2b2622',
      inkSoft: '#4a423c',
      muted: '#6f655d',
      hint: '#cfc4b6',
      off: '#d8cfc3',
      dashed: '#d8ccbc',
      handle: '#e0d6c9',
      knob: '#ffffff',
      scrim: 'rgba(43,38,34,0.38)',
      accent: '#c0714f',
      accentText: '#94563c',
      accentFill: '#a9603f',
      onAccent: '#ffffff',
      onInkMuted: '#bdb3a8',
      accentLight: '#e9a585',
    },
    dark: {
      paper: '#1d1916',
      card: '#26211d',
      sand: '#322b26',
      line: '#352e28',
      rule: '#2e2823',
      track: '#3a322c',
      cardGlass: 'rgba(38,33,29,0.92)',
      ink: '#f3ece3',
      inkSoft: '#dcd2c6',
      muted: '#ab9f93',
      hint: '#5c524a',
      off: '#544a42',
      dashed: '#5a4f46',
      handle: '#4a413a',
      knob: '#efe7dd',
      scrim: 'rgba(0,0,0,0.5)',
      accent: '#d9876a',
      accentText: '#e9a585',
      accentFill: '#9b5638',
      onAccent: '#fbf1ea',
      onInkMuted: '#665c53',
      accentLight: '#8a4f37',
    },
  },
  // 薰衣草：灰一点的淡紫，像傍晚的天色，安静。
  lavender: {
    light: {
      paper: '#f4f1f6',
      card: '#fdfcfe',
      sand: '#ebe6f0',
      line: '#e6e0ec',
      rule: '#efeaf3',
      track: '#e9e3ef',
      cardGlass: 'rgba(253,252,254,0.92)',
      ink: '#2a2530',
      inkSoft: '#463f4e',
      muted: '#6a6274',
      hint: '#cbc3d4',
      off: '#d5cdde',
      dashed: '#cfc6da',
      handle: '#ddd6e5',
      knob: '#ffffff',
      scrim: 'rgba(42,37,48,0.38)',
      accent: '#8e76b2',
      accentText: '#6a5390',
      accentFill: '#765f9c',
      onAccent: '#ffffff',
      onInkMuted: '#bbb2c6',
      accentLight: '#c9b6e6',
    },
    dark: {
      paper: '#1a1720',
      card: '#231f29',
      sand: '#2e2935',
      line: '#332d3b',
      rule: '#2b2632',
      track: '#38323f',
      cardGlass: 'rgba(35,31,41,0.92)',
      ink: '#efeaf4',
      inkSoft: '#d6cee0',
      muted: '#a69db2',
      hint: '#554d5f',
      off: '#4f4759',
      dashed: '#564e61',
      handle: '#463f50',
      knob: '#ece6f2',
      scrim: 'rgba(0,0,0,0.5)',
      accent: '#b39ad7',
      accentText: '#c6b2e6',
      accentFill: '#674f8c',
      onAccent: '#f6f1fc',
      onInkMuted: '#675e72',
      accentLight: '#6a5390',
    },
  },
  // 雾蓝：清晨窗外的雾，灰蓝色，冷静但不冷。
  mist: {
    light: {
      paper: '#eff3f5',
      card: '#fbfdfe',
      sand: '#e3eaee',
      line: '#dfe6eb',
      rule: '#e8eef1',
      track: '#e2e9ed',
      cardGlass: 'rgba(251,253,254,0.92)',
      ink: '#222a30',
      inkSoft: '#3d4850',
      muted: '#5d6a73',
      hint: '#bfcad1',
      off: '#cbd4da',
      dashed: '#c3ced5',
      handle: '#d4dde2',
      knob: '#ffffff',
      scrim: 'rgba(34,42,48,0.38)',
      accent: '#6189ab',
      accentText: '#426887',
      accentFill: '#4d7495',
      onAccent: '#ffffff',
      onInkMuted: '#b0bcc4',
      accentLight: '#a9c7e2',
    },
    dark: {
      paper: '#151b1f',
      card: '#1d2428',
      sand: '#273036',
      line: '#2b343a',
      rule: '#232b31',
      track: '#2f393f',
      cardGlass: 'rgba(29,36,40,0.92)',
      ink: '#e8eef2',
      inkSoft: '#cbd6dd',
      muted: '#97a5ae',
      hint: '#4a5760',
      off: '#45515a',
      dashed: '#4c5962',
      handle: '#3c474f',
      knob: '#e3eaee',
      scrim: 'rgba(0,0,0,0.5)',
      accent: '#8fb2d2',
      accentText: '#a7c5e0',
      accentFill: '#456a8a',
      onAccent: '#eef5fb',
      onInkMuted: '#56636c',
      accentLight: '#3f6483',
    },
  },
  // 海盐：浅浅的青绿，像海边的风，清爽。
  seaSalt: {
    light: {
      paper: '#eef4f2',
      card: '#fbfdfc',
      sand: '#e1ebe8',
      line: '#dce7e3',
      rule: '#e7efec',
      track: '#e0eae6',
      cardGlass: 'rgba(251,253,252,0.92)',
      ink: '#1f2a28',
      inkSoft: '#3a4845',
      muted: '#5a6a66',
      hint: '#bccbc6',
      off: '#c8d5d1',
      dashed: '#bfcfca',
      handle: '#d1ddd9',
      knob: '#ffffff',
      scrim: 'rgba(31,42,40,0.38)',
      accent: '#4a8e98',
      accentText: '#2b6871',
      accentFill: '#367780',
      onAccent: '#ffffff',
      onInkMuted: '#aebdb9',
      accentLight: '#94ccd4',
    },
    dark: {
      paper: '#141b1a',
      card: '#1b2422',
      sand: '#25302d',
      line: '#2a3532',
      rule: '#222c2a',
      track: '#2d3936',
      cardGlass: 'rgba(27,36,34,0.92)',
      ink: '#e6f0ed',
      inkSoft: '#c8d8d4',
      muted: '#93a6a1',
      hint: '#465753',
      off: '#41524e',
      dashed: '#485955',
      handle: '#3a4845',
      knob: '#e1ebe8',
      scrim: 'rgba(0,0,0,0.5)',
      accent: '#72b5c0',
      accentText: '#8cc6cf',
      accentFill: '#30656d',
      onAccent: '#ecf7f5',
      onInkMuted: '#53645f',
      accentLight: '#2b6871',
    },
  },
  // 抹茶：带一点黄的苔绿，暖的绿色，和表示“成功”的绿错开色相。
  matcha: {
    light: {
      paper: '#f3f3ea',
      card: '#fdfdf8',
      sand: '#e9eadb',
      line: '#e4e5d5',
      rule: '#eeeee3',
      track: '#e7e8d9',
      cardGlass: 'rgba(253,253,248,0.92)',
      ink: '#282a1f',
      inkSoft: '#43463a',
      muted: '#65685a',
      hint: '#c9cbb8',
      off: '#d4d6c4',
      dashed: '#cdd0bb',
      handle: '#dcdecd',
      knob: '#ffffff',
      scrim: 'rgba(40,42,31,0.38)',
      accent: '#8f873a',
      accentText: '#6a6220',
      accentFill: '#716a2a',
      onAccent: '#ffffff',
      onInkMuted: '#bcbeac',
      accentLight: '#d6cf86',
    },
    dark: {
      paper: '#191a14',
      card: '#21231b',
      sand: '#2c2e24',
      line: '#313328',
      rule: '#292b21',
      track: '#35372b',
      cardGlass: 'rgba(33,35,27,0.92)',
      ink: '#eeefe4',
      inkSoft: '#d4d6c6',
      muted: '#a3a693',
      hint: '#53564a',
      off: '#4d5044',
      dashed: '#54574a',
      handle: '#45473b',
      knob: '#e9eadb',
      scrim: 'rgba(0,0,0,0.5)',
      accent: '#c4bb6a',
      accentText: '#d3ca86',
      accentFill: '#615a22',
      onAccent: '#f5f6e8',
      onInkMuted: '#5e6154',
      accentLight: '#6a6220',
    },
  },
};

export function paletteFor(theme: ThemeId, scheme: Scheme): Palette {
  return palette(themes[theme][scheme], scheme);
}

/** 预览小样用：每套主题的几个代表色，不用整套调色板。 */
export function swatchFor(theme: ThemeId, scheme: Scheme) {
  const p = paletteFor(theme, scheme);
  return {
    paper: p.paper,
    card: p.card,
    ink: p.ink,
    muted: p.muted,
    accent: p.accent,
    line: p.line,
  };
}
