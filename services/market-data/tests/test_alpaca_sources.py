from datetime import timezone

import pytest

from app.adapters import AlpacaHistorySource, AlpacaNewsSource, AlpacaQuoteSource
from app.source_config import build_sources, load_source_config


def test_highest_success_rate_sources_are_first_by_default():
    config = load_source_config()

    assert [source.name for source in build_sources(config, "quote")][:2] == ["tencent", "sina"]
    assert [source.name for source in build_sources(config, "history")][:2] == ["yahoo", "sina"]
    assert [source.name for source in build_sources(config, "news")][:2] == ["yahoo", "google-news"]


def test_alpaca_quote_uses_latest_trade_and_iex_by_default(monkeypatch):
    calls = []
    monkeypatch.delenv("ALPACA_DATA_FEED", raising=False)
    monkeypatch.setattr(AlpacaQuoteSource, "read", lambda self, path, params=None: (
        calls.append((path, params)) or {
            "symbol": "NVDA", "trade": {"p": 181.42, "t": "2026-08-12T14:30:00Z"},
        }
    ))

    quote = AlpacaQuoteSource().fetch("NVDA")

    assert quote.price == 181.42
    assert quote.observed_at.tzinfo == timezone.utc
    assert calls == [("/v2/stocks/NVDA/trades/latest", {"feed": "iex"})]
    assert "feed=iex" in quote.source_reference


def test_alpaca_quote_accepts_nanosecond_timestamp(monkeypatch):
    monkeypatch.setattr(AlpacaQuoteSource, "read", lambda self, path, params=None: {
        "symbol": "NVDA", "trade": {"p": 181.42, "t": "2026-08-11T19:59:57.900326649Z"},
    })

    quote = AlpacaQuoteSource().fetch("NVDA")

    assert quote.observed_at.isoformat() == "2026-08-11T19:59:57.900326+00:00"


def test_alpaca_credentials_are_only_sent_as_headers(monkeypatch):
    captured = {}
    monkeypatch.setenv("ALPACA_API_KEY", "key-id")
    monkeypatch.setenv("ALPACA_API_SECRET", "secret-key")

    def read(url, params=None, headers=None, timeout=15):
        captured.update(url=url, params=params, headers=headers, timeout=timeout)
        return b'{"symbol":"NVDA","trade":{"p":181.42,"t":"2026-08-12T14:30:00Z"}}'

    monkeypatch.setattr("app.adapters._read", read)
    quote = AlpacaQuoteSource(timeout=7).fetch("NVDA")

    assert captured["url"] == "https://data.alpaca.markets/v2/stocks/NVDA/trades/latest"
    assert captured["params"] == {"feed": "iex"}
    assert captured["headers"] == {
        "APCA-API-KEY-ID": "key-id", "APCA-API-SECRET-KEY": "secret-key",
    }
    assert captured["timeout"] == 7
    assert "key-id" not in quote.source_reference
    assert "secret-key" not in quote.source_reference


def test_alpaca_history_follows_page_token_and_normalizes_daily_bars(monkeypatch):
    calls = []
    pages = iter([
        {"bars": [{"t": "2026-08-10T04:00:00Z", "o": 1, "h": 3, "l": 1, "c": 2, "v": 10}],
         "next_page_token": "page-2"},
        {"bars": [{"t": "2026-08-11T04:00:00Z", "o": 2, "h": 4, "l": 2, "c": 3, "v": 20}],
         "next_page_token": None},
    ])

    def read(_self, path, params=None):
        calls.append((path, dict(params)))
        return next(pages)

    monkeypatch.setattr(AlpacaHistorySource, "read", read)
    bars = AlpacaHistorySource().fetch("NVDA")

    assert [bar.date for bar in bars] == ["2026-08-10", "2026-08-11"]
    assert calls[0][1]["adjustment"] == "all"
    assert calls[0][1]["sort"] == "asc"
    assert calls[1][1]["page_token"] == "page-2"


def test_alpaca_news_follows_page_token_and_maps_metadata(monkeypatch):
    calls = []
    pages = iter([
        {"news": [{
            "headline": "NVIDIA update", "source": "Benzinga",
            "created_at": "2026-08-12T10:00:00Z", "url": "https://example.com/1",
            "summary": "Summary", "symbols": ["NVDA"],
        }], "next_page_token": "page-2"},
        {"news": [{
            "headline": "Second update", "created_at": "2026-08-11T10:00:00Z",
            "url": "https://example.com/2", "symbols": ["NVDA"],
        }], "next_page_token": None},
    ])

    def read(_self, path, params=None):
        calls.append((path, dict(params)))
        return next(pages)

    monkeypatch.setattr(AlpacaNewsSource, "read", read)
    items = AlpacaNewsSource().fetch("NVDA")

    assert [item.title for item in items] == ["NVIDIA update", "Second update"]
    assert items[0].source == "Benzinga"
    assert items[1].summary == "Second update"
    assert calls[0][1]["include_content"] == "false"
    assert calls[1][1]["page_token"] == "page-2"


def test_alpaca_requires_both_credentials(monkeypatch):
    monkeypatch.delenv("ALPACA_API_KEY", raising=False)
    monkeypatch.delenv("ALPACA_API_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="alpaca_credentials_missing"):
        AlpacaQuoteSource().fetch("NVDA")


def test_alpaca_feed_must_be_explicitly_supported(monkeypatch):
    monkeypatch.setenv("ALPACA_DATA_FEED", "unknown")

    with pytest.raises(ValueError, match="ALPACA_DATA_FEED_invalid"):
        AlpacaQuoteSource().fetch("NVDA")
