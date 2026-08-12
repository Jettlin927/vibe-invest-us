from statistics import median
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ValuationInput(BaseModel):
    symbol: str
    industry: str
    current_price: float
    diluted_eps: Optional[float]
    enterprise_value: Optional[float]
    ebitda: Optional[float]
    revenue: Optional[float]
    comparables: List[dict]
    historical_multiples: Dict[str, List[float]] = Field(default_factory=dict)
    source: str = "unspecified"
    as_of: Optional[str] = None


class MethodResult(BaseModel):
    status: Literal["available", "unavailable"]
    reason: Optional[str] = None
    multiple: Optional[float] = None
    target_price: Optional[float] = None
    range: Optional[List[float]] = None
    multiple_percentile: Optional[float] = None


class ValuationResult(BaseModel):
    symbol: str
    industry: str
    comparable_symbols: List[str]
    methods: Dict[str, MethodResult]
    historical_ranges: Dict[str, List[float]]
    source: str
    as_of: Optional[str]


def calculate_valuation(inputs: ValuationInput) -> ValuationResult:
    methods = {
        method: MethodResult(status="unavailable", reason="not_implemented")
        for method in ("dcf", "nav", "pFfo", "rNpv")
    }
    if inputs.industry == "semiconductor":
        methods["pe"] = _pe(inputs)
        methods["evToEbitda"] = _enterprise_multiple(inputs, "evToEbitda", inputs.ebitda)
    elif inputs.industry in ("saas", "internet-platform"):
        methods["pe"] = _pe(inputs)
        methods["evToRevenue"] = _enterprise_multiple(inputs, "evToRevenue", inputs.revenue)
    else:
        methods["industry"] = MethodResult(status="unavailable", reason="unsupported_industry")

    historical_ranges = {
        method: [min(values), max(values)]
        for method, values in inputs.historical_multiples.items() if values
    }
    return ValuationResult(
        symbol=inputs.symbol,
        industry=inputs.industry,
        comparable_symbols=[item["symbol"] for item in inputs.comparables if item.get("symbol")],
        methods=methods,
        historical_ranges=historical_ranges,
        source=inputs.source,
        as_of=inputs.as_of,
    )


def _pe(inputs: ValuationInput) -> MethodResult:
    multiples = _positive_multiples(inputs.comparables, "pe")
    if inputs.diluted_eps is None or inputs.diluted_eps <= 0 or not multiples:
        return MethodResult(status="unavailable", reason="missing_inputs_or_comparables")
    adopted = median(multiples)
    return MethodResult(
        status="available",
        multiple=round(adopted, 4),
        target_price=round(inputs.diluted_eps * adopted, 2),
        range=[round(inputs.diluted_eps * min(multiples), 2), round(inputs.diluted_eps * max(multiples), 2)],
        multiple_percentile=_percentile(inputs.current_price / inputs.diluted_eps, multiples),
    )


def _enterprise_multiple(inputs: ValuationInput, key: str, denominator: Optional[float]) -> MethodResult:
    multiples = _positive_multiples(inputs.comparables, key)
    if inputs.enterprise_value is None or denominator is None or denominator <= 0 or not multiples:
        return MethodResult(status="unavailable", reason="missing_inputs_or_comparables")
    own_multiple = inputs.enterprise_value / denominator
    return MethodResult(
        status="available",
        multiple=round(median(multiples), 4),
        range=[round(min(multiples), 4), round(max(multiples), 4)],
        multiple_percentile=_percentile(own_multiple, multiples),
    )


def _positive_multiples(comparables: List[dict], key: str) -> List[float]:
    return sorted(float(item[key]) for item in comparables if isinstance(item.get(key), (int, float)) and item[key] > 0)


def _percentile(value: float, values: List[float]) -> float:
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return round((below + equal / 2) / len(values), 4)
