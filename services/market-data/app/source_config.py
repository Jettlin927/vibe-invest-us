import json
import os
from pathlib import Path
from typing import Any, Dict, List

from app.adapters import (
    AlpacaHistorySource,
    AlpacaNewsSource,
    AlpacaQuoteSource,
    GoogleNewsSource,
    SecFundamentalsSource,
    SinaHistorySource,
    SinaQuoteSource,
    TencentQuoteSource,
    YahooHistorySource,
    YahooNewsSource,
    YahooValuationSource,
    configure_diagnostics,
)


SOURCE_CLASSES = {
    "quote": {"alpaca": AlpacaQuoteSource, "sina": SinaQuoteSource, "tencent": TencentQuoteSource},
    "history": {"alpaca": AlpacaHistorySource, "sina": SinaHistorySource, "yahoo": YahooHistorySource},
    "news": {"alpaca": AlpacaNewsSource, "yahoo": YahooNewsSource, "google-news": GoogleNewsSource},
    "fundamentals": {"sec": SecFundamentalsSource},
    "valuation": {"yahoo-timeseries": YahooValuationSource},
}


def load_source_config() -> Dict[str, Any]:
    default_path = Path(__file__).parents[1] / "config" / "sources.json"
    path = Path(os.getenv("MARKET_DATA_SOURCE_CONFIG", str(default_path)))
    try:
        config = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"source_config_invalid:{path}") from error
    diagnostics = config.get("diagnostics", {})
    configure_diagnostics(
        enabled=bool(diagnostics.get("enabled", False)),
        directory=Path(os.getenv("MARKET_DATA_DIAGNOSTIC_DIR", "/tmp/vibe-invest-diagnostics")),
        max_bytes=int(diagnostics.get("max_bytes", 65536)),
        retention_hours=int(diagnostics.get("retention_hours", 24)),
    )
    return config


def build_sources(config: Dict[str, Any], capability: str) -> List[Any]:
    known = SOURCE_CLASSES[capability]
    entries = config.get(capability)
    if not isinstance(entries, list):
        raise RuntimeError(f"source_config_capability_invalid:{capability}")
    result = []
    for entry in sorted(entries, key=lambda item: item.get("priority", 9999)):
        if not entry.get("enabled", True):
            continue
        source_class = known.get(entry.get("name"))
        if source_class is None:
            raise RuntimeError(f"source_config_unknown:{capability}:{entry.get('name')}")
        result.append(source_class(timeout=float(entry.get("timeout_seconds", 15))))
    return result
