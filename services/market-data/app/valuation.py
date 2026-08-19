import json
from statistics import median
from hashlib import sha256
from datetime import datetime
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field
from app.models import AtomicFact


# 可比倍数的合理性上限：超过上限的倍数不能作为估值锚点（例如微利导致的 130+ PE），
# 剔除时保留机器可读记录，不静默丢弃。
SANITY_BOUNDS = {"pe": 100.0, "evToEbitda": 60.0, "evToRevenue": 25.0}


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
    anchor: Optional[str] = None
    multiple: Optional[float] = None
    target_price: Optional[float] = None
    range: Optional[List[float]] = None
    multiple_percentile: Optional[float] = None


class ValuationResult(BaseModel):
    symbol: str
    industry: str
    comparable_symbols: List[str]
    comparables: List[dict]
    excluded_comparables: List[dict] = Field(default_factory=list)
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
    exclusions: List[dict] = []
    comparable_multiples: Dict[str, List[float]] = {}
    for key, bound in SANITY_BOUNDS.items():
        kept, dropped = _bounded_multiples(inputs.comparables, key, bound)
        comparable_multiples[key] = kept
        exclusions.extend(dropped)
    if inputs.industry == "semiconductor":
        methods["pe"] = _pe(inputs, comparable_multiples["pe"])
        methods["evToEbitda"] = _enterprise_multiple(
            inputs, "evToEbitda", inputs.ebitda, comparable_multiples["evToEbitda"],
        )
    elif inputs.industry in ("saas", "internet-platform"):
        methods["pe"] = _pe(inputs, comparable_multiples["pe"])
        methods["evToRevenue"] = _enterprise_multiple(
            inputs, "evToRevenue", inputs.revenue, comparable_multiples["evToRevenue"],
        )
    else:
        methods["industry"] = MethodResult(status="unavailable", reason="unsupported_industry")
        # 未覆盖行业不用可比公司猜方法，但仍允许历史 PE 锚定的确定性估值（事实链保留锚点类型）
        methods["pe"] = _pe(inputs, [])

    historical_ranges = {
        method: [min(values), max(values)]
        for method, values in inputs.historical_multiples.items() if values
    }
    current_multiples: Dict[str, float] = {}
    if inputs.current_price > 0 and inputs.diluted_eps is not None and inputs.diluted_eps > 0:
        current_multiples["pe"] = round(inputs.current_price / inputs.diluted_eps, 4)
    if inputs.enterprise_value is not None and inputs.ebitda is not None and inputs.ebitda > 0:
        current_multiples["evToEbitda"] = round(inputs.enterprise_value / inputs.ebitda, 4)
    if inputs.enterprise_value is not None and inputs.revenue is not None and inputs.revenue > 0:
        current_multiples["evToRevenue"] = round(inputs.enterprise_value / inputs.revenue, 4)
    return ValuationResult(
        symbol=inputs.symbol,
        industry=inputs.industry,
        comparable_symbols=[item["symbol"] for item in inputs.comparables if item.get("symbol")],
        comparables=inputs.comparables,
        excluded_comparables=exclusions,
        methods=methods,
        historical_ranges=historical_ranges,
        current_multiples=current_multiples,
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
    for method, calculated in result.methods.items():
        if calculated.status == "unavailable":
            methods[method] = {"status": "unavailable", "reason": calculated.reason}
            continue
        formula, unit = _formula_for(method, calculated.anchor, calculated.target_price is not None)
        method_value = {
            "method": method, "status": "available", "inputs": input_fact_ids,
            "formula": formula, "unit": unit, "unitConversion": "none",
            **({"anchor": calculated.anchor} if calculated.anchor is not None else {}),
            **({"multiple": calculated.multiple} if calculated.multiple is not None else {}),
            **({"targetPrice": calculated.target_price} if calculated.target_price is not None else {}),
            **({"range": {"low": calculated.range[0], "high": calculated.range[1]}}
               if calculated.range is not None else {}),
            "asOf": result.as_of,
        }
        methods[method] = {
            "status": "available",
            **({"anchor": calculated.anchor} if calculated.anchor is not None else {}),
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
        "excludedComparables": result.excluded_comparables,
        "currentMultiples": result.current_multiples,
        "historicalRanges": result.historical_ranges,
        "methods": methods, "facts": facts,
    }


def _formula_for(method: str, anchor: Optional[str], has_target: bool) -> Tuple[str, str]:
    if method == "pe":
        adopted = "adopted_historical_pe" if anchor == "historical_pe" else "adopted_comparable_pe"
        return (f"diluted_eps * {adopted}", "USD/share")
    if method == "evToEbitda":
        if has_target:
            return ("current_price * (adopted_ev_to_ebitda / own_ev_to_ebitda)", "USD/share")
        return ("enterprise_value / ebitda", "multiple")
    if method == "evToRevenue":
        if has_target:
            return ("current_price * (adopted_ev_to_revenue / own_ev_to_revenue)", "USD/share")
        return ("enterprise_value / revenue", "multiple")
    return ("deterministic_calculation", "multiple")


def _pe(inputs: ValuationInput, multiples: List[float]) -> MethodResult:
    if inputs.diluted_eps is None or inputs.diluted_eps <= 0:
        return MethodResult(status="unavailable", reason="missing_inputs_or_comparables")
    values = multiples
    anchor = "comparables"
    if not values:
        values = sorted(
            float(value) for value in inputs.historical_multiples.get("pe", [])
            if isinstance(value, (int, float)) and 0 < value <= SANITY_BOUNDS["pe"]
        )
        anchor = "historical_pe"
    if not values:
        return MethodResult(status="unavailable", reason="missing_inputs_or_comparables")
    adopted = median(values)
    own_multiple = inputs.current_price / inputs.diluted_eps if inputs.current_price > 0 else None
    return MethodResult(
        status="available",
        anchor=anchor,
        multiple=round(adopted, 4),
        target_price=round(inputs.diluted_eps * adopted, 2),
        range=[round(inputs.diluted_eps * values[0], 2), round(inputs.diluted_eps * values[-1], 2)],
        multiple_percentile=_percentile(own_multiple, values) if own_multiple is not None else None,
    )


def _enterprise_multiple(
    inputs: ValuationInput, key: str, denominator: Optional[float], multiples: List[float],
) -> MethodResult:
    if inputs.enterprise_value is None or denominator is None or denominator <= 0 or not multiples:
        return MethodResult(status="unavailable", reason="missing_inputs_or_comparables")
    own_multiple = inputs.enterprise_value / denominator
    adopted = median(multiples)
    target_price = None
    price_range = None
    if inputs.current_price > 0 and own_multiple > 0:
        # 净债务未知时的确定性重估近似：价格按自身倍数回归可比中位倍数等比缩放
        target_price = round(inputs.current_price * adopted / own_multiple, 2)
        price_range = [
            round(inputs.current_price * multiples[0] / own_multiple, 2),
            round(inputs.current_price * multiples[-1] / own_multiple, 2),
        ]
    return MethodResult(
        status="available",
        anchor="comparables",
        multiple=round(adopted, 4),
        target_price=target_price,
        range=price_range if price_range is not None else [round(multiples[0], 4), round(multiples[-1], 4)],
        multiple_percentile=_percentile(own_multiple, multiples),
    )


def _bounded_multiples(comparables: List[dict], key: str, bound: float) -> Tuple[List[float], List[dict]]:
    kept, dropped = [], []
    for item in comparables:
        value = item.get(key)
        if not isinstance(value, (int, float)) or value <= 0:
            continue
        if value > bound:
            dropped.append({
                "symbol": item.get("symbol"), "method": key,
                "value": float(value), "reason": "sanity_bound_exceeded",
            })
            continue
        kept.append(float(value))
    return sorted(kept), dropped


def _percentile(value: float, values: List[float]) -> float:
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return round((below + equal / 2) / len(values), 4)


def _canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
