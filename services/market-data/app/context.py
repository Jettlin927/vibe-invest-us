import json
import re
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Any, Iterable, List, Optional
from urllib.parse import urlsplit

from app.indicators import calculate_indicators
from app.models import (
    CapabilityResult,
    AtomicFact,
    DailyBar,
    DataGap,
    FinancialContext,
    NewsItem,
    Quote,
    SourceObservation,
    SourceStatus,
    PaginatedFactResult,
    FilingDocumentResult,
    ValuationEvidenceResult,
)
from app.valuation import valuation_evidence


def build_financial_context(
    symbol: str,
    now: datetime,
    quote_sources: Iterable[Any],
    history_sources: Iterable[Any],
    news_sources: Iterable[Any],
    fundamentals_source: Optional[Any],
    valuation_source: Optional[Any] = None,
) -> FinancialContext:
    normalized_symbol = symbol.upper()
    quote = _first_available(quote_sources, normalized_symbol)
    history = _first_available(history_sources, normalized_symbol)
    news = _collect_news(news_sources, normalized_symbol, now)
    fundamentals = _first_available(
        [] if fundamentals_source is None else [fundamentals_source], normalized_symbol,
    )
    valuation = None
    valuation_sources = []
    valuation_gap = DataGap(capability="valuation", reason="source_disabled") if valuation_source is None else None
    if valuation_source is not None:
        try:
            quote_value = quote.value if isinstance(quote.value, Quote) else None
            if hasattr(valuation_source, "fetch_with_market_price"):
                valuation = valuation_source.fetch_with_market_price(
                    normalized_symbol,
                    quote_value.price if quote_value else None,
                    quote_value.observed_at.isoformat() if quote_value else None,
                )
            else:
                valuation = valuation_source.fetch(normalized_symbol)
            valuation_sources.append(SourceStatus(
                source=valuation_source.name, status="ok", item_count=1,
            ))
        except Exception as error:
            valuation_gap = DataGap(capability="valuation", reason="source_unavailable")
            valuation_sources.append(SourceStatus(
                source=valuation_source.name, status="failed", error=_safe_error(error), item_count=0,
            ))
    gaps = []
    for capability, result in (("quote", quote), ("history", history), ("news", news), ("fundamentals", fundamentals)):
        if result.value is None and not result.items:
            gaps.append(DataGap(capability=capability, reason="all_sources_unavailable"))
    if valuation_gap:
        gaps.append(valuation_gap)

    history_bars = history.value
    indicators = None
    if isinstance(history_bars, list) and len(history_bars) >= 20:
        indicators = calculate_indicators([bar if isinstance(bar, DailyBar) else DailyBar(**bar) for bar in history_bars])

    facts = _atomic_facts(normalized_symbol, now, quote, history, news, fundamentals)
    if indicators is not None:
        facts.append(AtomicFact(
            id=f"fact:{normalized_symbol}:indicators:{now.isoformat()}", type="indicators",
            value=indicators.model_dump(), observedAt=history.value[-1].date,
            fetchedAt=now.isoformat(), source="deterministic-calculation",
            sourceReference="internal://indicators",
        ))
    if valuation is not None:
        facts.append(AtomicFact(
            id=f"fact:{normalized_symbol}:valuation:{now.isoformat()}", type="valuation",
            value=valuation.model_dump(), observedAt=valuation.as_of or now.isoformat(), fetchedAt=now.isoformat(),
            source=valuation.source, sourceReference="https://finance.yahoo.com/",
        ))
    return FinancialContext(
        symbol=normalized_symbol, fetched_at=now, quote=quote, history=history, news=news,
        fundamentals=fundamentals, indicators=indicators, valuation=valuation,
        valuation_sources=valuation_sources, facts=facts, gaps=gaps,
    )


def financial_overview_facts(symbol: str, now: datetime, fundamentals_source: Optional[Any]):
    normalized_symbol = symbol.strip().upper()
    result = _first_available(
        [] if fundamentals_source is None else [fundamentals_source], normalized_symbol,
    )
    facts: List[AtomicFact] = []
    if isinstance(result.value, dict):
        _append_financial_facts(facts, normalized_symbol, now, result)
    value = result.value if isinstance(result.value, dict) else {}
    periods = [*value.get("quarters", []), *value.get("annuals", [])]
    overview = {
        "symbol": normalized_symbol,
        "latestPeriod": periods[0].get("period") if periods else None,
        "qualityFlags": [
            {key: flag.get(key) for key in ("flag_type", "severity", "period")}
            for flag in value.get("quality_flags", [])
        ],
    }
    return overview, facts, result.sources


