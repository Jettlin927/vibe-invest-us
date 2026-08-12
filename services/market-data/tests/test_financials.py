from app.financials import build_financials


def sec_item(value, end, filed, form, fp, frame, start=None):
    item = {
        "val": value, "end": end, "filed": filed, "form": form, "fp": fp, "frame": frame,
    }
    if start:
        item["start"] = start
    return item


def test_builds_multi_period_financials_ttm_and_traceable_metrics():
    gaap = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            sec_item(100, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(110, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(120, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(130, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(125, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
            sec_item(460, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025", "2025-01-01"),
            sec_item(400, "2024-12-31", "2025-02-01", "10-K", "FY", "CY2024", "2024-01-01"),
        ]}},
        "GrossProfit": {"units": {"USD": [
            sec_item(50, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(60, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(65, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(75, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
        "OperatingIncomeLoss": {"units": {"USD": [
            sec_item(20, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(24, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(26, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(30, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
        "NetIncomeLoss": {"units": {"USD": [
            sec_item(10, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(12, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(14, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(16, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(20, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
        "EarningsPerShareDiluted": {"units": {"USD/shares": [
            sec_item(1, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(1.2, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(1.4, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(1.6, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(2, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
        "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [
            sec_item(18, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(20, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(22, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(25, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
        "PaymentsToAcquirePropertyPlantAndEquipment": {"units": {"USD": [
            sec_item(3, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(4, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(5, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
            sec_item(6, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
    }

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    assert [period["period"] for period in result["quarters"]][:2] == ["CY2026Q1", "CY2025Q4"]
    assert [period["period"] for period in result["annuals"]] == ["CY2025", "CY2024"]
    assert result["ttm"]["status"] == "available"
    assert result["ttm"]["values"]["revenue"]["value"] == 485
    assert result["ttm"]["values"]["free_cash_flow"]["value"] == 67
    revenue_yoy = next(metric for metric in result["derived_metrics"] if metric["metric"] == "revenue_yoy")
    assert revenue_yoy["value"] == 0.25
    assert [value.rsplit(":", 1)[0] for value in revenue_yoy["input_fact_ids"]] == [
        "fact:NVDA:reported:quarter:CY2026Q1:revenue",
        "fact:NVDA:reported:quarter:CY2025Q1:revenue",
    ]
    assert result["quarters"][0]["values"]["cash"]["status"] == "missing"
    ttm_revenue = next(metric for metric in result["derived_metrics"] if metric["scope"] == "ttm" and metric["metric"] == "revenue")
    assert ttm_revenue["fact_id"] == result["ttm"]["values"]["revenue"]["fact_id"]


def test_does_not_create_ttm_when_any_quarter_is_missing():
    gaap = {"RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
        sec_item(100, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
        sec_item(110, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
        sec_item(120, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
    ]}}}

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    assert result["ttm"]["status"] == "unavailable"
    assert result["ttm"]["reason"] == "fewer_than_four_quarters"
    assert result["ttm"]["values"]["free_cash_flow"] == {"status": "missing", "value": None}


def test_does_not_create_ttm_from_four_non_consecutive_quarters():
    values = [
        sec_item(120, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        sec_item(110, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
        sec_item(105, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
        sec_item(100, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
    ]
    gaap = {"RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": values}}}

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    assert result["ttm"]["status"] == "unavailable"
    assert result["ttm"]["reason"] == "non_consecutive_quarters"


def test_derives_discrete_cash_flow_quarters_from_ytd_and_full_year():
    gaap = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            sec_item(100, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(110, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01"),
            sec_item(120, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-07-01"),
            sec_item(130, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025Q4", "2025-10-01"),
        ]}},
        "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [
            sec_item(10, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(25, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-01-01"),
            sec_item(45, "2025-09-30", "2025-11-01", "10-Q", "Q3", "CY2025Q3", "2025-01-01"),
            sec_item(75, "2025-12-31", "2026-02-01", "10-K", "FY", "CY2025", "2025-01-01"),
        ]}},
    }

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    by_period = {period["period"]: period for period in result["quarters"]}
    assert by_period["CY2025Q1"]["values"]["operating_cash_flow"]["value"] == 10
    assert by_period["CY2025Q2"]["values"]["operating_cash_flow"]["value"] == 15
    assert by_period["CY2025Q3"]["values"]["operating_cash_flow"]["value"] == 20
    assert by_period["CY2025Q4"]["values"]["operating_cash_flow"]["value"] == 30
    q4_inputs = [value.rsplit(":", 1)[0] for value in by_period["CY2025Q4"]["values"]["operating_cash_flow"]["input_fact_ids"]]
    assert q4_inputs == [
        "fact:NVDA:reported:annual:CY2025:operating_cash_flow",
        "fact:NVDA:reported:quarter:CY2025Q1:operating_cash_flow",
        "fact:NVDA:reported:ytd:CY2025Q2:operating_cash_flow",
        "fact:NVDA:reported:ytd:CY2025Q3:operating_cash_flow",
    ]


def test_quality_flags_are_deterministic_and_only_reference_existing_facts():
    def quarterly(tag, current, prior):
        return {"units": {"USD": [
            sec_item(prior, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(current, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}}

    gaap = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": quarterly("revenue", 120, 100),
        "NetCashProvidedByUsedInOperatingActivities": quarterly("ocf", 8, 20),
        "AccountsReceivableNetCurrent": {"units": {"USD": [
            sec_item(40, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1I"),
            sec_item(60, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1I"),
        ]}},
        "WeightedAverageNumberOfDilutedSharesOutstanding": {"units": {"shares": [
            sec_item(100, "2025-03-31", "2025-05-01", "10-Q", "Q1", "CY2025Q1", "2025-01-01"),
            sec_item(105, "2026-03-31", "2026-05-01", "10-Q", "Q1", "CY2026Q1", "2026-01-01"),
        ]}},
    }

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    flags = {flag["flag_type"]: flag for flag in result["quality_flags"]}
    assert set(flags) >= {
        "revenue_up_ocf_down", "receivables_outpace_revenue", "diluted_share_count_increase",
    }
    existing = {fact["fact_id"] for fact in result["reported_facts"]}
    existing.update(metric["fact_id"] for metric in result["derived_metrics"])
    for flag in flags.values():
        assert flag["severity"] in {"info", "warning"}
        assert set(flag["evidence_fact_ids"]) <= existing


def test_bounds_financial_history_to_eight_quarters_and_five_years():
    quarters = [
        sec_item(index, f"{year}-{month:02d}-30", f"{year}-{min(month + 1, 12):02d}-15", "10-Q", f"Q{quarter}", f"CY{year}Q{quarter}", f"{year}-{month - 2:02d}-01")
        for index, (year, quarter, month) in enumerate([
            (2026, 2, 6), (2026, 1, 3), (2025, 4, 12), (2025, 3, 9), (2025, 2, 6),
            (2025, 1, 3), (2024, 4, 12), (2024, 3, 9), (2024, 2, 6),
        ], start=1)
    ]
    annuals = [
        sec_item(index * 10, f"{year}-12-31", f"{year + 1}-02-15", "10-K", "FY", f"CY{year}", f"{year}-01-01")
        for index, year in enumerate(range(2020, 2026), start=1)
    ]
    gaap = {"RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [*quarters, *annuals]}}}

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    assert len(result["quarters"]) == 8
    assert result["quarters"][0]["period"] == "CY2026Q2"
    assert len(result["annuals"]) == 5
    assert result["annuals"][0]["period"] == "CY2025"


def test_aligns_ytd_facts_without_sec_frame_to_the_matching_quarter():
    revenue = sec_item(110, "2025-06-30", "2025-08-01", "10-Q", "Q2", "CY2025Q2", "2025-04-01")
    ocf_ytd = sec_item(25, "2025-06-30", "2025-08-01", "10-Q", "Q2", None, "2025-01-01")
    ocf_ytd.update({"fy": 2025})
    gaap = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [revenue]}},
        "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [ocf_ytd]}},
    }

    result = build_financials("NVDA", gaap, "https://sec.example/NVDA")

    quarter = next(period for period in result["quarters"] if period["period"] == "CY2025Q2")
    assert quarter["values"]["operating_cash_flow"]["status"] == "missing"
    assert any(fact["scope"] == "ytd" and fact["period"] == "CY2025Q2" for fact in result["reported_facts"])


def test_non_calendar_fiscal_year_derives_year_end_quarter_and_ttm_by_fact_dates():
    def item(value, start, end, filed, form, fp, frame=None, fy=2025):
        return sec_item(value, end, filed, form, fp, frame, start) | {"fy": fy}

    gaap = {"RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
        item(1883, "2024-06-29", "2024-09-27", "2025-11-07", "10-Q", "Q1", "CY2024Q3", 2026),
        item(1876, "2024-09-28", "2024-12-27", "2026-01-30", "10-Q", "Q2", "CY2024Q4", 2026),
        item(1695, "2024-12-28", "2025-03-28", "2026-05-01", "10-Q", "Q3", "CY2025Q1", 2026),
        item(7355, "2024-06-29", "2025-06-27", "2025-08-21", "10-K", "FY", "CY2024", 2025),
        item(2308, "2025-06-28", "2025-10-03", "2025-11-07", "10-Q", "Q1", "CY2025Q3", 2026),
        # Historical comparison filed under fy=2025 must be named from its actual end date.
        item(6086, "2022-07-02", "2023-06-30", "2025-08-21", "10-K", "FY", None, 2025),
    ]}}}

    result = build_financials("SNDK", gaap, "https://sec.example/SNDK")

    quarters = {period["period"]: period for period in result["quarters"]}
    assert quarters["CY2025Q2"]["values"]["revenue"]["value"] == 1901
    assert result["ttm"]["status"] == "available"
    assert result["ttm"]["values"]["revenue"]["value"] == 7780
    annuals = {period["period"]: period for period in result["annuals"]}
    assert annuals["FY2023"]["observed_at"] == "2023-06-30"
    assert "FY2025" not in annuals or annuals["FY2025"]["observed_at"].startswith("2025")
