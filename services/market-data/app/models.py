from datetime import datetime
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field


class Quote(BaseModel):
    price: float
    observed_at: datetime
    source_reference: str


class DailyBar(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class NewsItem(BaseModel):
    title: str
    source: str
    published_at: datetime
    fetched_at: datetime
    url: str
    summary: str
    symbols: List[str]


class SourceStatus(BaseModel):
    source: str
    status: Literal["ok", "failed", "empty"]
    error: Optional[str] = None
    item_count: Optional[int] = None


class SourceObservation(BaseModel):
    source: str
    value: Any


class CapabilityResult(BaseModel):
    value: Optional[Any] = None
    items: List[Any] = []
    adopted_source: Optional[str] = None
    degraded: bool = False
    sources: List[SourceStatus]
    observations: List[SourceObservation] = []


class DataGap(BaseModel):
    capability: str
    reason: str


class Macd(BaseModel):
    line: float
    signal: float
    histogram: float


class Indicators(BaseModel):
    ma_5: float
    ma_20: float
    macd: Macd
    rsi_14: float
    annualized_volatility: float
    max_drawdown: float
    volume_ratio_5_to_20: float


class AtomicFact(BaseModel):
    id: str
    type: str
    value: Any
    observedAt: str
    fetchedAt: str
    source: str
    sourceReference: str
    evidenceLevel: Optional[str] = None


class FactQueryResult(BaseModel):
    facts: List[AtomicFact]
    sources: List[SourceStatus] = []
    eligibility: Optional[Any] = None


class FinancialOverviewResult(FactQueryResult):
    overview: Any


class PaginatedFactResult(FactQueryResult):
    returnedCount: int
    totalCount: int
    nextCursor: Optional[str] = None
    truncated: bool


class FilingDocumentResult(PaginatedFactResult):
    items: List[Any]


class TechnicalWindowStructure(BaseModel):
    status: Literal["available", "unavailable"]
    barCount: int
    reason: Optional[str] = None
    returnPct: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None


class TechnicalVolatility(BaseModel):
    annualized: float


class TechnicalDrawdown(BaseModel):
    maximum: float


class TechnicalVolumePrice(BaseModel):
    volumeRatio5To20: float


class TechnicalKeyLevels(BaseModel):
    support: float
    resistance: float


class TechnicalEvidenceResult(FactQueryResult):
    symbol: str
    actualStart: str
    actualEnd: str
    totalBarCount: int
    structures: dict[str, TechnicalWindowStructure]
    indicators: Indicators
    volatility: TechnicalVolatility
    drawdown: TechnicalDrawdown
    volumePrice: TechnicalVolumePrice
    keyLevels: TechnicalKeyLevels
    conflicts: List[str]


class PriceWindowResult(PaginatedFactResult):
    symbol: str
    actualStart: str
    actualEnd: str
    totalBarCount: int
    sampling: Literal["daily", "weekly"]


class ValuationComparable(BaseModel):
    symbol: str
    pe: Optional[float] = None
    evToEbitda: Optional[float] = None
    evToRevenue: Optional[float] = None


class ValuationMethodView(BaseModel):
    status: Literal["available", "unavailable"]
    reason: Optional[str] = None
    anchor: Optional[str] = None
    multiple: Optional[float] = None
    targetPrice: Optional[float] = None
    range: Optional[dict[str, float]] = None
    multiplePercentile: Optional[float] = None


class ValuationExcludedComparable(BaseModel):
    symbol: Optional[str] = None
    method: str
    value: float
    reason: str


class ValuationEvidenceResult(BaseModel):
    symbol: str
    authorizedComparables: List[str]
    comparables: List[ValuationComparable]
    excludedComparables: List[ValuationExcludedComparable] = []
    currentMultiples: dict[str, float]
    historicalRanges: dict[str, List[float]]
    methods: dict[str, ValuationMethodView]
    facts: List[AtomicFact]
    sources: List[SourceStatus] = []

    model_config = {"exclude_none": True}


class NewsDocumentResult(FactQueryResult):
    excerpt: str


class FinancialContext(BaseModel):
    symbol: str
    fetched_at: datetime
    quote: CapabilityResult
    history: CapabilityResult
    news: CapabilityResult
    fundamentals: CapabilityResult
    indicators: Optional[Indicators]
    valuation: Optional[Any] = None
    valuation_sources: List[SourceStatus] = []
    facts: List[AtomicFact]
    gaps: List[DataGap]


class QuoteSnapshot(BaseModel):
    symbol: str
    price: Optional[float] = None
    observed_at: Optional[datetime] = None
    source: Optional[str] = None
    degraded: bool = False
    sources: List[SourceStatus]


class QuoteBatch(BaseModel):
    quotes: List[QuoteSnapshot]
