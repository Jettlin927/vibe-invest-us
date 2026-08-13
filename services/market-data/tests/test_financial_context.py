from datetime import datetime, timezone

from app.context import (
    build_financial_context, company_event_facts, read_news_document_fact, search_news_facts,
    official_company_event_facts, technical_indicator_facts, web_search_lead_facts,
)
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
    assert context.news.sources[0].error == "down"
    assert context.news.sources[1].item_count == 1


def test_all_news_sources_failure_creates_news_gap():
    down = [Source("yahoo", error=RuntimeError("down")), Source("google", error=RuntimeError("down"))]
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[], news_sources=down, fundamentals_source=None,
    )
    assert "news" in {gap.capability for gap in context.gaps}


def test_keyword_news_query_returns_traceable_facts_without_symbol_filter():
    item = NewsItem(title="NAND pricing improves", source="Google", published_at=NOW,
                    fetched_at=NOW, url="https://example.com/nand", summary="Memory prices rose", symbols=[])
    facts, sources = search_news_facts("NAND pricing", NOW, [Source("google", [item])])

    assert len(facts) == 1
    assert facts[0].value["keyword"] == "NAND pricing"
    assert facts[0].sourceReference == item.url
    assert facts[0].evidenceLevel == "title_only"
    assert sources[0].status == "ok"


def test_official_company_events_are_qualified_and_do_not_use_news_titles():
    facts, sources = official_company_event_facts("NVDA", NOW, Source("sec", [{
        "filingId": "0001045810-26-000123", "form": "10-Q", "filedAt": "2026-07-31",
        "eventType": "earnings", "sourceReference": "https://www.sec.gov/Archives/event.htm",
    }]))

    assert len(facts) == 1
    assert facts[0].type == "company_event"
    assert facts[0].evidenceLevel == "official_company_event"
    assert facts[0].sourceReference == "https://www.sec.gov/Archives/event.htm"
    assert facts[0].value == {
        "symbol": "NVDA", "filingId": "0001045810-26-000123", "form": "10-Q",
        "filedAt": "2026-07-31", "eventType": "earnings",
    }
    assert sources[0].status == "ok"


def test_three_news_sources_must_all_fail_qualification_before_web_search_eligibility():
    irrelevant = NewsItem(title="Unrelated macro update", source="Yahoo", published_at=NOW,
                          fetched_at=NOW, url="https://example.com/macro", summary="Rates", symbols=[])
    title_only = NewsItem(title="NVDA event", source="Google", published_at=NOW,
                          fetched_at=NOW, url="https://example.com/nvda", summary="Event", symbols=[])
    facts, sources, eligibility = search_news_facts(
        "  NVDA   event ", NOW, [
            Source("yahoo", [irrelevant]), Source("google-news", [title_only]),
            Source("alpaca", error=RuntimeError("down")),
        ], include_eligibility=True,
    )
    assert eligibility == {
        "eligible": True, "normalizedQuery": "NVDA event", "reasons": [
            {"source": "yahoo", "reason": "irrelevant"},
            {"source": "google-news", "reason": "title_only"},
            {"source": "alpaca", "reason": "unavailable"},
        ],
    }
    assert "NVDA event" in [fact.value["title"] for fact in facts]
    assert len(sources) == 3


def test_any_qualified_regular_news_revokes_web_search_eligibility():
    qualified = NewsItem(title="NVDA event details", source="IR", published_at=NOW,
                         fetched_at=NOW, url="https://example.com/ir", summary="NVDA event details", symbols=[])
    facts, _sources, eligibility = search_news_facts(
        "NVDA event", NOW, [Source("yahoo", []), Source("google-news", [qualified]), Source("alpaca", [])],
        include_eligibility=True, qualified_urls={qualified.url},
    )
    assert len(facts) == 1
    assert eligibility["eligible"] is False
    assert eligibility["reasons"][1] == {"source": "google-news", "reason": "qualified"}


