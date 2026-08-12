from app.valuation import ValuationInput, calculate_valuation


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
