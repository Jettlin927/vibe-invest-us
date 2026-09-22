import json

from app.adapters.sources import SecFilingSource


def test_sec_filing_resolves_accession_to_official_document_without_reading_body(monkeypatch):
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
    monkeypatch.setattr("app.adapters.sources._read", read)
    filing = SecFilingSource().fetch("NVDA", "0001045810-26-000123")

    assert filing["sourceReference"] == (
        "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/nvda-20260731.htm"
    )
    assert filing["form"] == "10-Q"
    assert filing["filedAt"] == "2026-07-31"
    assert "sections" not in filing
    assert all(headers["User-Agent"] == "vibe-invest test@example.com" for _, headers in calls)


def test_sec_filing_reads_real_byte_page_and_preserves_provider_total(monkeypatch):
    filing = {
        "filingId": "0001045810-26-000123", "form": "10-Q", "filedAt": "2026-07-31",
        "sourceReference": "https://www.sec.gov/Archives/edgar/data/1045810/q2.htm",
    }
    monkeypatch.setattr("app.adapters.sources.read_document_page", lambda url, cursor, max_bytes, timeout=10: {
        "payload": b"<h1>Guidance</h1><p>Management raised guidance.</p>",
        "contentType": "text/html", "sourceReference": url,
        "startByte": 65536, "endByte": 65590, "totalBytes": 200000,
        "nextCursor": "65591", "truncated": True,
    })

    page = SecFilingSource().fetch_page(filing, "65536")

    assert page["startByte"] == 65536
    assert page["totalBytes"] == 200000
    assert page["nextCursor"] == "65591"
    assert page["summary"] == "Guidance Management raised guidance."
    assert len(page["contentHash"]) == 64


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
    monkeypatch.setattr("app.adapters.sources._read", read)

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
def test_sec_document_uses_configured_identity_without_sending_it_to_other_hosts(monkeypatch):
    from types import SimpleNamespace
    from urllib.parse import urlsplit
    from app.adapters.sources import _open_document_response, USER_AGENT

    monkeypatch.setenv("SEC_USER_AGENT", "vibe-invest test@example.com")

    class Connection:
        def request(self, method, path, headers):
            self.headers = headers

        def getresponse(self):
            return SimpleNamespace(status=200)

    for host, expected in [("www.sec.gov", "vibe-invest test@example.com"),
                           ("news.example.com", USER_AGENT), ("sec.gov.example.com", USER_AGENT)]:
        connection = Connection()
        _open_document_response(connection, "/filing.htm", urlsplit(f"https://{host}/filing.htm"), 0, 64)
        assert connection.headers["User-Agent"] == expected


def test_sec_filing_exposes_body_after_cover_within_the_returned_byte_page(monkeypatch):
    from datetime import datetime, timezone
    from app.service.context import filing_document_page

    payload = ("<p>" + "Cover page " * 70 + "</p><h2>Item 1.01</h2><p>Convertible notes financing agreement.</p>").encode()
    filing = {"filingId": "test-filing", "form": "8-K", "filedAt": "2026-08-13",
              "sourceReference": "https://www.sec.gov/Archives/edgar/data/test.htm"}
    monkeypatch.setattr("app.adapters.sources.read_document_page", lambda url, cursor, max_bytes, timeout=10: {
        "payload": payload, "contentType": "text/html", "sourceReference": url,
        "startByte": 0, "endByte": len(payload) - 1, "totalBytes": len(payload),
        "nextCursor": None, "truncated": False,
    })
    page = SecFilingSource().fetch_page(filing)
    result = filing_document_page("NET", "test-filing", None, page, datetime.now(timezone.utc))
    assert "financing" not in result.facts[0].value["summary"]
    assert "Convertible notes financing agreement" in "".join(result.facts[0].value["passages"])
    assert all(len(part) <= 500 for part in result.facts[0].value["passages"])
    assert result.nextCursor is None
