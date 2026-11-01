#!/usr/bin/env python3
"""重新生成 apps/mobile/assets/fonts/NotoSerifSC-{Medium,Bold}.subset.ttf。

字符集 = ASCII + GB2312（一、二级汉字和符号）+ 常用标点 + 下面的名字用字表。
完整的 Noto Serif SC 每个字重有十几 MB，所以 App 只带子集；不在子集里的字回退到系统字体。

准备：

1. 源字体是可变字体 `NotoSerifSC[wght].ttf`（OFL 许可，版本 2.003）。从 Google Fonts 下载：
   https://fonts.google.com/noto/specimen/Noto+Serif+SC
   或 https://github.com/google/fonts/tree/main/ofl/notoserifsc
   文件 25 MB，不要提交进仓库。
2. 安装工具：python3 -m venv venv && venv/bin/pip install fonttools

运行（两个字重要跑几分钟）：

    venv/bin/python scripts/subset-fonts.py "/path/to/NotoSerifSC[wght].ttf"

改完字表后要看 E2E 的 e2e-05-rare-name 截图，每个字体必须小于 3.8 MB（超过时脚本报错退出）。
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

PUNCTUATION = "，。、；：？！“”‘’（）《》〈〉【】—…·℃～‹›＋−×•　"

# 宝宝名字常用、但不在 GB2312 里的字，按偏旁分组。只放 GB2312 以外的字（瑾、楠、梓这些本来就有），
# 脚本会检查。想加字就加在这里；一个字约占 0.5 KB。
NAME_CHARS = "".join(
    [
        # 王（玉）
        "玥珺瑄璟玙玚珅珣珮珽琇琍琎琤瑀瑢瑧瑨瑱璘璠璿玓玘珦玹珵琀琁琡琭琯琲琿瑒瑆瑔瑝瑫瑯瑸",
        "璆璈璥璚璪璲璵珰玠玦珖珕珝珶珸珹琄琈琑琖琞琠琣琫琱琸瑂瑃瑊瑎瑓瑩瑳瑴瑹瑺瑼瑽璂璄璉璌",
        "璙璝璡璣璦璮璯璱璹璻璼瓀瓅瓈瓉瓊瓏瓔瓘瓚",
        # 日、月、白
        "晞昉旻暐曈昳昰暻皛皞曌旸旼昺朏朓晙晢晊晛晣暎暘暠暟暲暸曚",
        # 氵
        "沄沨洺洸浛浥浵涴淏淯湉湲溍澔濛汭汧沇沕泂洢渼湜湦潽浤涬淜淩渟湋湙湞溦滈滉滙潏潓瀞",
        # 火
        "炘炤烜焌焜煐燊燚燏燨爔炟煇燿煖煚熀熤燄燑爃爚",
        # 木
        "杬枏枟柟栢梽棽楒橦櫆杺栻杋柷棨棻楙榤樑橒櫂",
        # 艹
        "芃芠荺萩蒨蓂苾",
        # 钅、讠
        "钖镕錡鋆鋐谞諠",
        # 女
        "姞婠婳嫚嬛嬿姮妘姵妡姁媞嫄孃婼嫤媗嫙娪媃姌妧姳姸姃嫆嬅妱",
        # 亻、礻
        "伃伈佺俍倓偲傒佋俙倞祎祐禛禇祾禔",
        # 山、车、马、鸟、页
        "峣崟嶒嵚辀骕骎骙骉鹓鹮颙颋颎",
        # 纟、竹、羽
        "纮簃翀翃翙翾",
        # 忄、心、雨
        "悰惇愔忞慜雱霙霨霂",
        # 其他
        "堃喆垚堉墡壐竑竫彧亶冏叡奭寀廙弢飏龑",
    ]
)

WEIGHTS = {"Medium": 500, "Bold": 700}
MAX_BYTES = 3_800_000
OUT_DIR = Path(__file__).resolve().parent.parent / "apps/mobile/assets/fonts"


def gb2312_chars() -> set[str]:
    chars = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return chars


def charset(source: Path) -> str:
    base = gb2312_chars()
    in_gb2312 = sorted(set(NAME_CHARS) & base)
    if in_gb2312:
        sys.exit(f"这些字已经在 GB2312 里，从 NAME_CHARS 删掉：{''.join(in_gb2312)}")
    font = TTFont(source, lazy=True)
    cmap = font.getBestCmap()
    missing = sorted(c for c in set(NAME_CHARS) if ord(c) not in cmap)
    if missing:
        sys.exit(f"源字体里没有这些字：{''.join(missing)}")
    chars = base | {chr(c) for c in range(0x20, 0x7F)} | set(PUNCTUATION) | set(NAME_CHARS)
    print(f"共 {len(chars)} 个字符，其中名字用字 {len(set(NAME_CHARS))} 个")
    return "".join(sorted(chars))


def run(*args: str) -> None:
    subprocess.run([sys.executable, "-m", *args], check=True)


def build(source: Path, weight_name: str, weight: int, text_file: Path, work: Path) -> None:
    instance = work / f"instance-{weight_name}.ttf"
    run("fontTools.varLib.instancer", str(source), f"wght={weight}", "-o", str(instance))
    output = OUT_DIR / f"NotoSerifSC-{weight_name}.subset.ttf"
    run(
        "fontTools.subset",
        str(instance),
        f"--text-file={text_file}",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        f"--output-file={output}",
    )
    size = output.stat().st_size
    print(f"{output.name}: {size / 1_000_000:.2f} MB")
    if size > MAX_BYTES:
        sys.exit(f"{output.name} 超过了 {MAX_BYTES} 字节，减少 NAME_CHARS")


def main() -> None:
    parser = argparse.ArgumentParser(description="重新生成 Noto Serif SC 子集字体")
    parser.add_argument("source", type=Path, help="可变字体 NotoSerifSC[wght].ttf 的路径")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        text_file = work / "chars.txt"
        text_file.write_text(charset(args.source), encoding="utf-8")
        for weight_name, weight in WEIGHTS.items():
            build(args.source, weight_name, weight, text_file, work)


if __name__ == "__main__":
    main()