def test_web_search_results_are_leads_until_document_read_verifies_them():
    leads = web_search_lead_facts("NVDA event", NOW, lambda query: [{
        "title": "NVDA event details", "summary": "Search snippet",
        "url": "https://example.com/event",
    }])
    assert len(leads) == 1
    assert leads[0].type == "web_search_lead"
    assert leads[0].evidenceLevel == "lead"
    verified = read_news_document_fact(leads[0], NOW, lambda url, max_bytes: (
        b"<p>Verified event details</p>", "text/html", False, url,
    ))
    assert verified.evidenceLevel == "verified_news"
    assert verified.value["candidateFactId"] == leads[0].id


def test_web_search_leads_reject_non_http_results_and_oversized_query():
    leads = web_search_lead_facts("NVDA", NOW, lambda query: [
        {"title": "unsafe", "summary": "unsafe", "url": "file:///etc/passwd"},
        {"title": "safe", "summary": "safe", "url": "https://example.com/news"},
    ])
    assert [fact.value["title"] for fact in leads] == ["safe"]
    try:
        web_search_lead_facts("x" * 501, NOW, lambda query: [])
    except ValueError as error:
        assert str(error) == "web_search_query_invalid"
    else:
        raise AssertionError("oversized_query_accepted")


def test_news_document_read_preserves_bounded_excerpt_summary_hash_and_metadata():
    candidate = search_news_facts("NAND pricing", NOW, [Source("google", [NewsItem(
        title="NAND pricing improves", source="Google", published_at=NOW,
        fetched_at=NOW, url="https://example.com/nand", summary="Candidate summary", symbols=[],
    )])])[0][0]
    html = ("<html><body><h1>NAND pricing improves</h1><p>Verified detail "
            + "x" * 2000 + "</p></body></html>").encode()

    fact = read_news_document_fact(candidate, NOW, lambda url, max_bytes: (
        html[:max_bytes], "text/html", False, "https://example.com/nand",
    ), max_bytes=512)

    assert fact.type == "news_document"
    assert fact.evidenceLevel == "verified_news"
    assert fact.value["candidateFactId"] == candidate.id
    assert fact.value["url"] == "https://example.com/nand"
    assert 0 < len(fact.value["summary"].encode()) <= 500
    assert "excerpt" not in fact.value
    assert len(fact.value["contentHash"]) == 64
    assert fact.value["metadata"] == {
        "contentType": "text/html", "excerptBytes": len(fact.value["summary"].encode()),
        "truncated": False,
    }


def test_company_events_are_distinct_title_only_candidates_with_source_status():
    item = NewsItem(title="NVDA schedules product event", source="IR", published_at=NOW,
                    fetched_at=NOW, url="https://example.com/event", summary="Event scheduled", symbols=["NVDA"])
    facts, sources = company_event_facts("NVDA", NOW, [Source("ir-news", [item])])

    assert len(facts) == 1
    assert facts[0].type == "company_event"
    assert facts[0].evidenceLevel == "title_only"
    assert facts[0].value == {
        "symbol": "NVDA", "title": item.title, "summary": item.summary, "url": item.url,
    }
    assert sources[0].status == "ok"


def test_financial_metric_series_pages_normalized_periods_without_xbrl_fields():
    from app.context import financial_metric_series
    normalized = {
        "derived_metrics": [
            {"fact_id": f"fact:revenue:{index}", "metric": "revenue_yoy", "scope": "quarter",
             "period": f"202{index}-Q1", "value": index / 10, "input_fact_ids": [f"input:{index}"]}
            for index in range(5)
        ],
        "sourceReference": "https://www.sec.gov/Archives/example",
    }

    result = financial_metric_series("NVDA", "revenue_yoy", "2", normalized, NOW, page_size=2)

    assert result.returnedCount == 2
    assert result.totalCount == 5
    assert result.nextCursor == "4"
    assert result.truncated is True
    assert [fact.value["period"] for fact in result.facts] == ["2022-Q1", "2023-Q1"]
    assert all(field not in result.model_dump_json() for field in ["concept", "unit", "form", "frame"])


