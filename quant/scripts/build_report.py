"""检查唯一README研究报告；不生成第二份报告。"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reports.build import build  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--review-note", help="明确说明实现变更对原理、数据、结果与限制的影响"
    )
    args = parser.parse_args()
    if args.check and args.review_note is not None:
        parser.error("检查模式不能更新审阅记录")
    try:
        print(build(check=args.check, note=args.review_note))
    except (ValueError, FileNotFoundError) as error:
        raise SystemExit(str(error)) from error
