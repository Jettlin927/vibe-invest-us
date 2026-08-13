import json
from statistics import median
from hashlib import sha256
from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field
from app.models import AtomicFact


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
    input_observed_at: Dict[str, str] = Field(default_factory=dict)
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
    comparables: List[dict]
    methods: Dict[str, MethodResult]
    historical_ranges: Dict[str, List[float]]
    current_multiples: Dict[str, float] = Field(default_factory=dict)
    inputs: Dict[str, Optional[float]]
    input_observed_at: Dict[str, str]
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
        comparables=inputs.comparables,
        methods=methods,
        historical_ranges=historical_ranges,
        current_multiples={
            "pe": round(inputs.current_price / inputs.diluted_eps, 4)
            for _ in [0]
            if inputs.current_price > 0 and inputs.diluted_eps is not None and inputs.diluted_eps > 0
        },
        inputs={
            "currentPrice": inputs.current_price,
            "dilutedEps": inputs.diluted_eps,
            "enterpriseValue": inputs.enterprise_value,
            "ebitda": inputs.ebitda,
            "revenue": inputs.revenue,
        },
        input_observed_at=inputs.input_observed_at,
        source=inputs.source,
        as_of=inputs.as_of,
    )


def valuation_evidence(result: ValuationResult, now: datetime, input_fact_ids: List[str]):
    methods = {}
    facts = []
    formulas = {
        "pe": ("diluted_eps * adopted_comparable_pe", "USD/share"),
        "evToEbitda": ("enterprise_value / ebitda", "multiple"),
        "evToRevenue": ("enterprise_value / revenue", "multiple"),
    }
    for method, calculated in result.methods.items():
        if calculated.status == "unavailable":
            methods[method] = {"status": "unavailable", "reason": calculated.reason}
            continue
        formula, unit = formulas.get(method, ("deterministic_calculation", "multiple"))
        method_value = {
            "method": method, "status": "available", "inputs": input_fact_ids,
            "formula": formula, "unit": unit, "unitConversion": "none",
            **({"multiple": calculated.multiple} if calculated.multiple is not None else {}),
            **({"targetPrice": calculated.target_price} if calculated.target_price is not None else {}),
            **({"range": {"low": calculated.range[0], "high": calculated.range[1]}}
               if calculated.range is not None else {}),
            "asOf": result.as_of,
        }
        methods[method] = {
            "status": "available",
            **({"multiple": calculated.multiple} if calculated.multiple is not None else {}),
            **({"targetPrice": calculated.target_price} if calculated.target_price is not None else {}),
            **({"range": {"low": calculated.range[0], "high": calculated.range[1]}}
               if calculated.range is not None else {}),
            **({"multiplePercentile": calculated.multiple_percentile}
               if calculated.multiple_percentile is not None else {}),
        }
        fingerprint = sha256(_canonical_json(method_value)).hexdigest()[:16]
        facts.append(AtomicFact(
            id=f"fact:{result.symbol}:deterministic-valuation:{method}:{fingerprint}",
            type="deterministic_valuation", value=method_value,
            observedAt=result.as_of or now.isoformat(), fetchedAt=now.isoformat(),
            source="deterministic-calculation", sourceReference=f"source://{result.source}/valuation",
            evidenceLevel="deterministic_valuation",
        ))
    return {
        "symbol": result.symbol, "authorizedComparables": result.comparable_symbols,
        "comparables": result.comparables,
        "currentMultiples": result.current_multiples,
        "historicalRanges": result.historical_ranges,
        "methods": methods, "facts": facts,
    }


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


def _canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