def test_filing_document_pages_official_sections_without_retaining_full_text():
    from app.context import filing_document_page
    filing = {
        "filingId": "0001045810-26-000123", "form": "10-Q", "filedAt": "2026-07-31",
        "sourceReference": "https://www.sec.gov/Archives/edgar/data/example.htm",
        "sections": [
            {"name": "results", "summary": "Revenue increased."},
            {"name": "guidance", "summary": "Management raised guidance."},
            {"name": "capital", "summary": "Repurchases continued."},
        ],
    }

    result = filing_document_page("NVDA", filing["filingId"], "1", filing, NOW, page_size=1)

    assert result.returnedCount == 1
    assert result.totalCount == 3
    assert result.nextCursor == "2"
    assert result.truncated is True
    assert result.items == [{"name": "guidance", "summary": "Management raised guidance."}]
    assert result.facts[0].evidenceLevel == "official_filing"
    assert "fullText" not in result.model_dump_json()


def test_technical_query_filters_requested_range_and_returns_indicator_fact():
    class RangeSource(Source):
        def fetch_range(self, _symbol, start_date, end_date):
            assert (start_date, end_date) == ("2026-07-01", "2026-07-30")
            return bars()

    facts, sources = technical_indicator_facts(
        "nvda", "2026-07-01", "2026-07-30", NOW, [RangeSource("history")],
    )

    assert len(facts) == 1
    assert facts[0].value["barCount"] == 30
    assert facts[0].value["startDate"] == "2026-07-01"
    assert facts[0].value["ma_20"] == 21.5
    assert sources[0].status == "ok"


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


def test_financial_context_preserves_reported_and_derived_evidence_chain():
    fundamentals = {
        "sourceReference": "https://sec.example/NVDA",
        "reported_facts": [{
            "fact_id": "fact:NVDA:reported:quarter:CY2026Q1:revenue",
            "metric": "revenue", "scope": "quarter", "period": "CY2026Q1", "value": 125,
            "observed_at": "2026-03-31", "filed_at": "2026-05-01",
        }],
        "quarters": [], "annuals": [], "ttm": {"status": "unavailable", "values": {}},
        "derived_metrics": [{
            "fact_id": "fact:NVDA:derived:quarter:CY2026Q1:revenue_yoy",
            "metric": "revenue_yoy", "scope": "quarter", "period": "CY2026Q1", "value": 0.25,
            "input_fact_ids": ["fact:NVDA:reported:quarter:CY2026Q1:revenue"],
        }],
        "quality_flags": [{
            "fact_id": "fact:NVDA:derived:quality:CY2026Q1:receivables_outpace_revenue",
            "flag_type": "receivables_outpace_revenue", "severity": "warning", "period": "CY2026Q1",
            "evidence_fact_ids": ["fact:NVDA:reported:quarter:CY2026Q1:revenue"],
        }],
    }
    context = build_financial_context(
        "NVDA", NOW, quote_sources=[], history_sources=[], news_sources=[],
        fundamentals_source=Source("sec", fundamentals), valuation_source=None,
    )

    facts = {fact.id: fact for fact in context.facts}
    assert facts["fact:NVDA:reported:quarter:CY2026Q1:revenue"].value["classification"] == "reported"
    derived = facts["fact:NVDA:derived:quarter:CY2026Q1:revenue_yoy"]
    assert derived.value["inputFactIds"] == ["fact:NVDA:reported:quarter:CY2026Q1:revenue"]
    flag = facts["fact:NVDA:derived:quality:CY2026Q1:receivables_outpace_revenue"]
    assert flag.value["evidenceFactIds"] == ["fact:NVDA:reported:quarter:CY2026Q1:revenue"]


def test_valuation_receives_adopted_quote_price_and_timestamp():
    captured = {}

    class ValuationSource:
        name = "valuation"

        def fetch_with_market_price(self, symbol, price, observed_at):
            captured.update(symbol=symbol, price=price, observed_at=observed_at)
            return type("Valuation", (), {
                "model_dump": lambda self: {"current_multiples": {"pe": 30}},
                "as_of": observed_at, "source": "valuation",
            })()

    context = build_financial_context(
        "NVDA", NOW,
        quote_sources=[Source("quote", Quote(price=150, observed_at=NOW, source_reference="quote://NVDA"))],
        history_sources=[], news_sources=[], fundamentals_source=None, valuation_source=ValuationSource(),
    )

    assert captured == {"symbol": "NVDA", "price": 150, "observed_at": NOW.isoformat()}
    assert context.valuation.model_dump()["current_multiples"] == {"pe": 30}
