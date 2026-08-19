from datetime import datetime, timezone

from app.valuation import ValuationInput, calculate_valuation, valuation_evidence
from app.adapters import COMPARABLES


def test_semiconductor_uses_pe_and_ev_to_ebitda_comparables():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
        comparables=[
            {"symbol": "AMD", "pe": 28, "evToEbitda": 18},
            {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
            {"symbol": "QCOM", "pe": 20, "evToEbitda": 14},
        ],
        historical_multiples={"pe": [18, 22, 26, 30, 34]},
        source="test-source", as_of="2026-08-12T00:00:00Z",
    ))

    assert result.industry == "semiconductor"
    assert result.comparable_symbols == ["AMD", "AVGO", "QCOM"]
    assert result.methods["pe"].status == "available"
    assert result.methods["pe"].target_price == 112
    assert result.methods["pe"].range == [80, 128]
    assert result.methods["evToEbitda"].multiple_percentile == 0.6667
    assert result.historical_ranges["pe"] == [18, 34]
    assert result.inputs == {
        "currentPrice": 120, "dilutedEps": 4,
        "enterpriseValue": 500, "ebitda": 25, "revenue": 100,
    }
    assert result.input_observed_at == {}
    assert result.source == "test-source"
    assert result.as_of == "2026-08-12T00:00:00Z"


def test_saas_uses_ev_to_revenue_and_pe_when_inputs_exist():
    result = calculate_valuation(ValuationInput(
        symbol="CRM", industry="saas", current_price=250,
        diluted_eps=10, enterprise_value=200, ebitda=None, revenue=20,
        comparables=[
            {"symbol": "NOW", "pe": 35, "evToRevenue": 10},
            {"symbol": "ADBE", "pe": 25, "evToRevenue": 8},
            {"symbol": "ORCL", "pe": 20, "evToRevenue": 6},
        ],
    ))

    assert result.methods["evToRevenue"].status == "available"
    assert result.methods["evToRevenue"].multiple == 8
    assert result.methods["pe"].target_price == 250


def test_missing_inputs_and_unimplemented_methods_are_unavailable():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=None, enterprise_value=None, ebitda=None, revenue=None,
        comparables=[],
    ))

    assert result.methods["pe"].status == "unavailable"
    assert result.methods["pe"].reason == "missing_inputs_or_comparables"
    assert result.methods["evToEbitda"].status == "unavailable"
    for method in ["dcf", "nav", "pFfo", "rNpv"]:
        assert result.methods[method].status == "unavailable"
        assert result.methods[method].reason == "not_implemented"


def test_unsupported_industry_does_not_guess_a_method():
    result = calculate_valuation(ValuationInput(
        symbol="JPM", industry="bank", current_price=200,
        diluted_eps=15, enterprise_value=100, ebitda=10, revenue=50,
        comparables=[{"symbol": "BAC", "pe": 12}],
    ))
    assert result.methods["industry"] .status == "unavailable"
    assert result.methods["industry"].reason == "unsupported_industry"


def test_sndk_uses_a_declared_semiconductor_comparable_set():
    assert COMPARABLES["SNDK"] == ("semiconductor", ["MU", "WDC", "STX"])


def test_current_pe_uses_the_market_snapshot_price():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=150,
        diluted_eps=5, enterprise_value=None, ebitda=None, revenue=None,
        comparables=[{"symbol": "AMD", "pe": 20}],
        as_of="2026-08-12T14:30:00Z",
    ))

    assert result.current_multiples["pe"] == 30
    assert result.as_of == "2026-08-12T14:30:00Z"


