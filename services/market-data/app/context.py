from datetime import datetime, timedelta
from hashlib import sha256
from typing import Any, Iterable, List, Optional

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
)


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
    valuation_gap = DataGap(capability="valuation", reason="source_disabled") if valuation_source is None else None
    if valuation_source is not None:
        try:
            valuation = valuation_source.fetch(normalized_symbol)
        except Exception:
            valuation_gap = DataGap(capability="valuation", reason="source_unavailable")
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
        symbol=normalized_symbol,
        fetched_at=now,
        quote=quote,
        history=history,
        news=news,
        fundamentals=fundamentals,
        indicators=indicators,
        valuation=valuation,
        facts=facts,
        gaps=gaps,
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
        for field in ("dilutedEps", "revenue", "netIncome", "operatingCashFlow"):
            value = fundamentals.value.get(field)
            if value:
                facts.append(AtomicFact(
                    id=f"fact:{symbol}:fundamental:{field}:{value['observedAt']}", type=field,
                    value=value["value"], observedAt=value["observedAt"], fetchedAt=now.isoformat(),
                    source=fundamentals.adopted_source,
                    sourceReference=fundamentals.value["sourceReference"],
                ))
    return facts


def _first_available(sources: Iterable[Any], symbol: str) -> CapabilityResult:
    statuses: List[SourceStatus] = []
    observations: List[SourceObservation] = []
    adopted = None
    value = None
    for source in sources:
        try:
            candidate = source.fetch(symbol)
            if candidate is None or candidate == [] or candidate == {}:
                statuses.append(SourceStatus(source=source.name, status="empty"))
                continue
            statuses.append(SourceStatus(source=source.name, status="ok"))
            observations.append(SourceObservation(source=source.name, value=candidate))
            if adopted is None:
                adopted, value = source.name, candidate
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=type(error).__name__))
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
            statuses.append(SourceStatus(source=source.name, status="ok" if items else "empty"))
            collected.extend(items or [])
        except Exception as error:
            statuses.append(SourceStatus(source=source.name, status="failed", error=type(error).__name__))

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