def financial_metric_series(symbol: str, metric: str, cursor: Optional[str],
                            normalized: Any, now: datetime, page_size: int = 20) -> PaginatedFactResult:
    normalized_symbol = symbol.strip().upper()
    offset = int(cursor or "0")
    if offset < 0 or page_size < 1:
        raise ValueError("financial_metric_cursor_invalid")
    records = [
        record for record in normalized.get("derived_metrics", [])
        if record.get("metric") == metric
    ] if isinstance(normalized, dict) else []
    page = records[offset:offset + page_size]
    facts = [AtomicFact(
        id=record["fact_id"], type="derived_financial_metric",
        value={
            "classification": "derived", "metric": record["metric"],
            "scope": record["scope"], "period": record["period"], "value": record["value"],
            "inputFactIds": record.get("input_fact_ids", []),
        },
        observedAt=record["period"], fetchedAt=now.isoformat(),
        source="deterministic-calculation",
        sourceReference=normalized.get("sourceReference", "https://www.sec.gov/"),
        evidenceLevel="deterministic_financial_metric",
    ) for record in page]
    next_offset = offset + len(page)
    return PaginatedFactResult(
        facts=facts, returnedCount=len(facts), totalCount=len(records),
        nextCursor=str(next_offset) if next_offset < len(records) else None,
        truncated=next_offset < len(records),
    )


def financial_metric_series_result(symbol: str, metric: str, cursor: Optional[str],
                                   fundamentals_source: Optional[Any], now: datetime) -> PaginatedFactResult:
    if fundamentals_source is None:
        raise ValueError("fundamentals_source_unavailable")
    normalized = fundamentals_source.fetch(symbol.strip().upper())
    return financial_metric_series(symbol, metric, cursor, normalized, now)


