import re
from datetime import date
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Optional, Tuple


FIELD_SPECS = {
    "revenue": (["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"], "USD", "flow"),
    "gross_profit": (["GrossProfit"], "USD", "flow"),
    "operating_income": (["OperatingIncomeLoss"], "USD", "flow"),
    "net_income": (["NetIncomeLoss"], "USD", "flow"),
    "eps_diluted": (["EarningsPerShareDiluted"], "USD/shares", "flow"),
    "operating_cash_flow": (
        ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByOperatingActivities"], "USD", "flow",
    ),
    "capex": (
        ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForProceedsFromPropertyPlantAndEquipment"],
        "USD", "flow",
    ),
    "cash": (["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], "USD", "instant"),
    "debt": (["ShortAndLongTermDebtTotal", "LongTermDebtAndFinanceLeaseObligations"], "USD", "instant"),
    "accounts_receivable": (["AccountsReceivableNetCurrent", "AccountsNotesAndLoansReceivableNetCurrent"], "USD", "instant"),
    "inventory": (["InventoryNet"], "USD", "instant"),
    "diluted_shares": (["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares", "flow"),
}

FLOW_FIELDS = {name for name, spec in FIELD_SPECS.items() if spec[2] == "flow"}
TTM_FIELDS = (
    "revenue", "gross_profit", "operating_income", "net_income", "eps_diluted",
    "operating_cash_flow", "capex",
)
TTM_OUTPUT_FIELDS = (*TTM_FIELDS, "free_cash_flow", "gross_margin", "operating_margin", "operating_cash_flow_margin", "fcf_margin")


def build_financials(symbol: str, gaap: Dict[str, Any], source_reference: str) -> Dict[str, Any]:
    """Normalize a bounded multi-period SEC Company Facts payload and calculate deterministic metrics."""
    normalized_symbol = symbol.upper()
    reported = {
        field: _reported_values(gaap, tags, unit, kind)
        for field, (tags, unit, kind) in FIELD_SPECS.items()
    }
    _align_periods_by_end_date(reported)
    all_reported_facts = _reported_fact_records(normalized_symbol, reported, source_reference)
    _derive_discrete_quarter_flows(reported)
    _derive_fiscal_year_end_quarters(reported)
    quarter_keys = _period_keys(reported, "quarter", 8)
    annual_keys = _period_keys(reported, "annual", 5)
    reported_facts = [
        fact for fact in all_reported_facts
        if (fact["scope"] in {"quarter", "ytd"} and fact["period"] in quarter_keys)
        or (fact["scope"] == "annual" and fact["period"] in annual_keys)
    ]
    quarters = [
        _period(normalized_symbol, "quarter", key, reported, source_reference)
        for key in quarter_keys
    ]
    annuals = [
        _period(normalized_symbol, "annual", key, reported, source_reference)
        for key in annual_keys
    ]
    ttm = _ttm(normalized_symbol, quarters, source_reference)
    derived_metrics = _derived_metrics(normalized_symbol, quarters, annuals, ttm, source_reference)
    quality_flags = _quality_flags(normalized_symbol, quarters, derived_metrics, source_reference)
    return {
        "quarters": quarters,
        "annuals": annuals,
        "ttm": ttm,
        "derived_metrics": derived_metrics,
        "quality_flags": quality_flags,
        "reported_facts": reported_facts,
        "sourceReference": source_reference,
    }


def _reported_values(gaap: Dict[str, Any], tags: List[str], unit: str, kind: str) -> Dict[Tuple[str, str], Dict[str, Any]]:
    candidates = []
    for tag in tags:
        for item in gaap.get(tag, {}).get("units", {}).get(unit, []):
            if item.get("form") not in {"10-Q", "10-Q/A", "10-K", "10-K/A"} or item.get("val") is None:
                continue
            frame = str(item.get("frame") or "").removesuffix("I")
            scope = None
            if re.fullmatch(r"(?:CY|FY)\d{4}Q[1-4]", frame):
                scope = "quarter"
            elif re.fullmatch(r"(?:CY|FY)\d{4}", frame) and item.get("fp") == "FY":
                scope = "annual"
            elif item.get("fy") and item.get("fp") in {"Q1", "Q2", "Q3"}:
                frame = f"FY{item['fy']}{item['fp']}"
                scope = "quarter"
            elif item.get("fy") and item.get("fp") == "FY":
                frame = f"FY{item['fy']}"
                scope = "annual"
            if scope is None:
                continue
            period = _period_from_end(item.get("end"), scope)
            if period is None:
                continue
            duration_kind = _duration_kind(item, scope) if kind == "flow" else "instant"
            if duration_kind is None:
                continue
            item = {**item, "_duration_kind": duration_kind}
            raw_scope = "ytd" if duration_kind == "ytd" else scope
            item["_fact_scope"] = raw_scope
            candidates.append((scope, period, item))

    result: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for scope, period, item in candidates:
        key = (scope, period)
        current = result.get(key)
        if current is None or (item.get("filed", ""), item.get("end", "")) > (
            current.get("filed", ""), current.get("end", ""),
        ):
            result[key] = item
    return result


def _align_periods_by_end_date(reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]]) -> None:
    canonical = {}
    for values in reported.values():
        for (scope, period), item in values.items():
            key = (scope, item.get("end"))
            current = canonical.get(key)
            if current is None or (period.startswith("CY") and current.startswith("FY")):
                canonical[key] = period
    for field, values in reported.items():
        aligned = {}
        for (scope, period), item in values.items():
            target = canonical.get((scope, item.get("end")), period)
            aligned[(scope, target)] = item
        reported[field] = aligned


def _duration_kind(item: Dict[str, Any], scope: str) -> Optional[str]:
    if not item.get("start") or not item.get("end"):
        return "discrete"
    try:
        days = (date.fromisoformat(item["end"]) - date.fromisoformat(item["start"])).days
    except ValueError:
        return None
    if scope == "annual":
        return "annual" if 250 <= days <= 430 else None
    if 45 <= days <= 150:
        return "discrete"
    if 150 < days <= 310:
        return "ytd"
    return None


def _derive_discrete_quarter_flows(reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]]) -> None:
    for field in FLOW_FIELDS:
        values = reported[field]
        raw_quarters = sorted(
            (item for (scope, _period), item in values.items() if scope == "quarter"),
            key=lambda item: (item.get("end", ""), item.get("filed", "")),
        )
        for item in raw_quarters:
            if item.get("_duration_kind") != "ytd":
                continue
            previous = max((
                candidate for candidate in raw_quarters
                if candidate.get("start") == item.get("start")
                and candidate.get("end", "") < item.get("end", "")
            ), key=lambda candidate: candidate.get("end", ""), default=None)
            key = ("quarter", _period_from_end(item.get("end"), "quarter"))
            if previous is None:
                values.pop(key, None)
                continue
            values[key] = {
                **item, "val": item["val"] - previous["val"], "_duration_kind": "derived_discrete",
                "_input_fact_ids": [previous["_fact_id"], item["_fact_id"]],
            }


