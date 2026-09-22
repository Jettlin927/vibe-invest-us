from datetime import date
from typing import Literal, List, Optional
from fastapi import FastAPI
from pydantic import BaseModel
from app.service import financial_data
from app.domain.models import AtomicFact, FactQueryResult, FilingDocumentResult, FinancialContext, FinancialOverviewResult, NewsDocumentResult, PaginatedFactResult, PriceWindowResult, QuoteBatch, QuoteSnapshot, SourceStatus, TechnicalEvidenceResult, ValuationEvidenceResult

app = FastAPI(title="vibe-invest Financial Data")

class HealthResponse(BaseModel):
    service: Literal["financial-data"]
    status: Literal["ok"]


@app.get("/health", operation_id="getHealth", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(service="financial-data", status="ok")


@app.post("/v1/financial-context", operation_id="createFinancialContext", response_model=FinancialContext)
def financial_context(symbol: str) -> FinancialContext:
    return financial_data.financial_context(symbol)

@app.post("/v1/financial-overview", operation_id="getFinancialOverview", response_model=FinancialOverviewResult)
def financial_overview(symbol: str) -> FinancialOverviewResult:
    return financial_data.financial_overview(symbol)

@app.post("/v1/financial-metric-series", operation_id="getFinancialMetricSeries", response_model=PaginatedFactResult)
def financial_metric_series_endpoint(symbol: str, metric: str, cursor: Optional[str] = None) -> PaginatedFactResult:
    return financial_data.financial_metric_series_endpoint(symbol, metric, cursor)

@app.post(
    "/v1/valuation-evidence", operation_id="getValuationEvidence",
    response_model=ValuationEvidenceResult, response_model_exclude_none=True,
)
def valuation_evidence_endpoint(symbol: str) -> ValuationEvidenceResult:
    return financial_data.valuation_evidence_endpoint(symbol)

@app.post("/v1/filing-document", operation_id="readFilingDocument", response_model=FilingDocumentResult)
def filing_document(symbol: str, filing_id: str, cursor: Optional[str] = None) -> FilingDocumentResult:
    return financial_data.filing_document(symbol, filing_id, cursor)

@app.post("/v1/news-search", operation_id="searchNews", response_model=FactQueryResult)
def news_search(keyword: str) -> FactQueryResult:
    return financial_data.news_search(keyword)

class NewsDocumentRequest(BaseModel):
    candidate: AtomicFact


@app.post("/v1/news-document", operation_id="readNewsDocument", response_model=NewsDocumentResult)
def news_document(request: NewsDocumentRequest) -> NewsDocumentResult:
    return financial_data.news_document(request.candidate)

@app.post("/v1/web-search", operation_id="searchWebEvidence", response_model=FactQueryResult)
def web_search(query: str) -> FactQueryResult:
    return financial_data.web_search(query)

@app.post("/v1/company-events", operation_id="listCompanyEvents", response_model=FactQueryResult)
def company_events(symbol: str) -> FactQueryResult:
    return financial_data.company_events(symbol)

@app.post("/v1/official-company-events", operation_id="listOfficialCompanyEvents", response_model=FactQueryResult)
def official_company_events(symbol: str) -> FactQueryResult:
    return financial_data.official_company_events(symbol)

@app.post("/v1/technical-indicators", operation_id="getTechnicalIndicators", response_model=FactQueryResult)
def technical_indicators(
    symbol: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> FactQueryResult:
    return financial_data.technical_indicators(symbol, start_date, end_date)

@app.post("/v1/technical-evidence", operation_id="getTechnicalEvidence", response_model=TechnicalEvidenceResult)
def technical_evidence(
    symbol: str, start_date: Optional[date] = None, end_date: Optional[date] = None,
) -> TechnicalEvidenceResult:
    return financial_data.technical_evidence(symbol, start_date, end_date)

@app.post("/v1/price-window", operation_id="getPriceWindow", response_model=PriceWindowResult)
def price_window(
    symbol: str, start_date: date, end_date: date,
    cursor: Optional[str] = None, page_size: int = 60,
) -> PriceWindowResult:
    return financial_data.price_window(symbol, start_date, end_date, cursor, page_size)

@app.post("/v1/quotes", operation_id="createQuoteBatch", response_model=QuoteBatch)
def quotes(symbols: List[str]) -> QuoteBatch:
    return financial_data.quotes(symbols)