def valuation_evidence_result(symbol: str, now: datetime, quote_sources: Iterable[Any],
                              valuation_source: Optional[Any]) -> ValuationEvidenceResult:
    normalized_symbol = symbol.strip().upper()
    if valuation_source is None:
        raise ValueError("valuation_source_unavailable")
    quote = _first_available(quote_sources, normalized_symbol)
    quote_value = quote.value if isinstance(quote.value, Quote) else None
    result = valuation_source.fetch_with_market_price(
        normalized_symbol,
        quote_value.price if quote_value else None,
        quote_value.observed_at.isoformat() if quote_value else None,
    )
    snapshot_value = {
        "symbol": result.symbol, "industry": result.industry,
        "authorizedComparables": result.comparable_symbols,
        "comparables": result.comparables,
        "inputs": result.inputs,
        "currentMultiples": result.current_multiples,
        "historicalRanges": result.historical_ranges,
        "methods": {name: value.model_dump(exclude_none=True) for name, value in result.methods.items()},
        "asOf": result.as_of,
    }
    fingerprint = sha256(json.dumps(
        snapshot_value, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()[:16]
    snapshot = AtomicFact(
        id=f"fact:{normalized_symbol}:valuation-inputs:{fingerprint}",
        type="valuation_inputs", value=snapshot_value,
        observedAt=result.as_of or now.isoformat(), fetchedAt=now.isoformat(),
        source=result.source, sourceReference="https://finance.yahoo.com/",
        evidenceLevel="verified_valuation_input",
    )
    evidence = valuation_evidence(result, now, [snapshot.id])
    return ValuationEvidenceResult(
        **evidence, facts=[snapshot, *evidence["facts"]],
        sources=[SourceStatus(source=result.source, status="ok", item_count=len(evidence["facts"]))],
    )


def filing_document_page(symbol: str, filing_id: str, cursor: Optional[str],
                         filing: Any, now: datetime) -> FilingDocumentResult:
    normalized_symbol = symbol.strip().upper()
    if not isinstance(filing, dict) or filing.get("filingId") != filing_id:
        raise ValueError("filing_not_found")
    source_reference = str(filing.get("sourceReference", ""))
    if not source_reference.startswith("https://www.sec.gov/") \
            and not source_reference.startswith("https://sec.gov/"):
        raise ValueError("filing_source_not_official")
    offset = int(cursor or "0")
    if offset < 0 or filing.get("startByte") != offset:
        raise ValueError("filing_cursor_invalid")
    end_byte = int(filing.get("endByte", offset - 1))
    total_bytes = filing.get("totalBytes")
    summary = str(filing.get("summary", ""))[:500]
    content_hash = str(filing.get("contentHash", ""))
    if not summary or not re.fullmatch(r"[a-f0-9]{64}", content_hash):
        raise ValueError("filing_page_not_qualifiable")
    page = [{
        "startByte": offset, "endByte": end_byte,
        "summary": summary, "contentHash": content_hash,
    }]
    fact = AtomicFact(
        id=(f"fact:{normalized_symbol}:filing:{filing_id}:bytes:{offset}-{end_byte}:"
            f"{content_hash[:16]}"), type="filing_document",
        value={
            "symbol": normalized_symbol, "filingId": filing_id,
            "form": filing.get("form"), "filedAt": filing.get("filedAt"),
            "startByte": offset, "endByte": end_byte,
            "summary": summary, "contentHash": content_hash,
        },
        observedAt=str(filing.get("filedAt") or now.isoformat()), fetchedAt=now.isoformat(),
        source="sec", sourceReference=source_reference, evidenceLevel="official_filing",
    )
    return FilingDocumentResult(
        facts=[fact], items=page, returnedCount=max(0, end_byte - offset + 1),
        totalCount=total_bytes if isinstance(total_bytes, int) else max(0, end_byte + 1),
        nextCursor=filing.get("nextCursor"), truncated=bool(filing.get("truncated")),
    )
def search_news_facts(keyword: str, now: datetime, news_sources: Iterable[Any],
                      include_eligibility: bool = False, qualified_urls=None):
    normalized_keyword = " ".join(keyword.strip().split())
    statuses, collected, source_items = [], [], []
    for source in news_sources:
        try:
            items = source.fetch(normalized_keyword)
            statuses.append(SourceStatus(
                source=source.name, status="ok" if items else "empty", item_count=len(items or []),
            ))
            collected.extend(items or [])
            source_items.append((source.name, items or [], None))
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=_safe_error(error), item_count=0))
            source_items.append((source.name, [], "unavailable"))
    facts, seen = [], set()
    for candidate in sorted(collected, key=lambda item: item.published_at, reverse=True):
        item = candidate if isinstance(candidate, NewsItem) else NewsItem(**candidate)
        key = " ".join(item.title.lower().split())
        if key in seen:
            continue
        seen.add(key)
        facts.append(AtomicFact(
            id=f"fact:news-search:{sha256(normalized_keyword.lower().encode()).hexdigest()[:12]}:{item.published_at.isoformat()}:{sha256(item.url.encode()).hexdigest()[:16]}",
            type="news", value={"keyword": normalized_keyword, "title": item.title, "summary": item.summary, "url": item.url},
            observedAt=item.published_at.isoformat(), fetchedAt=now.isoformat(),
            source=item.source, sourceReference=item.url,
            evidenceLevel="title_only",
        ))
    if not include_eligibility:
        return facts[:30], statuses
    if len(source_items) != 3:
        eligibility = {"eligible": False, "normalizedQuery": normalized_keyword, "reasons": [
            {"source": name, "reason": error or ("empty" if not items else "title_only")}
            for name, items, error in source_items
        ]}
        return facts[:30], statuses, eligibility
    query_terms = {term.lower() for term in normalized_keyword.split() if len(term) > 1}
    qualified_urls = set(qualified_urls or [])
    reasons = []
    for name, items, error in source_items:
        if error:
            reason = error
        elif not items:
            reason = "empty"
        elif any(getattr(item, "url", None) in qualified_urls for item in items):
            reason = "qualified"
        else:
            relevant = any(query_terms & set((item.title + " " + item.summary).lower().split()) for item in items)
            reason = "title_only" if relevant else "irrelevant"
        reasons.append({"source": name, "reason": reason})
    eligibility = {
        "eligible": all(item["reason"] in {"unavailable", "empty", "irrelevant", "title_only"} for item in reasons),
        "normalizedQuery": normalized_keyword, "reasons": reasons,
    }
    return facts[:30], statuses, eligibility