def _derive_fiscal_year_end_quarters(reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]]) -> None:
    for field in FLOW_FIELDS:
        values = reported[field]
        annuals = [item for (scope, _period), item in values.items() if scope == "annual"]
        for annual in annuals:
            target_period = _period_from_end(annual.get("end"), "quarter")
            if target_period is None or ("quarter", target_period) in values:
                continue
            quarters = sorted((
                item for (scope, _period), item in values.items()
                if scope == "quarter"
                and item.get("_duration_kind") in {"discrete", "derived_discrete"}
                and annual.get("start", "") <= item.get("start", "")
                and item.get("end", "") < annual.get("end", "")
            ), key=lambda item: item.get("end", ""))
            if len(quarters) != 3:
                continue
            input_fact_ids = [
                annual["_fact_id"],
                *[fact_id for item in quarters for fact_id in _source_fact_ids(item)],
            ]
            values[("quarter", target_period)] = {
                **annual, "val": annual["val"] - sum(item["val"] for item in quarters),
                "frame": target_period, "_duration_kind": "derived_discrete",
                "_input_fact_ids": list(dict.fromkeys(input_fact_ids)),
            }


def _period_from_end(end: Any, scope: str) -> Optional[str]:
    try:
        observed = date.fromisoformat(str(end))
    except (TypeError, ValueError):
        return None
    adjusted = observed.toordinal() - 7
    normalized = date.fromordinal(adjusted)
    if scope == "annual":
        prefix = "CY" if normalized.month == 12 else "FY"
        return f"{prefix}{normalized.year}"
    return f"CY{normalized.year}Q{(normalized.month - 1) // 3 + 1}"


