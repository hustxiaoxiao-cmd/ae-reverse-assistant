#!/usr/bin/env python3
"""
评测集脚手架 #3：反向汇总脚本
====================================

用途：
  1) 读取 tests/eval/entries-catalog.csv 中用户标注的 `assigned_to` 列
  2) 反向汇总：每个 eval-xxx 题应该召回哪些 entry.id
  3) 合并回 tests/eval/eval-set.json 的 expectedIds 字段（保留其他字段）
  4) 输出一份反向汇总报告到 tests/eval/reverse-summary.md

使用步骤：
  0) 先跑 npm run eval:export 生成 entries-catalog.csv
  1) 用 Excel/飞书表格/Numbers 打开 entries-catalog.csv
  2) 在末尾加一列 "assigned_to"，对每条 entry 填入它对应的题目 id
     - 单题：填 eval-001
     - 多题：填 eval-001,eval-004（逗号分隔，不要带空格）
     - 不对应任何题：留空
  3) 保存（覆盖原 csv 文件）
  4) 跑本脚本：
       python3 scripts/reverse-assign.py
  5) 跑自检脚本确认：
       npm run eval:check

注意：
  - 不会删除 eval-set.json 中的其他字段（category/difficulty/notes 等）
  - 会保留原 expectedIds 中"非 UUID"的值（比如占位符、手写备注）
  - UUID 形态的值会被 csv 标注覆盖；非 UUID 形态的保留
"""

import csv
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = PROJECT_ROOT / "tests" / "eval" / "entries-catalog.csv"
EVAL_SET_PATH = PROJECT_ROOT / "tests" / "eval" / "eval-set.json"
SUMMARY_PATH = PROJECT_ROOT / "tests" / "eval" / "reverse-summary.md"

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def parse_assigned(value: str):
    """把 assigned_to 字段解析成 eval-id 列表，去重并清洗"""
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def read_catalog():
    """读取 csv，返回 list of dict，要求列名包含 id / title / module / assigned_to"""
    if not CSV_PATH.exists():
        print(f"✗ csv 不存在: {CSV_PATH}")
        print("  请先跑: npm run eval:export")
        sys.exit(1)

    rows = []
    with open(CSV_PATH, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        # 列名校准：允许带 BOM、多余空格
        reader.fieldnames = [name.strip().lstrip("\ufeff") for name in reader.fieldnames]
        fieldnames = list(reader.fieldnames)

        if "id" not in fieldnames:
            print("✗ csv 缺少必需列 'id'")
            sys.exit(1)

        needs_assign_col = "assigned_to" not in fieldnames
        if needs_assign_col:
            fieldnames.append("assigned_to")

        for row in reader:
            clean = {k: (v or "").strip() for k, v in row.items()}
            clean.setdefault("assigned_to", "")
            rows.append(clean)

    # 如果 csv 缺 assigned_to 列，自动补上并回写一次，方便用户用 Excel 打开直接填
    if needs_assign_col:
        with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"ℹ csv 缺少 'assigned_to' 列，已自动追加空列并回写: {CSV_PATH}")
        print("  请用 Excel / 飞书表格 / Numbers 打开，在 'assigned_to' 列填入对应的题目 id（如 eval-001）")
        print("  多题用逗号分隔（如 eval-001,eval-004），留空表示不对应任何题目")
        print("  填完后重跑本脚本即可。")
        sys.exit(0)

    return rows


def build_reverse_map(rows):
    """rows -> {eval_id: [entry_id, entry_id, ...]}（按出现顺序）"""
    reverse = defaultdict(list)
    annotated_count = 0
    invalid_count = 0

    for row in rows:
        entry_id = row["id"]
        assigned = parse_assigned(row.get("assigned_to", ""))
        if not assigned:
            continue
        annotated_count += 1
        for eval_id in assigned:
            if not re.match(r"^eval-\w+$", eval_id):
                print(f"  ⚠ entry {entry_id[:8]}… assigned_to 中含非 eval-id 值: '{eval_id}'，跳过")
                invalid_count += 1
                continue
            reverse[eval_id].append(entry_id)

    # 去重
    for eval_id in reverse:
        reverse[eval_id] = list(dict.fromkeys(reverse[eval_id]))

    print(f"✓ 共扫描 {len(rows)} 条 entry，{annotated_count} 条被标注")
    print(f"✓ 涉及 {len(reverse)} 道题目")
    if invalid_count:
        print(f"  ⚠ 跳过 {invalid_count} 个非法标注（期望 eval-xxx 形式）")

    return reverse