def read_news_document_fact(candidate: AtomicFact, now: datetime, reader, max_bytes: int = 65536):
    read_result = reader(candidate.sourceReference, max_bytes)
    payload, content_type = read_result[:2]
    truncated = bool(read_result[2]) if len(read_result) > 2 else False
    final_url = read_result[3] if len(read_result) > 3 else candidate.sourceReference
    bounded = bytes(payload[:max_bytes])
    text = re.sub(r"<[^>]+>", " ", bounded.decode("utf-8", errors="replace"))
    excerpt = " ".join(text.split())[:max_bytes]
    return AtomicFact(
        id=f"fact:news-document:{sha256(candidate.id.encode()).hexdigest()[:16]}:{sha256(bounded).hexdigest()[:16]}",
        type="news_document",
        value={
            "candidateFactId": candidate.id,
            "url": final_url,
            "summary": excerpt[:500],
            "contentHash": sha256(bounded).hexdigest(),
            "metadata": {
                "contentType": content_type, "excerptBytes": len(excerpt.encode()),
                "truncated": truncated,
            },
        },
        observedAt=candidate.observedAt,
        fetchedAt=now.isoformat(),
        source=candidate.source,
        sourceReference=final_url,
        evidenceLevel="verified_news",
    )


def company_event_facts(symbol: str, now: datetime, news_sources: Iterable[Any]):
    normalized_symbol = symbol.strip().upper()
    news_facts, statuses = search_news_facts(normalized_symbol, now, news_sources)
    facts = [fact.model_copy(update={
        "id": fact.id.replace("fact:news-search:", "fact:company-event:"),
        "type": "company_event",
        "value": {
            "symbol": normalized_symbol,
            "title": fact.value["title"], "summary": fact.value["summary"],
            "url": fact.value["url"],
        },
    }) for fact in news_facts]
    return facts, statuses


def official_company_event_facts(symbol: str, now: datetime, source: Any):
    normalized_symbol = symbol.strip().upper()
    try:
        events = source.list_events(normalized_symbol) if hasattr(source, "list_events") \
            else source.fetch(normalized_symbol)
        facts = [AtomicFact(
            id=f"fact:{normalized_symbol}:official-event:{event['filingId']}",
            type="company_event",
            value={
                "symbol": normalized_symbol, "filingId": event["filingId"],
                "form": event["form"], "filedAt": event["filedAt"],
                "eventType": event["eventType"],
            },
            observedAt=event["filedAt"], fetchedAt=now.isoformat(), source=source.name,
            sourceReference=event["sourceReference"], evidenceLevel="official_company_event",
        ) for event in events[:20]]
        return facts, [SourceStatus(
            source=source.name, status="ok" if facts else "empty", item_count=len(facts),
        )]
    except Exception as error:
        return [], [SourceStatus(
            source=source.name, status="failed", error=_safe_error(error), item_count=0,
        )]


def web_search_lead_facts(query: str, now: datetime, searcher):
    normalized_query = " ".join(query.strip().split())
    if not normalized_query or len(normalized_query) > 500:
        raise ValueError("web_search_query_invalid")
    facts = []
    for item in searcher(normalized_query)[:10]:
        parsed = urlsplit(item["url"])
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            continue
        facts.append(AtomicFact(
            id=f"fact:web-search-lead:{sha256(normalized_query.lower().encode()).hexdigest()[:12]}:{sha256(item['url'].encode()).hexdigest()[:16]}",
            type="web_search_lead",
            value={"query": normalized_query, "title": item["title"], "summary": item["summary"], "url": item["url"]},
            observedAt=now.isoformat(), fetchedAt=now.isoformat(), source="bing-web-search",
            sourceReference=item["url"], evidenceLevel="lead",
        ))
    return facts


def technical_indicator_facts(symbol: str, start_date: str, end_date: str, now: datetime, history_sources: Iterable[Any]):
    normalized_symbol = symbol.strip().upper()
    history = _first_available_history_range(history_sources, normalized_symbol, start_date, end_date)
    bars = [
        bar if isinstance(bar, DailyBar) else DailyBar(**bar)
        for bar in (history.value or [])
        if start_date <= (bar.date if isinstance(bar, DailyBar) else bar["date"]) <= end_date
    ]
    if len(bars) < 20:
        return [], history.sources
    indicators = calculate_indicators(bars)
    fingerprint = sha256("|".join(f"{bar.date}:{bar.close}:{bar.volume}" for bar in bars).encode()).hexdigest()[:16]
    source = history.adopted_source or "unknown"
    fact = AtomicFact(
        id=f"fact:{normalized_symbol}:technical-indicators:{start_date}:{end_date}:{fingerprint}",
        type="indicators",
        value={
            **indicators.model_dump(), "symbol": normalized_symbol,
            "startDate": start_date, "endDate": end_date, "barCount": len(bars),
        },
        observedAt=bars[-1].date, fetchedAt=now.isoformat(), source="deterministic-calculation",
        sourceReference=f"source://{source}/{normalized_symbol}/history?start={start_date}&end={end_date}",
    )
    return [fact], history.sources


