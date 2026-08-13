import json

from app.adapters import SecFilingSource


def test_sec_filing_resolves_accession_to_official_document_and_bounded_sections(monkeypatch):
    calls = []

    def read(url, params=None, headers=None, timeout=15):
        calls.append((url, headers))
        if url.endswith("company_tickers.json"):
            return json.dumps({"0": {"ticker": "NVDA", "cik_str": 1045810}}).encode()
        return json.dumps({"filings": {"recent": {
            "accessionNumber": ["0001045810-26-000123"], "form": ["10-Q"],
            "filingDate": ["2026-07-31"], "primaryDocument": ["nvda-20260731.htm"],
        }}}).encode()

    monkeypatch.setenv("SEC_USER_AGENT", "vibe-invest test@example.com")
    monkeypatch.setattr("app.adapters._read", read)
    monkeypatch.setattr("app.adapters.read_limited_document", lambda url, max_bytes, timeout=10: (
        b"<h1>Results</h1><p>Revenue increased.</p><h1>Guidance</h1><p>Guidance raised.</p>",
        "text/html", False, url,
    ))

    filing = SecFilingSource().fetch("NVDA", "0001045810-26-000123")

    assert filing["sourceReference"] == (
        "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/nvda-20260731.htm"
    )
    assert filing["form"] == "10-Q"
    assert filing["filedAt"] == "2026-07-31"
    assert filing["sections"] == [
        {"name": "Results", "summary": "Revenue increased."},
        {"name": "Guidance", "summary": "Guidance raised."},
    ]
    assert all(headers["User-Agent"] == "vibe-invest test@example.com" for _, headers in calls)


def test_sec_filing_lists_bounded_official_company_events(monkeypatch):
    def read(url, params=None, headers=None, timeout=15):
        if url.endswith("company_tickers.json"):
            return json.dumps({"0": {"ticker": "NVDA", "cik_str": 1045810}}).encode()
        return json.dumps({"filings": {"recent": {
            "accessionNumber": [
                "0001045810-26-000123", "0001045810-26-000124", "0001045810-26-000125",
            ],
            "form": ["10-Q", "8-K", "4"],
            "filingDate": ["2026-07-31", "2026-07-15", "2026-07-01"],
            "primaryDocument": ["q2.htm", "event.htm", "ownership.xml"],
        }}}).encode()

    monkeypatch.setenv("SEC_USER_AGENT", "vibe-invest test@example.com")
    monkeypatch.setattr("app.adapters._read", read)

    events = SecFilingSource().list_events("NVDA")

    assert events == [
        {
            "filingId": "0001045810-26-000123", "form": "10-Q", "filedAt": "2026-07-31",
            "eventType": "earnings", "sourceReference": (
                "https://www.sec.gov/Archives/edgar/data/1045810/"
                "000104581026000123/q2.htm"
            ),
        },
        {
            "filingId": "0001045810-26-000124", "form": "8-K", "filedAt": "2026-07-15",
            "eventType": "company_event", "sourceReference": (
                "https://www.sec.gov/Archives/edgar/data/1045810/"
                "000104581026000124/event.htm"
            ),
        },
    ]
