from datetime import date, datetime, timedelta, timezone
from typing import Literal, List, Optional
from app.adapters.sources import SecFilingSource, html_to_text, read_limited_document, search_web
from app.service.context import (
    build_financial_context, company_event_facts, read_news_document_fact,
    filing_document_page, financial_metric_series_result, financial_overview_facts, search_news_facts,
    official_company_event_facts, price_window_result, technical_evidence_result,
    technical_indicator_facts, web_search_lead_facts, valuation_evidence_result,
    _first_available_chain,
)
from app.domain.models import AtomicFact, FactQueryResult, FilingDocumentResult, FinancialContext, FinancialOverviewResult, NewsDocumentResult, PaginatedFactResult, PriceWindowResult, QuoteBatch, QuoteSnapshot, SourceStatus, TechnicalEvidenceResult, ValuationEvidenceResult
from app.adapters.config import build_sources, load_source_config
from app.service.quote_scheduler import _FairBatchScheduler

source_config = load_source_config()

_QUOTE_BATCH_CONCURRENCY = 16

_QUOTE_ATTEMPT_TIMEOUT_SECONDS = 2.0

_quote_batch_scheduler = _FairBatchScheduler(_QUOTE_BATCH_CONCURRENCY)



def _quote_sources():
    """构造本次请求的行情源，并把单次尝试上限压到 2 秒。

    源配置里允许 8 秒超时（读大文档时合适），但行情在页面首屏路径上：一次尝试超过 2 秒
    就应该降级到下一个源，而不是把整页拖住。
    """
    sources = build_sources(source_config, "quote")
    for source in sources:
        timeout = getattr(source, "timeout", None)
        if isinstance(timeout, (int, float)) and timeout > _QUOTE_ATTEMPT_TIMEOUT_SECONDS:
            source.timeout = _QUOTE_ATTEMPT_TIMEOUT_SECONDS
    return sources


def financial_context(symbol: str) -> FinancialContext:
    return build_financial_context(
        symbol=symbol,
        now=datetime.now(timezone.utc),
        quote_sources=build_sources(source_config, "quote"),
        history_sources=build_sources(source_config, "history"),
        news_sources=build_sources(source_config, "news"),
        fundamentals_source=next(iter(build_sources(source_config, "fundamentals")), None),
        valuation_source=next(iter(build_sources(source_config, "valuation")), None),
    )


def financial_overview(symbol: str) -> FinancialOverviewResult:
    overview, facts, sources = financial_overview_facts(
        symbol.strip().upper(), datetime.now(timezone.utc),
        next(iter(build_sources(source_config, "fundamentals")), None),
    )
    return FinancialOverviewResult(overview=overview, facts=facts, sources=sources)


def financial_metric_series_endpoint(symbol: str, metric: str, cursor: Optional[str] = None) -> PaginatedFactResult:
    return financial_metric_series_result(
        symbol.strip().upper(), metric, cursor,
        next(iter(build_sources(source_config, "fundamentals")), None), datetime.now(timezone.utc),
    )


def valuation_evidence_endpoint(symbol: str) -> ValuationEvidenceResult:
    return valuation_evidence_result(
        symbol, datetime.now(timezone.utc), build_sources(source_config, "quote"),
        next(iter(build_sources(source_config, "valuation")), None),
        next(iter(build_sources(source_config, "fundamentals")), None),
    )


def filing_document(symbol: str, filing_id: str, cursor: Optional[str] = None) -> FilingDocumentResult:
    normalized_symbol = symbol.strip().upper()
    source = SecFilingSource(timeout=10)
    filing = source.fetch_page(source.fetch(normalized_symbol, filing_id), cursor)
    return filing_document_page(
        normalized_symbol, filing_id, cursor, filing, datetime.now(timezone.utc),
    )