def _first_available_history_range(sources: Iterable[Any], symbol: str, start_date: str, end_date: str):
    statuses, observations, adopted, value = [], [], None, None
    for source in sources:
        try:
            candidate = source.fetch_range(symbol, start_date, end_date) if hasattr(source, "fetch_range") else [
                bar for bar in source.fetch(symbol)
                if start_date <= (bar.date if isinstance(bar, DailyBar) else bar["date"]) <= end_date
            ]
            if not candidate:
                statuses.append(SourceStatus(source=source.name, status="empty", item_count=0))
                continue
            statuses.append(SourceStatus(source=source.name, status="ok", item_count=len(candidate)))
            observations.append(SourceObservation(source=source.name, value=candidate))
            if adopted is None:
                adopted, value = source.name, candidate
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=_safe_error(error), item_count=0))
    return CapabilityResult(
        value=value, adopted_source=adopted, degraded=bool(adopted and statuses[0].status != "ok"),
        sources=statuses, observations=observations,
    )


def _atomic_facts(symbol, now, quote, history, news, fundamentals):
    facts = []
    for observation in quote.observations:
        value = observation.value if isinstance(observation.value, Quote) else Quote(**observation.value)
        facts.append(AtomicFact(
            id=f"fact:{symbol}:quote:{observation.source}:{value.observed_at.isoformat()}",
            type="quote", value=value.price, observedAt=value.observed_at.isoformat(),
            fetchedAt=now.isoformat(), source=observation.source,
            sourceReference=value.source_reference,
        ))
    for observation in history.observations:
        if not isinstance(observation.value, list):
            continue
        for value in observation.value:
            bar = value if isinstance(value, DailyBar) else DailyBar(**value)
            facts.append(AtomicFact(
                id=f"fact:{symbol}:daily-bar:{observation.source}:{bar.date}",
                type="daily_bar", value=bar.model_dump(), observedAt=bar.date,
                fetchedAt=now.isoformat(), source=observation.source,
                sourceReference=f"source://{observation.source}/{symbol}/history",
            ))
    for item in news.items:
        news_item = item if isinstance(item, NewsItem) else NewsItem(**item)
        facts.append(AtomicFact(
            id=f"fact:{symbol}:news:{news_item.source}:{news_item.published_at.isoformat()}:{sha256(news_item.url.encode()).hexdigest()[:16]}",
            type="news", value={"title": news_item.title, "summary": news_item.summary, "url": news_item.url},
            observedAt=news_item.published_at.isoformat(), fetchedAt=news_item.fetched_at.isoformat(),
            source=news_item.source, sourceReference=news_item.url,
        ))
    if isinstance(fundamentals.value, dict):
        _append_financial_facts(facts, symbol, now, fundamentals)
    return facts