def test_valuation_evidence_exposes_deterministic_methods_and_explicit_unavailable_states():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
        comparables=[
            {"symbol": "AMD", "pe": 28, "evToEbitda": 18},
            {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
            {"symbol": "QCOM", "pe": 20, "evToEbitda": 14},
        ],
        historical_multiples={"pe": [18, 22, 26, 30, 34]},
        source="yahoo-timeseries", as_of="2026-08-12T14:30:00Z",
    ))

    evidence = valuation_evidence(
        result, datetime(2026, 8, 13, tzinfo=timezone.utc),
        input_fact_ids=["fact:eps", "fact:price"],
    )

    assert evidence["symbol"] == "NVDA"
    assert evidence["authorizedComparables"] == ["AMD", "AVGO", "QCOM"]
    assert evidence["comparables"] == [
        {"symbol": "AMD", "pe": 28, "evToEbitda": 18},
        {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
        {"symbol": "QCOM", "pe": 20, "evToEbitda": 14},
    ]
    assert evidence["currentMultiples"] == {"pe": 30, "evToEbitda": 20, "evToRevenue": 5}
    assert evidence["historicalRanges"] == {"pe": [18, 34]}
    assert evidence["methods"]["dcf"] == {"status": "unavailable", "reason": "not_implemented"}
    assert evidence["methods"]["pe"] == {
        "status": "available", "anchor": "comparables", "multiple": 28, "targetPrice": 112,
        "range": {"low": 80, "high": 128}, "multiplePercentile": 0.6667,
    }
    assert "targetPrice" not in evidence["methods"]["dcf"]
    pe_fact = next(fact for fact in evidence["facts"] if fact.value["method"] == "pe")
    assert pe_fact.type == "deterministic_valuation"
    assert pe_fact.evidenceLevel == "deterministic_valuation"
    assert pe_fact.value == {
        "method": "pe", "status": "available", "inputs": ["fact:eps", "fact:price"],
        "formula": "diluted_eps * adopted_comparable_pe", "unit": "USD/share",
        "unitConversion": "none", "anchor": "comparables",
        "multiple": 28, "targetPrice": 112, "range": {"low": 80, "high": 128},
        "asOf": "2026-08-12T14:30:00Z",
    }
    assert pe_fact.id.startswith("fact:NVDA:deterministic-valuation:pe:")


def test_valuation_evidence_missing_inputs_closes_methods_without_placeholder_facts():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=None, enterprise_value=None, ebitda=None, revenue=None,
        comparables=[], source="yahoo-timeseries", as_of="2026-08-12T14:30:00Z",
    ))

    evidence = valuation_evidence(
        result, datetime(2026, 8, 13, tzinfo=timezone.utc), ["fact:inputs"],
    )

    assert evidence["methods"]["pe"] == {
        "status": "unavailable", "reason": "missing_inputs_or_comparables",
    }
    assert evidence["methods"]["evToEbitda"] == {
        "status": "unavailable", "reason": "missing_inputs_or_comparables",
    }
    assert evidence["facts"] == []
    assert "targetPrice" not in str(evidence)

def test_outlier_comparable_multiples_are_excluded_with_trace():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
        comparables=[
            {"symbol": "AMD", "pe": 131.2, "evToEbitda": 18},
            {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
            {"symbol": "QCOM", "pe": 20, "evToEbitda": 14},
        ],
    ))

    assert result.methods["pe"].multiple == 26  # median(20, 32)，剔除 131.2 离群值
    assert result.methods["pe"].target_price == 104
    assert result.methods["pe"].range == [80, 128]
    assert result.excluded_comparables == [
        {"symbol": "AMD", "method": "pe", "value": 131.2, "reason": "sanity_bound_exceeded"},
    ]


def test_pe_falls_back_to_historical_anchor_without_comparables():
    result = calculate_valuation(ValuationInput(
        symbol="NBIS", industry="unsupported", current_price=100,
        diluted_eps=2, enterprise_value=None, ebitda=None, revenue=None,
        comparables=[],
        historical_multiples={"pe": [40, 45, 50, 55, 200]},
    ))

    assert result.methods["industry"].status == "unavailable"
    assert result.methods["pe"].status == "available"
    assert result.methods["pe"].anchor == "historical_pe"
    assert result.methods["pe"].multiple == 47.5  # median(40, 45, 50, 55)，200 超出合理性上限被剔除
    assert result.methods["pe"].target_price == 95
    assert result.methods["pe"].range == [80, 110]


def test_enterprise_multiple_derives_target_price_by_rerating():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
        comparables=[
            {"symbol": "AMD", "pe": 28, "evToEbitda": 18},
            {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
            {"symbol": "QCOM", "pe": 20, "evToEbitda": 14},
        ],
    ))

    method = result.methods["evToEbitda"]
    assert method.status == "available"
    assert method.multiple == 18
    assert method.target_price == 108  # 120 * 18 / (500/25)
    assert method.range == [84, 132]


def test_valuation_evidence_enterprise_method_uses_price_formula_with_target():
    result = calculate_valuation(ValuationInput(
        symbol="NVDA", industry="semiconductor", current_price=120,
        diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
        comparables=[
            {"symbol": "AMD", "pe": 28, "evToEbitda": 18},
            {"symbol": "AVGO", "pe": 32, "evToEbitda": 22},
        ],
        source="yahoo-timeseries", as_of="2026-08-12T14:30:00Z",
    ))
    evidence = valuation_evidence(
        result, datetime(2026, 8, 13, tzinfo=timezone.utc), ["fact:inputs"],
    )

    ev_fact = next(fact for fact in evidence["facts"] if fact.value["method"] == "evToEbitda")
    assert ev_fact.value["unit"] == "USD/share"
    assert ev_fact.value["formula"] == "current_price * (adopted_ev_to_ebitda / own_ev_to_ebitda)"
    assert ev_fact.value["targetPrice"] == 120.0  # median(18, 22)=20，120 * 20 / (500/25)
