from datetime import date, datetime, timedelta, timezone
from typing import Literal, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from app.adapters import SecFilingSource, html_to_text, read_limited_document, search_web
from app.context import (
    build_financial_context, company_event_facts, read_news_document_fact,
    filing_document_page, financial_metric_series_result, financial_overview_facts, search_news_facts,
    official_company_event_facts, price_window_result, technical_evidence_result,
    technical_indicator_facts, web_search_lead_facts, valuation_evidence_result,
    _first_available,
)
from app.models import AtomicFact, FactQueryResult, FilingDocumentResult, FinancialContext, FinancialOverviewResult, NewsDocumentResult, PaginatedFactResult, PriceWindowResult, QuoteBatch, QuoteSnapshot, SourceStatus, TechnicalEvidenceResult, ValuationEvidenceResult
from app.source_config import build_sources, load_source_config


class HealthResponse(BaseModel):
    service: Literal["financial-data"]
    status: Literal["ok"]


app = FastAPI(title="vibe-invest Financial Data")
source_config = load_source_config()


@app.get("/health", operation_id="getHealth", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(service="financial-data", status="ok")


@app.post("/v1/financial-context", operation_id="createFinancialContext", response_model=FinancialContext)
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


@app.post("/v1/financial-overview", operation_id="getFinancialOverview", response_model=FinancialOverviewResult)
def financial_overview(symbol: str) -> FinancialOverviewResult:
    overview, facts, sources = financial_overview_facts(
        symbol.strip().upper(), datetime.now(timezone.utc),
        next(iter(build_sources(source_config, "fundamentals")), None),
    )
    return FinancialOverviewResult(overview=overview, facts=facts, sources=sources)


@app.post("/v1/financial-metric-series", operation_id="getFinancialMetricSeries", response_model=PaginatedFactResult)
def financial_metric_series_endpoint(symbol: str, metric: str, cursor: Optional[str] = None) -> PaginatedFactResult:
    return financial_metric_series_result(
        symbol.strip().upper(), metric, cursor,
        next(iter(build_sources(source_config, "fundamentals")), None), datetime.now(timezone.utc),
    )


@app.post(
    "/v1/valuation-evidence", operation_id="getValuationEvidence",
    response_model=ValuationEvidenceResult, response_model_exclude_none=True,
)
def valuation_evidence_endpoint(symbol: str) -> ValuationEvidenceResult:
    return valuation_evidence_result(
        symbol, datetime.now(timezone.utc), build_sources(source_config, "quote"),
        next(iter(build_sources(source_config, "valuation")), None),
    )


@app.post("/v1/filing-document", operation_id="readFilingDocument", response_model=FilingDocumentResult)
def filing_document(symbol: str, filing_id: str, cursor: Optional[str] = None) -> FilingDocumentResult:
    normalized_symbol = symbol.strip().upper()
    source = SecFilingSource(timeout=10)
    filing = source.fetch_page(source.fetch(normalized_symbol, filing_id), cursor)
    return filing_document_page(
        normalized_symbol, filing_id, cursor, filing, datetime.now(timezone.utc),
    )


@app.post("/v1/news-search", operation_id="searchNews", response_model=FactQueryResult)
def news_search(keyword: str) -> FactQueryResult:
    facts, sources, eligibility = search_news_facts(
        keyword, datetime.now(timezone.utc), build_sources(source_config, "news"),
        include_eligibility=True,
    )
    return FactQueryResult(facts=facts, sources=sources, eligibility=eligibility)


class NewsDocumentRequest(BaseModel):
    candidate: AtomicFact


@app.post("/v1/news-document", operation_id="readNewsDocument", response_model=NewsDocumentResult)
def news_document(request: NewsDocumentRequest) -> NewsDocumentResult:
    candidate = request.candidate
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


@app.post("/v1/web-search", operation_id="searchWebEvidence", response_model=FactQueryResult)
def web_search(query: str) -> FactQueryResult:
    facts = web_search_lead_facts(
        query, datetime.now(timezone.utc), lambda normalized: search_web(normalized, timeout=10),
    )
    return FactQueryResult(facts=facts, sources=[SourceStatus(
        source="bing-web-search", status="ok" if facts else "empty", item_count=len(facts),
    )])


@app.post("/v1/company-events", operation_id="listCompanyEvents", response_model=FactQueryResult)
def company_events(symbol: str) -> FactQueryResult:
    facts, sources = company_event_facts(
        symbol, datetime.now(timezone.utc), build_sources(source_config, "news"),
    )
    return FactQueryResult(facts=facts, sources=sources)


@app.post("/v1/official-company-events", operation_id="listOfficialCompanyEvents", response_model=FactQueryResult)
def official_company_events(symbol: str) -> FactQueryResult:
    facts, sources = official_company_event_facts(
        symbol, datetime.now(timezone.utc), SecFilingSource(timeout=10),
    )
    return FactQueryResult(facts=facts, sources=sources)


@app.post("/v1/technical-indicators", operation_id="getTechnicalIndicators", response_model=FactQueryResult)
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


@app.post("/v1/technical-evidence", operation_id="getTechnicalEvidence", response_model=TechnicalEvidenceResult)
def technical_evidence(
    symbol: str, start_date: Optional[date] = None, end_date: Optional[date] = None,
) -> TechnicalEvidenceResult:
    end = end_date or datetime.now(timezone.utc).date()
    start = start_date or end - timedelta(days=550)
    return technical_evidence_result(
        symbol, start.isoformat(), end.isoformat(), datetime.now(timezone.utc),
        build_sources(source_config, "history"),
    )


@app.post("/v1/price-window", operation_id="getPriceWindow", response_model=PriceWindowResult)
def price_window(
    symbol: str, start_date: date, end_date: date,
    cursor: Optional[str] = None, page_size: int = 60,
) -> PriceWindowResult:
    return price_window_result(
        symbol, start_date.isoformat(), end_date.isoformat(), cursor, page_size,
        datetime.now(timezone.utc), build_sources(source_config, "history"),
    )


@app.post("/v1/quotes", operation_id="createQuoteBatch", response_model=QuoteBatch)
def quotes(symbols: List[str]) -> QuoteBatch:
    result = []
    for symbol_input in symbols[:100]:
        symbol = symbol_input.strip().upper()
        outcome = _first_available(build_sources(source_config, "quote"), symbol)
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
