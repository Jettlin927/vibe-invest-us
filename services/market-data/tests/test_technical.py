from datetime import datetime, timedelta, timezone

from app.context import price_window_result, technical_evidence_result
from app.models import DailyBar


def bars(count: int):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [DailyBar(
        date=(start + timedelta(days=index)).date().isoformat(),
        open=100 + index, high=102 + index, low=99 + index,
        close=101 + index, volume=1_000 + index * 10,
    ) for index in range(count)]


class HistorySource:
    name = "test-history"

    def __init__(self, values):
        self.values = values

    def fetch_range(self, symbol, start_date, end_date):
        return [bar for bar in self.values if start_date <= bar.date <= end_date]


def test_technical_evidence_contains_actual_scope_all_windows_and_host_calculations():
    result = technical_evidence_result(
        "nvda", "2025-01-01", "2026-02-01",
        datetime(2026, 2, 2, tzinfo=timezone.utc), [HistorySource(bars(260))],
    )

    assert result.symbol == "NVDA"
    assert result.actualStart == "2025-01-01"
    assert result.actualEnd == bars(260)[-1].date
    assert result.totalBarCount == 260
    assert list(result.structures) == ["20d", "60d", "120d", "252d"]
    assert result.structures["252d"].barCount == 252
    assert result.indicators.ma_20 > 0
    assert result.volatility.annualized > 0
    assert result.drawdown.maximum <= 0
    assert result.volumePrice.volumeRatio5To20 > 0
    assert result.keyLevels.support > 0
    assert result.keyLevels.resistance >= result.keyLevels.support
    assert result.conflicts == []
    assert len(result.facts) == 1
    assert result.facts[0].evidenceLevel == "deterministic_technical"
    assert result.facts[0].value["totalBarCount"] == 260


def test_price_window_weekly_samples_long_ranges_and_pages_without_indicators():
    result = price_window_result(
        "NVDA", "2025-01-01", "2026-02-01", None, 20,
        datetime(2026, 2, 2, tzinfo=timezone.utc), [HistorySource(bars(260))],
    )

    assert result.sampling == "weekly"
    assert result.totalBarCount == 260
    assert result.returnedCount == 20
    assert result.nextCursor == "20"
    assert result.truncated is True
    assert result.actualStart == "2025-01-01"
    assert result.actualEnd == bars(260)[-1].date
    assert result.facts[0].value == {
        "date": "2025-01-05", "open": 100.0, "high": 106.0,
        "low": 99.0, "close": 105.0, "volume": 5100.0,
    }
    complete = price_window_result(
        "NVDA", "2025-01-01", "2026-02-01", None, 100,
        datetime(2026, 2, 2, tzinfo=timezone.utc), [HistorySource(bars(260))],
    )
    assert complete.facts[-1].observedAt == bars(260)[-1].date
    assert all(fact.type == "price_window_bar" for fact in result.facts)
    assert "indicators" not in str(result.model_dump())


def test_technical_evidence_with_short_history_reports_missing_windows_not_fake_values():
    result = technical_evidence_result(
        "NVDA", "2025-01-01", "2025-02-10",
        datetime(2025, 2, 11, tzinfo=timezone.utc), [HistorySource(bars(30))],
    )

    assert result.totalBarCount == 30
    assert result.structures["20d"].status == "available"
    assert result.structures["60d"].status == "unavailable"
    assert result.structures["60d"].reason == "insufficient_history"
    assert "returnPct" not in result.structures["60d"].model_dump(exclude_none=True)


def test_price_window_rejects_invalid_cursor_and_page_size():
    source = [HistorySource(bars(30))]
    now = datetime(2025, 2, 11, tzinfo=timezone.utc)
    for cursor, page_size, expected in [
        ("bad", 20, "price_window_cursor_invalid"),
        ("-1", 20, "price_window_cursor_invalid"),
        (None, 101, "price_window_page_size_invalid"),
    ]:
        try:
            price_window_result(
                "NVDA", "2025-01-01", "2025-02-10", cursor, page_size, now, source,
            )
        except ValueError as error:
            assert str(error) == expected
        else:
            raise AssertionError(f"invalid_window_accepted:{cursor}:{page_size}")
