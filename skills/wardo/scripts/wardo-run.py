#!/usr/bin/env python3
"""Reusable Python runner for the wardo skill.

The checkout's bundled ``python`` directory is added automatically when this
skill lives inside a wardo checkout. Set WARDO_PYTHON_PATH for another path.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def add_runtime_path() -> None:
    candidates = []
    if os.environ.get("WARDO_PYTHON_PATH"):
        candidates.append(Path(os.environ["WARDO_PYTHON_PATH"]))
    candidates.extend(parent / "python" for parent in Path(__file__).resolve().parents)
    for candidate in candidates:
        if (candidate / "wardo").is_dir():
            sys.path.insert(0, str(candidate))
            return


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="wardo-run.py")
    parser.add_argument("prompt", nargs="+")
    parser.add_argument("--plan", choices=("single", "auto"), default="single")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    add_runtime_path()
    from wardo import execute

    args = parse_args(argv)
    result = execute(" ".join(args.prompt), workspace=args.workspace, resume=args.resume, plan=args.plan)
    for task_id, task_result in result.items():
        print(f"{task_id}: {task_result.status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