def _period_keys(reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]], scope: str, limit: int) -> List[str]:
    keys = {
        period
        for values in reported.values()
        for (candidate_scope, period) in values
        if candidate_scope == scope
    }
    return sorted(keys, reverse=True)[:limit]


def _period(symbol: str, scope: str, period: str, reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]], source_reference: str) -> Dict[str, Any]:
    values = {}
    observations = []
    for field in FIELD_SPECS:
        item = reported[field].get((scope, period))
        if item is None and scope == "annual" and FIELD_SPECS[field][2] == "instant":
            item = reported[field].get(("quarter", f"{period}Q4"))
        if item is None:
            values[field] = {"status": "missing", "value": None}
            continue
        is_derived = item.get("_duration_kind") == "derived_discrete"
        input_fact_ids = item.get("_input_fact_ids", [])
        fact_id = (
            _derived_fact_id(symbol, scope, period, field, input_fact_ids)
            if is_derived else item["_fact_id"]
        )
        cell = {
            "status": "available", "value": item["val"], "fact_id": fact_id,
            "observed_at": item.get("end"), "filed_at": item.get("filed"),
            "source_reference": source_reference,
        }
        if input_fact_ids:
            cell["input_fact_ids"] = input_fact_ids
        values[field] = cell
        observations.append(item.get("end"))
    return {
        "period": period, "scope": scope,
        "observed_at": max((value for value in observations if value), default=None),
        "values": values,
    }


def _reported_fact_records(symbol: str, reported: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]], source_reference: str) -> List[Dict[str, Any]]:
    records = []
    seen = set()
    for field, values in reported.items():
        for (_scope, period), item in values.items():
            version = _version(item.get("filed"), item.get("val"), item.get("end"))
            fact_id = f"fact:{symbol}:reported:{item['_fact_scope']}:{period}:{field}:{version}"
            item["_fact_id"] = fact_id
            if fact_id in seen:
                continue
            seen.add(fact_id)
            records.append({
                "fact_id": fact_id, "metric": field, "period": period,
                "scope": item["_fact_scope"], "value": item["val"],
                "observed_at": item.get("end"), "filed_at": item.get("filed"),
                "source_reference": source_reference,
            })
    return records


def _source_fact_ids(item: Dict[str, Any]) -> List[str]:
    return item.get("_input_fact_ids") or [item["_fact_id"]]


def _ttm(symbol: str, quarters: List[Dict[str, Any]], source_reference: str) -> Dict[str, Any]:
    if len(quarters) < 4:
        return {
            "status": "unavailable", "reason": "fewer_than_four_quarters",
            "values": {field: {"status": "missing", "value": None} for field in TTM_OUTPUT_FIELDS},
        }
    selected = quarters[:4]
    if not _consecutive_quarters([period["period"] for period in selected]):
        return {
            "status": "unavailable", "reason": "non_consecutive_quarters",
            "values": {field: {"status": "missing", "value": None} for field in TTM_OUTPUT_FIELDS},
        }
    values = {}
    for field in TTM_FIELDS:
        inputs = [period["values"][field] for period in selected]
        input_fact_ids = [item["fact_id"] for item in inputs if item.get("fact_id")]
        fact_id = _derived_fact_id(symbol, "ttm", selected[0]["period"], field, input_fact_ids)
        if any(item["status"] != "available" for item in inputs):
            values[field] = {"status": "missing", "value": None}
            continue
        values[field] = {
            "status": "available", "value": round(sum(item["value"] for item in inputs), 6),
            "fact_id": fact_id, "input_fact_ids": input_fact_ids,
            "source_reference": source_reference,
        }
    _add_calculated_cells(symbol, "ttm", selected[0]["period"], values, source_reference)
    return {
        "status": "available", "through_period": selected[0]["period"],
        "periods": [period["period"] for period in selected], "values": values,
    }


def _derived_metrics(symbol: str, quarters: List[Dict[str, Any]], annuals: List[Dict[str, Any]], ttm: Dict[str, Any], source_reference: str) -> List[Dict[str, Any]]:
    metrics = []
    for periods in (quarters, annuals):
        for index, period in enumerate(periods):
            _add_period_metrics(symbol, period, periods, index, metrics, source_reference)
    if ttm.get("status") == "available":
        values = ttm["values"]
        for metric in TTM_OUTPUT_FIELDS:
            cell = values.get(metric, {})
            if cell.get("status") == "available":
                metrics.append(_metric_record(symbol, "ttm", ttm["through_period"], metric, cell["value"], cell["input_fact_ids"], source_reference))
    return metrics