def _append_financial_facts(facts, symbol, now, fundamentals):
    value = fundamentals.value
    source = fundamentals.adopted_source or "sec"
    source_reference = value.get("sourceReference", "https://www.sec.gov/")
    reported_fact_ids = set()
    for reported in value.get("reported_facts", []):
        facts.append(AtomicFact(
            id=reported["fact_id"], type="reported_financial",
            value={
                "classification": "reported", "metric": reported["metric"],
                "scope": reported["scope"], "period": reported["period"], "value": reported["value"],
            },
            observedAt=reported.get("observed_at") or reported["period"], fetchedAt=now.isoformat(),
            source=source, sourceReference=source_reference, evidenceLevel="reported_financial",
        ))
        reported_fact_ids.add(reported["fact_id"])
    emitted_fact_ids = set(reported_fact_ids)
    for period in [*value.get("quarters", []), *value.get("annuals", [])]:
        for metric, cell in period.get("values", {}).items():
            if cell.get("status") != "available" or not cell.get("fact_id") or cell["fact_id"] in reported_fact_ids:
                continue
            facts.append(AtomicFact(
                id=cell["fact_id"], type="derived_financial_metric",
                value={
                    "classification": "derived", "metric": metric, "period": period["period"],
                    "value": cell["value"], "inputFactIds": cell.get("input_fact_ids", []),
                },
                observedAt=cell.get("observed_at") or period.get("observed_at") or now.isoformat(),
                fetchedAt=now.isoformat(), source="deterministic-calculation", sourceReference=source_reference,
                evidenceLevel="deterministic_financial_metric",
            ))
            emitted_fact_ids.add(cell["fact_id"])
    for metric in value.get("derived_metrics", []):
        if metric["fact_id"] in emitted_fact_ids:
            continue
        facts.append(AtomicFact(
            id=metric["fact_id"], type="derived_financial_metric",
            value={
                "classification": "derived", "metric": metric["metric"], "scope": metric["scope"],
                "period": metric["period"], "value": metric["value"],
                "inputFactIds": metric["input_fact_ids"],
            },
            observedAt=metric["period"], fetchedAt=now.isoformat(), source="deterministic-calculation",
            sourceReference=source_reference, evidenceLevel="deterministic_financial_metric",
        ))
        emitted_fact_ids.add(metric["fact_id"])
    for flag in value.get("quality_flags", []):
        facts.append(AtomicFact(
            id=flag["fact_id"], type="financial_quality_flag",
            value={
                "classification": "derived", "flagType": flag["flag_type"], "severity": flag["severity"],
                "period": flag["period"], "evidenceFactIds": flag["evidence_fact_ids"],
            },
            observedAt=flag["period"], fetchedAt=now.isoformat(), source="deterministic-calculation",
            sourceReference=source_reference, evidenceLevel="deterministic_financial_metric",
        ))

    # Preserve the four original annual fact types for stored-report and UI compatibility.
    latest_annual = next(iter(value.get("annuals", [])), None)
    legacy_fields = {
        "eps_diluted": "dilutedEps", "revenue": "revenue",
        "net_income": "netIncome", "operating_cash_flow": "operatingCashFlow",
    }
    if latest_annual:
        for metric, fact_type in legacy_fields.items():
            cell = latest_annual.get("values", {}).get(metric, {})
            if cell.get("status") == "available":
                facts.append(AtomicFact(
                    id=f"fact:{symbol}:fundamental:{fact_type}:{cell.get('observed_at')}", type=fact_type,
                    value=cell["value"], observedAt=cell.get("observed_at") or latest_annual["period"],
                    fetchedAt=now.isoformat(), source=source, sourceReference=source_reference,
                ))


def _first_available(sources: Iterable[Any], symbol: str) -> CapabilityResult:
    statuses: List[SourceStatus] = []
    observations: List[SourceObservation] = []
    adopted = None
    value = None
    for source in sources:
        try:
            candidate = source.fetch(symbol)
            if candidate is None or candidate == [] or candidate == {}:
                statuses.append(SourceStatus(source=source.name, status="empty", item_count=0))
                continue
            statuses.append(SourceStatus(source=source.name, status="ok", item_count=_item_count(candidate)))
            observations.append(SourceObservation(source=source.name, value=candidate))
            if adopted is None:
                adopted, value = source.name, candidate
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=_safe_error(error), item_count=0))
    return CapabilityResult(
        value=value,
        adopted_source=adopted,
        degraded=bool(adopted and statuses[0].status != "ok"),
        sources=statuses,
        observations=observations,
    )


def _collect_news(sources: Iterable[Any], symbol: str, now: datetime) -> CapabilityResult:
    statuses, collected = [], []
    for source in sources:
        try:
            items = source.fetch(symbol)
            statuses.append(SourceStatus(
                source=source.name, status="ok" if items else "empty", item_count=len(items or []),
            ))
            collected.extend(items or [])
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=_safe_error(error), item_count=0))

    accepted, seen = [], set()
    for candidate in collected:
        item = candidate if isinstance(candidate, NewsItem) else NewsItem(**candidate)
        key = " ".join(item.title.lower().split())
        if symbol not in [value.upper() for value in item.symbols]:
            continue
        if not now - timedelta(days=30) <= item.published_at <= now + timedelta(minutes=5):
            continue
        if key in seen:
            continue
        seen.add(key)
        accepted.append(item)

    successful = [status for status in statuses if status.status == "ok"]
    accepted.sort(key=lambda item: item.published_at, reverse=True)
    return CapabilityResult(
        items=accepted[:30],
        adopted_source="multiple" if len(successful) > 1 else successful[0].source if successful else None,
        degraded=bool(statuses and any(status.status != "ok" for status in statuses)),
        sources=statuses,
    )


def _item_count(value: Any) -> int:
    return len(value) if isinstance(value, list) else 1


def _safe_error(error: Exception) -> str:
    message = str(error)
    if message and re.match(r"^[A-Za-z0-9_.:-]+$", message):
        return message[:120]
    if hasattr(error, "code"):
        return f"{type(error).__name__}:{getattr(error, 'code')}"
    return type(error).__name__
