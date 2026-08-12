#!/usr/bin/env python3
"""Probe enabled market-data sources and rank qualified results by reliability."""

import argparse
import json
import os
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "market-data"))

from app.source_config import build_sources, load_source_config  # noqa: E402


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def qualify(capability, value):
    if value is None or value == [] or value == {}:
        return False, "empty"
    if capability == "valuation":
        payload = value.model_dump()
        current_pe = payload.get("current_multiples", {}).get("pe")
        available = [name for name, result in payload.get("methods", {}).items()
                     if result.get("status") == "available"]
        return bool(current_pe or available), f"current_pe={current_pe};methods={','.join(available) or 'none'}"
    if capability == "fundamentals":
        fields = [name for name in ("dilutedEps", "revenue", "netIncome", "operatingCashFlow") if value.get(name)]
        return bool(fields), f"fields={','.join(fields) or 'none'}"
    count = len(value) if isinstance(value, list) else 1
    return count > 0, f"items={count}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("symbols", nargs="*", default=["NVDA", "AAPL", "MSFT", "CRM", "JPM"])
    parser.add_argument("--json", action="store_true", help="emit JSON")
    args = parser.parse_args()
    load_env(ROOT / ".env")
    config = load_source_config()
    results = []
    for capability in ("quote", "history", "news", "fundamentals", "valuation"):
        for priority, source in enumerate(build_sources(config, capability), start=1):
            samples, passed, elapsed_total = [], 0, 0.0
            for symbol_input in args.symbols:
                symbol = symbol_input.strip().upper()
                started = time.monotonic()
                try:
                    value = source.fetch(symbol)
                    elapsed = time.monotonic() - started
                    qualified, detail = qualify(capability, value)
                    status = "ok" if qualified else "unqualified"
                    passed += int(qualified)
                except Exception as error:
                    elapsed = time.monotonic() - started
                    status, detail = "failed", f"{type(error).__name__}:{error}"
                elapsed_total += elapsed
                samples.append({"symbol": symbol, "status": status, "seconds": round(elapsed, 3), "detail": detail})
            results.append({
                "capability": capability, "source": source.name, "configuredPriority": priority,
                "successRate": round(passed / len(args.symbols), 4),
                "averageSeconds": round(elapsed_total / len(args.symbols), 3), "samples": samples,
            })
    recommendations = {}
    for capability in ("quote", "history", "news", "fundamentals", "valuation"):
        candidates = [item for item in results if item["capability"] == capability]
        recommendations[capability] = [item["source"] for item in sorted(
            candidates, key=lambda item: (-item["successRate"], item["averageSeconds"]),
        )]
    payload = {"symbols": [value.upper() for value in args.symbols], "results": results, "recommendedOrder": recommendations}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    for item in results:
        print(f"{item['capability']:12} {item['source']:18} success={item['successRate']:.0%} avg={item['averageSeconds']:.3f}s")
        for sample in item["samples"]:
            if sample["status"] != "ok":
                print(f"  - {sample['symbol']}: {sample['status']} | {sample['detail']}")
    print("\nRecommended order (qualified rate, then average latency):")
    for capability, sources in recommendations.items():
        print(f"{capability:12} {' > '.join(sources)}")


if __name__ == "__main__":
    main()