def _add_period_metrics(symbol: str, period: Dict[str, Any], periods: List[Dict[str, Any]], index: int, metrics: List[Dict[str, Any]], source_reference: str) -> None:
    values = period["values"]
    _add_calculated_cells(symbol, period["scope"], period["period"], values, source_reference)
    for metric in ("gross_margin", "operating_margin", "operating_cash_flow_margin", "free_cash_flow", "fcf_margin"):
        cell = values.get(metric, {})
        if cell.get("status") == "available":
            metrics.append(_metric_record(symbol, period["scope"], period["period"], metric, cell["value"], cell["input_fact_ids"], source_reference))

    comparisons = {
        "revenue": "revenue", "net_income": "net_income", "eps_diluted": "eps",
        "accounts_receivable": "accounts_receivable", "inventory": "inventory",
        "capex": "capex", "diluted_shares": "share_count",
    }
    if period["scope"] == "quarter" and index + 1 < len(periods):
        for field in ("revenue", "net_income", "eps_diluted"):
            _append_growth(symbol, period, periods[index + 1], field, f"{comparisons[field]}_qoq", metrics, source_reference)
    prior_period = _prior_year(period["period"])
    previous = next((candidate for candidate in periods if candidate["period"] == prior_period), None)
    if previous:
        for field, label in comparisons.items():
            _append_growth(symbol, period, previous, field, f"{label}_yoy", metrics, source_reference)


def _add_calculated_cells(symbol: str, scope: str, period: str, values: Dict[str, Any], source_reference: str) -> None:
    _add_ratio_cell(symbol, scope, period, values, "gross_margin", "gross_profit", "revenue", source_reference)
    _add_ratio_cell(symbol, scope, period, values, "operating_margin", "operating_income", "revenue", source_reference)
    _add_ratio_cell(symbol, scope, period, values, "operating_cash_flow_margin", "operating_cash_flow", "revenue", source_reference)
    ocf, capex = values.get("operating_cash_flow", {}), values.get("capex", {})
    if ocf.get("status") == "available" and capex.get("status") == "available":
        input_fact_ids = [ocf["fact_id"], capex["fact_id"]]
        fact_id = _derived_fact_id(symbol, scope, period, "free_cash_flow", input_fact_ids)
        values["free_cash_flow"] = {
            "status": "available", "value": round(ocf["value"] - capex["value"], 6),
            "fact_id": fact_id, "input_fact_ids": input_fact_ids,
            "source_reference": source_reference,
        }
    else:
        values["free_cash_flow"] = {"status": "missing", "value": None}
    _add_ratio_cell(symbol, scope, period, values, "fcf_margin", "free_cash_flow", "revenue", source_reference)


def _add_ratio_cell(symbol: str, scope: str, period: str, values: Dict[str, Any], metric: str, numerator: str, denominator: str, source_reference: str) -> None:
    top, bottom = values.get(numerator, {}), values.get(denominator, {})
    if top.get("status") != "available" or bottom.get("status") != "available" or bottom.get("value") == 0:
        values[metric] = {"status": "missing", "value": None}
        return
    input_fact_ids = [top["fact_id"], bottom["fact_id"]]
    values[metric] = {
        "status": "available", "value": round(top["value"] / bottom["value"], 6),
        "fact_id": _derived_fact_id(symbol, scope, period, metric, input_fact_ids),
        "input_fact_ids": input_fact_ids, "source_reference": source_reference,
    }


def _append_growth(symbol: str, current: Dict[str, Any], previous: Dict[str, Any], field: str, metric: str, metrics: List[Dict[str, Any]], source_reference: str) -> None:
    current_cell, previous_cell = current["values"].get(field, {}), previous["values"].get(field, {})
    if current_cell.get("status") != "available" or previous_cell.get("status") != "available" or previous_cell.get("value") == 0:
        return
    value = round(current_cell["value"] / previous_cell["value"] - 1, 6)
    metrics.append(_metric_record(
        symbol, current["scope"], current["period"], metric, value,
        [current_cell["fact_id"], previous_cell["fact_id"]], source_reference,
    ))