def merge_into_eval_set(reverse_map):
    """合并到 eval-set.json：只覆盖 expectedIds 中的 UUID 项，保留其他非 UUID 项"""
    if not EVAL_SET_PATH.exists():
        print(f"✗ eval-set.json 不存在: {EVAL_SET_PATH}")
        sys.exit(1)

    with open(EVAL_SET_PATH, "r", encoding="utf-8") as f:
        cases = json.load(f)

    # 建立 eval_id -> index 索引
    idx_by_id = {c.get("id"): i for i, c in enumerate(cases)}
    new_uuid_count = 0
    unknown_ids = []

    for eval_id, entry_ids in reverse_map.items():
        if eval_id not in idx_by_id:
            unknown_ids.append(eval_id)
            continue
        case = cases[idx_by_id[eval_id]]
        # 保留原 expectedIds 中"非 UUID"的值（可能是备注或占位符）
        old_non_uuid = [e for e in case.get("expectedIds", []) if not UUID_RE.match(e)]
        case["expectedIds"] = entry_ids + old_non_uuid
        new_uuid_count += len(entry_ids)

    with open(EVAL_SET_PATH, "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False, indent=2)

    print(f"✓ eval-set.json 已更新，新增 {new_uuid_count} 条 UUID 级 expectedIds")
    if unknown_ids:
        print(f"  ⚠ csv 中引用的 {len(unknown_ids)} 个 eval-id 在 eval-set.json 里不存在：")
        for eid in unknown_ids:
            print(f"     - {eid}")
        print("  请先在 eval-set.json 里添加对应的题目定义，再重跑本脚本")

    return cases, unknown_ids


def write_summary(reverse_map, cases):
    """生成反向汇总报告 markdown"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = []
    lines.append(f"# 评测集反向汇总报告")
    lines.append("")
    lines.append(f"> 生成时间: {now}")
    lines.append(f"> 数据来源: {CSV_PATH.relative_to(PROJECT_ROOT)}")
    lines.append("")
    lines.append("每道题应该召回的 entry（按 csv 标注聚合）：")
    lines.append("")

    covered = 0
    uncovered = 0
    for case in cases:
        eval_id = case["id"]
        ids = reverse_map.get(eval_id, [])
        if ids:
            covered += 1
        else:
            uncovered += 1
        status = "✓" if ids else "✗ 待标注"
        lines.append(f"## {eval_id} {status}")
        lines.append(f"- **query**: {case.get('query','(无)')}")
        lines.append(f"- **category**: {case.get('category','-')} / **difficulty**: {case.get('difficulty','-')}")
        if case.get("notes"):
            lines.append(f"- **notes**: {case.get('notes')}")
        if ids:
            lines.append(f"- **expectedIds** ({len(ids)} 条):")
            for eid in ids:
                lines.append(f"  - `{eid}`")
        else:
            lines.append(f"- **expectedIds**: （空，待标注）")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"覆盖率: {covered}/{len(cases)} 题已标注 ({covered*100//max(len(cases),1)}%)")
    lines.append(f"未标注: {uncovered} 题")

    SUMMARY_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"✓ 反向汇总报告 → {SUMMARY_PATH.relative_to(PROJECT_ROOT)}")


def main():
    print("=== 评测集反向汇总 ===")
    print(f"项目根: {PROJECT_ROOT}")
    print()

    rows = read_catalog()
    reverse_map = build_reverse_map(rows)
    cases, unknown_ids = merge_into_eval_set(reverse_map)
    write_summary(reverse_map, cases)

    print()
    print("=== 下一步 ===")
    print("1) 打开 tests/eval/reverse-summary.md 查看聚合结果")
    print("2) 跑自检脚本确认质量:  npm run eval:check")


if __name__ == "__main__":
    main()
