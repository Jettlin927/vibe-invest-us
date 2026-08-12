from datetime import datetime, timezone

from app.context import build_financial_context
from app.models import DailyBar, NewsItem, Quote


NOW = datetime(2026, 8, 12, 12, 0, tzinfo=timezone.utc)


class Source:
    def __init__(self, name, value=None, error=None):
        self.name, self.value, self.error = name, value, error

    def fetch(self, _symbol):
        if self.error:
            raise self.error
        return self.value


def bars():
    return [DailyBar(date=f"2026-07-{day:02d}", open=day, high=day + 2, low=day - 1,
                     close=day + 1, volume=day * 1000) for day in range(1, 31)]


def test_primary_quote_failure_uses_fallback_and_reports_degradation():
    context = build_financial_context(
        "NVDA", NOW,
        quote_sources=[Source("primary", error=RuntimeError("down")),
                       Source("fallback", Quote(price=120, observed_at=NOW, source_reference="fallback://NVDA"))],
        history_sources=[Source("history", bars())], news_sources=[], fundamentals_source=None,
    )

    assert context.quote.value.price == 120
    assert context.quote.adopted_source == "fallback"
    assert context.quote.degraded is True
    assert [item.status for item in context.quote.sources] == ["failed", "ok"]
    assert context.facts[0].type == "quote"
    assert context.facts[0].source == "fallback"


def test_conflicting_source_observations_are_both_preserved():
    context = build_financial_context(
        "NVDA", NOW,
        quote_sources=[
            Source("primary", Quote(price=120, observed_at=NOW, source_reference="primary://NVDA")),
            Source("fallback", Quote(price=121, observed_at=NOW, source_reference="fallback://NVDA")),
        ],
        history_sources=[], news_sources=[], fundamentals_source=None,
    )
    quote_facts = [fact for fact in context.facts if fact.type == "quote"]
    assert [(fact.source, fact.value) for fact in quote_facts] == [("primary", 120), ("fallback", 121)]
    assert context.quote.adopted_source == "primary"


def test_all_market_sources_failure_creates_critical_gaps_and_no_trend():
    down = [Source("one", error=RuntimeError("down")), Source("two", error=RuntimeError("down"))]
    context = build_financial_context(
        "NVDA", NOW, quote_sources=down, history_sources=down,
        news_sources=[], fundamentals_source=None,
    )

    assert {gap.capability for gap in context.gaps} >= {"quote", "history"}
    assert context.indicators is None


def test_history_produces_deterministic_trend_indicators():
    context = build_financial_context(
        "NVDA", NOW,
        quote_sources=[Source("quote", Quote(price=31, observed_at=NOW, source_reference="q"))],
        history_sources=[Source("history", bars())], news_sources=[], fundamentals_source=None,
    )

    assert context.indicators.ma_5 == 29
    assert context.indicators.ma_20 == 21.5
    assert context.indicators.rsi_14 == 100
    assert context.indicators.max_drawdown == 0
    assert context.indicators.annualized_volatility == 1.6222
    assert context.indicators.volume_ratio_5_to_20 == 1.3659
    assert context.indicators.macd.histogram > 0


def test_news_sources_merge_validate_window_and_deduplicate():
    first = NewsItem(title="NVIDIA launches new chip", source="Yahoo", published_at=NOW,
                     fetched_at=NOW, url="https://example.com/1", summary="NVIDIA announced a chip", symbols=["NVDA"])
    duplicate = first.model_copy(update={"source": "Google", "url": "https://example.com/2"})
    wrong_symbol = first.model_copy(update={"title": "Other company", "symbols": ["AMD"]})
    context = build_financial_context(
        "NVDA", NOW,
        quote_sources=[], history_sources=[],
        news_sources=[Source("yahoo", [first]), Source("google", [duplicate, wrong_symbol])],
        fundamentals_source=None,
    )

    assert len(context.news.items) == 1
    assert context.news.items[0].title == first.title
    assert context.news.degraded is False


def test_one_news_source_failure_keeps_news_with_degradation():
    item = NewsItem(title="NVDA earnings", source="Google", published_at=NOW,
                    fetched_at=NOW, url="https://example.com", summary="NVDA reported earnings", symbols=["NVDA"])
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[],
        news_sources=[Source("yahoo", error=RuntimeError("down")), Source("google", [item])],
        fundamentals_source=None,
    )
    assert len(context.news.items) == 1
    assert context.news.degraded is True


def test_all_news_sources_failure_creates_news_gap():
    down = [Source("yahoo", error=RuntimeError("down")), Source("google", error=RuntimeError("down"))]
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[], news_sources=down, fundamentals_source=None,
    )
    assert "news" in {gap.capability for gap in context.gaps}


def test_news_material_is_bounded_for_snapshot_and_model_context():
    items = [NewsItem(
        title=f"NVDA event {index}", source="Yahoo", published_at=NOW,
        fetched_at=NOW, url=f"https://example.com/{index}", summary="NVDA event", symbols=["NVDA"],
    ) for index in range(50)]
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[],
        news_sources=[Source("yahoo", items)], fundamentals_source=None,
    )
    assert len(context.news.items) == 30


def test_disabled_valuation_source_is_an_explicit_gap():
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[], news_sources=[],
        fundamentals_source=None, valuation_source=None,
    )
    assert {gap.capability: gap.reason for gap in context.gaps}["valuation"] == "source_disabled"