def _metric_record(symbol: str, scope: str, period: str, metric: str, value: float, input_fact_ids: List[str], source_reference: str) -> Dict[str, Any]:
    return {
        "metric": metric, "scope": scope, "period": period, "value": value,
        "fact_id": _derived_fact_id(symbol, scope, period, metric, input_fact_ids),
        "input_fact_ids": input_fact_ids, "source_reference": source_reference,
    }


def _prior_year(period: str) -> str:
    match = re.fullmatch(r"(CY|FY)(\d{4})(Q[1-4])?", period)
    if not match:
        return ""
    return f"{match.group(1)}{int(match.group(2)) - 1}{match.group(3) or ''}"


def _consecutive_quarters(periods: List[str]) -> bool:
    ordinals = []
    for period in periods:
        match = re.fullmatch(r"(?:CY|FY)(\d{4})Q([1-4])", period)
        if not match:
            return False
        ordinals.append(int(match.group(1)) * 4 + int(match.group(2)))
    return all(current - following == 1 for current, following in zip(ordinals, ordinals[1:]))


def _version(*parts: Any) -> str:
    return sha256("|".join(str(part) for part in parts).encode()).hexdigest()[:12]


def _derived_fact_id(symbol: str, scope: str, period: str, metric: str, input_fact_ids: List[str]) -> str:
    return f"fact:{symbol}:derived:{scope}:{period}:{metric}:{_version(*input_fact_ids)}"


def _quality_flags(symbol: str, quarters: List[Dict[str, Any]], metrics: List[Dict[str, Any]], source_reference: str) -> List[Dict[str, Any]]:
    if not quarters:
        return []
    period = quarters[0]["period"]
    by_name = {(item["period"], item["metric"]): item for item in metrics}
    flags = []

    def add(flag_type: str, severity: str, evidence: Iterable[Optional[Dict[str, Any]]]):
        items = [item for item in evidence if item]
        ids = list(dict.fromkeys(fact_id for item in items for fact_id in item["input_fact_ids"]))
        flags.append({
            "flag_type": flag_type, "severity": severity, "period": period,
            "fact_id": _derived_fact_id(symbol, "quality", period, flag_type, ids),
            "evidence_fact_ids": ids, "source_reference": source_reference,
        })

    revenue = by_name.get((period, "revenue_yoy"))
    ocf = _growth_metric(quarters, period, "operating_cash_flow", symbol, source_reference)
    if revenue and ocf and revenue["value"] > 0.05 and ocf["value"] < -0.10:
        add("revenue_up_ocf_down", "warning", [revenue, ocf])
    for metric, flag_type in (("accounts_receivable_yoy", "receivables_outpace_revenue"), ("inventory_yoy", "inventory_outpaces_revenue")):
        candidate = by_name.get((period, metric))
        if revenue and candidate and candidate["value"] - revenue["value"] >= 0.15:
            add(flag_type, "warning", [candidate, revenue])
    shares = by_name.get((period, "share_count_yoy"))
    if shares and shares["value"] >= 0.03:
        add("diluted_share_count_increase", "warning", [shares])

    current_fcf = by_name.get((period, "fcf_margin"))
    current_op = by_name.get((period, "operating_margin"))
    prior_period = _prior_year(period)
    prior_fcf = by_name.get((prior_period, "fcf_margin"))
    prior_op = by_name.get((prior_period, "operating_margin"))
    if current_fcf and prior_fcf and current_fcf["value"] - prior_fcf["value"] <= -0.05:
        add("fcf_margin_deterioration", "warning", [current_fcf, prior_fcf])
    if current_op and prior_op:
        change = current_op["value"] - prior_op["value"]
        if change >= 0.03:
            add("operating_margin_improvement", "info", [current_op, prior_op])
        elif change <= -0.03:
            add("operating_margin_deterioration", "warning", [current_op, prior_op])
    return flags


def _growth_metric(quarters: List[Dict[str, Any]], period: str, field: str, symbol: str, source_reference: str) -> Optional[Dict[str, Any]]:
    current = next((item for item in quarters if item["period"] == period), None)
    previous = next((item for item in quarters if item["period"] == _prior_year(period)), None)
    if not current or not previous:
        return None
    collected: List[Dict[str, Any]] = []
    _append_growth(symbol, current, previous, field, f"{field}_yoy", collected, source_reference)
    return collected[0] if collected else None
