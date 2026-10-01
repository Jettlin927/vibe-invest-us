from datetime import datetime, timezone
from urllib.error import HTTPError

from fastapi.testclient import TestClient
import pytest

from app.adapters.sources import SinaQuoteSource, TencentQuoteSource
from app.service.context import build_financial_context
from app.domain.financials import build_financials
from app.main import app
from app.domain.models import Quote


def financials(eps=-0.25, revenue_tag="Revenues"):
    periods = [
        ("2025-07-01", "2025-09-30", "CY2025Q3"),
        ("2025-10-01", "2025-12-31", "CY2025Q4"),
        ("2026-01-01", "2026-03-31", "CY2026Q1"),
        ("2026-04-01", "2026-06-30", "CY2026Q2"),
    ]
    return build_financials("NET", {
        tag: {"units": {unit: [
            {"start": start, "end": end, "frame": frame, "form": "10-Q",
             "fp": frame[-2:], "filed": "2026-08-01", "val": amount}
            for start, end, frame in periods
        ]}}
        for tag, unit, amount in [
            (revenue_tag, "USD", 25_000_000),
            ("EarningsPerShareDiluted", "USD/shares", eps),
        ]
    }, "https://data.sec.gov/api/xbrl/companyfacts/CIK0001477333.json")


def configure_sources(monkeypatch, fundamentals):
    class Market:
        name = "sina"

        def fetch(self, symbol):
            return Quote(price=100, market_cap=2_000_000_000,
                         observed_at=datetime(2026, 9, 18, 20, tzinfo=timezone.utc),
                         source_reference="https://finance.sina.com.cn/stock/usstock/quotes/NET.html")

    class Valuation:
        name = "yahoo-timeseries"

        def fetch_with_market_price(self, *args):
            raise HTTPError("https://query1.finance.yahoo.com/", 429, "Too Many Requests", {}, None)

    class Fundamentals:
        name = "sec"

        def fetch(self, symbol):
            return fundamentals

    sources = {
        "quote": [Market()], "valuation": [Valuation()], "fundamentals": [Fundamentals()],
    }
    monkeypatch.setattr("app.service.financial_data.build_sources", lambda config, capability: sources[capability])
    return sources


@pytest.mark.parametrize("eps,expected_pe", [(-0.25, None), (0.5, 50)])
def test_valuation_rate_limit_keeps_sec_backed_current_multiples(monkeypatch, eps, expected_pe):
    configure_sources(monkeypatch, financials(eps))
    response = TestClient(app, raise_server_exceptions=False).post(
        "/v1/valuation-evidence", params={"symbol": "NET"},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["currentMultiples"]["ps"] == 20
    assert result["currentMultiples"].get("pe") == expected_pe
    assert "evToRevenue" not in result["currentMultiples"]
    assert any(source["error"] == "HTTPError:429" for source in result["sources"] if source["status"] == "failed")
    assert any(fact["source"] == "sina" for fact in result["facts"])
    assert any(fact["source"] == "sec" for fact in result["facts"])
    ids = {fact["id"] for fact in result["facts"]}
    for fact in result["facts"]:
        assert set(fact["value"].get("inputFactIds", [])) <= ids
    assert not any("targetPrice" in method for method in result["methods"].values())


def test_valuation_rate_limit_without_fallback_inputs_returns_explicit_gap(monkeypatch):
    configure_sources(monkeypatch, {})
    response = TestClient(app, raise_server_exceptions=False).post(
        "/v1/valuation-evidence", params={"symbol": "NET"},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["currentMultiples"] == {}
    assert any(gap["capability"] == "valuation" for gap in result["gaps"])


def test_research_context_reuses_fundamentals_for_the_same_valuation_fallback(monkeypatch):
    sources = configure_sources(monkeypatch, financials())
    context = build_financial_context(
        "NET", datetime(2026, 9, 21, tzinfo=timezone.utc),
        quote_sources=sources["quote"], history_sources=[], news_sources=[],
        fundamentals_source=sources["fundamentals"][0], valuation_source=sources["valuation"][0],
    )
    assert context.valuation.current_multiples == {"ps": 20}
    assert not any(gap.capability == "valuation" for gap in context.gaps)
    assert any(fact.type == "valuation_multiple" for fact in context.facts)
    assert len({fact.id for fact in context.facts}) == len(context.facts)


def test_broken_ttm_evidence_cannot_create_a_current_multiple(monkeypatch):
    data = financials()
    data["reported_facts"] = []
    data["quarters"] = []
    configure_sources(monkeypatch, data)
    result = TestClient(app).post("/v1/valuation-evidence", params={"symbol": "NET"}).json()
    assert result["currentMultiples"] == {}
    assert result["methods"]["ps"]["reason"] == "missing_financial_input_evidence"


def test_including_assessed_tax_revenue_tag_supports_reported_ttm_and_ps(monkeypatch):
    data = financials(revenue_tag="RevenueFromContractWithCustomerIncludingAssessedTax")
    configure_sources(monkeypatch, data)
    result = TestClient(app).post("/v1/valuation-evidence", params={"symbol": "NET"}).json()
    assert result["currentMultiples"]["ps"] == 20
    assert data["ttm"]["values"]["revenue"]["value"] == 100_000_000


@pytest.mark.parametrize("source,separator,count,price_index,cap_index,cap", [
    (SinaQuoteSource, ",", 36, 1, 12, "2000000000"),
    (TencentQuoteSource, "~", 71, 3, 45, "20"),
])
def test_quote_normalizes_market_cap_in_usd(monkeypatch, source, separator, count, price_index, cap_index, cap):
    fields = [""] * count
    fields[price_index] = "100"
    fields[3 if separator == "," else 30] = "2026-09-18 16:00:00"
    fields[cap_index] = cap
    if separator == "~":
        fields[35] = "USD"
    monkeypatch.setattr("app.adapters.sources._read", lambda *args, **kwargs: ('v="' + separator.join(fields) + '"').encode())
    assert source().fetch("NET").market_cap == 2_000_000_000


@pytest.mark.parametrize("source,separator,count,price_index,close_index", [
    (SinaQuoteSource, ",", 36, 1, 26),
    (TencentQuoteSource, "~", 71, 3, 4),
])
@pytest.mark.parametrize("raw_close,expected", [("95", 95), ("", None), ("0", None), ("nan", None)])
def test_quote_preserves_previous_close_without_losing_price(monkeypatch, source, separator, count, price_index, close_index, raw_close, expected):
    fields = [""] * count
    fields[price_index] = "100"
    fields[close_index] = raw_close
    fields[3 if separator == "," else 30] = "2026-09-18 16:00:00"
    monkeypatch.setattr("app.adapters.sources._read", lambda *args, **kwargs: ('v="' + separator.join(fields) + '"').encode())
    quote = source().fetch("NET")
    assert quote.price == 100
    assert quote.previous_close == expected