def news_search(keyword: str) -> FactQueryResult:
    facts, sources, eligibility = search_news_facts(
        keyword, datetime.now(timezone.utc), build_sources(source_config, "news"),
        include_eligibility=True,
    )
    return FactQueryResult(facts=facts, sources=sources, eligibility=eligibility)


def news_document(candidate: AtomicFact) -> NewsDocumentResult:
    valid_candidate = (candidate.type == "news" and candidate.evidenceLevel == "title_only") \
        or (candidate.type == "web_search_lead" and candidate.evidenceLevel == "lead")
    if not valid_candidate:
        raise ValueError("news_candidate_invalid")

    def reader(url: str, max_bytes: int):
        return read_limited_document(url, max_bytes, timeout=10)

    payload, _content_type, _truncated, _final_url = reader(candidate.sourceReference, 65536)
    text = html_to_text(payload)
    fact = read_news_document_fact(
        candidate, datetime.now(timezone.utc),
        lambda _url, _max_bytes: (payload, _content_type, _truncated, _final_url),
    )
    return NewsDocumentResult(facts=[fact], excerpt=text[:2048], sources=[SourceStatus(
        source=candidate.source, status="ok", item_count=1,
    )])


def web_search(query: str) -> FactQueryResult:
    facts = web_search_lead_facts(
        query, datetime.now(timezone.utc), lambda normalized: search_web(normalized, timeout=10),
    )
    return FactQueryResult(facts=facts, sources=[SourceStatus(
        source="bing-web-search", status="ok" if facts else "empty", item_count=len(facts),
    )])


def company_events(symbol: str) -> FactQueryResult:
    facts, sources = company_event_facts(
        symbol, datetime.now(timezone.utc), build_sources(source_config, "news"),
    )
    return FactQueryResult(facts=facts, sources=sources)


def official_company_events(symbol: str) -> FactQueryResult:
    facts, sources = official_company_event_facts(
        symbol, datetime.now(timezone.utc), SecFilingSource(timeout=10),
    )
    return FactQueryResult(facts=facts, sources=sources)


def technical_indicators(
    symbol: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> FactQueryResult:
    end = end_date or datetime.now(timezone.utc).date()
    start = start_date or end - timedelta(days=365)
    facts, sources = technical_indicator_facts(
        symbol, start.isoformat(), end.isoformat(), datetime.now(timezone.utc),
        build_sources(source_config, "history"),
    )
    return FactQueryResult(facts=facts, sources=sources)


def technical_evidence(
    symbol: str, start_date: Optional[date] = None, end_date: Optional[date] = None,
) -> TechnicalEvidenceResult:
    end = end_date or datetime.now(timezone.utc).date()
    start = start_date or end - timedelta(days=550)
    return technical_evidence_result(
        symbol, start.isoformat(), end.isoformat(), datetime.now(timezone.utc),
        build_sources(source_config, "history"),
    )


def price_window(
    symbol: str, start_date: date, end_date: date,
    cursor: Optional[str] = None, page_size: int = 60,
) -> PriceWindowResult:
    return price_window_result(
        symbol, start_date.isoformat(), end_date.isoformat(), cursor, page_size,
        datetime.now(timezone.utc), build_sources(source_config, "history"),
    )


def quotes(symbols: List[str]) -> QuoteBatch:
    normalized_symbols = [symbol.strip().upper() for symbol in symbols[:100]]
    if not normalized_symbols:
        return QuoteBatch(quotes=[])
    outcomes = _first_available_chain([
        (symbol, _quote_sources()) for symbol in normalized_symbols
    ], _quote_batch_scheduler)
    result = []
    for symbol, outcome in zip(normalized_symbols, outcomes):
        quote = outcome.value
        result.append(QuoteSnapshot(
            symbol=symbol,
            price=quote.price if quote else None,
            observed_at=quote.observed_at if quote else None,
            source=outcome.adopted_source,
            degraded=outcome.degraded,
            sources=outcome.sources,
        ))
    return QuoteBatch(quotes=result)
