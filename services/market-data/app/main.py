from datetime import datetime, timezone
from typing import Literal, List

from fastapi import FastAPI
from pydantic import BaseModel

from app.context import build_financial_context
from app.models import FinancialContext, QuoteBatch, QuoteSnapshot, SourceStatus
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


@app.post("/v1/quotes", operation_id="createQuoteBatch", response_model=QuoteBatch)
def quotes(symbols: List[str]) -> QuoteBatch:
    result = []
    for symbol_input in symbols[:100]:
        symbol = symbol_input.strip().upper()
        statuses = []
        adopted = None
        for source in build_sources(source_config, "quote"):
            try:
                quote = source.fetch(symbol)
                statuses.append(SourceStatus(source=source.name, status="ok"))
                if adopted is None:
                    adopted = (source.name, quote)
            except Exception as error:
                statuses.append(SourceStatus(
                    source=source.name, status="failed", error=type(error).__name__,
                ))
        result.append(QuoteSnapshot(
            symbol=symbol,
            price=adopted[1].price if adopted else None,
            observed_at=adopted[1].observed_at if adopted else None,
            source=adopted[0] if adopted else None,
            degraded=bool(adopted and statuses[0].status != "ok"),
            sources=statuses,
        ))
    return QuoteBatch(quotes=result)
