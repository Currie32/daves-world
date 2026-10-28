import email.utils
import hashlib
import hmac
import html
import json
import os
import re
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import firebase_admin
import requests
from bs4 import BeautifulSoup
from firebase_admin import firestore
from firebase_functions import https_fn, scheduler_fn
from icalendar import Calendar
from recipe_scrapers import scrape_html

firebase_admin.initialize_app()


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}


@https_fn.on_call(invoker="public", region="us-west1")
def scrape_recipe(req: https_fn.CallableRequest) -> dict:
    url = req.data.get("url", "").strip()
    if not url:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="url is required",
        )

    try:
        session = requests.Session()
        session.headers.update(HEADERS)
        response = session.get(url, timeout=15, allow_redirects=True)
        html = response.text
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not fetch URL: {e}",
        )

    try:
        scraper = scrape_html(html, org_url=url, wild_mode=True)
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.NOT_FOUND,
            message=f"Could not find recipe on page: {e}",
        )

    def safe(fn):
        try:
            return fn()
        except Exception:
            return None

    return {
        "title": safe(scraper.title) or "",
        "host": safe(scraper.host) or "",
        "source": safe(scraper.host) or "",
        "ingredients": safe(scraper.ingredients) or [],
        "instructions": (safe(scraper.instructions_list) or
                         [s.strip() for s in (safe(scraper.instructions) or "").split("\n") if s.strip()]),
        "prepTime": safe(scraper.prep_time),
        "cookTime": safe(scraper.cook_time),
        "totalTime": safe(scraper.total_time),
        "servings": safe(scraper.yields),
        "image": safe(scraper.image),
    }


# ─── S&P 500 Market Data ─────────────────────────────────────────────────────

METRIC_URLS = {
    "trailing": "https://www.multpl.com/s-p-500-pe-ratio/table/by-month",
    "cape": "https://www.multpl.com/shiller-pe/table/by-month",
    "earnings": "https://www.multpl.com/s-p-500-earnings/table/by-month",
}

_metric_cache = {}
METRIC_CACHE_TTL = 24 * 60 * 60  # 24 hours


def _scrape_multpl_table(url):
    """Fetch and parse a numeric table from multpl.com.

    Returns a list of {"date": "YYYY-MM-DD", "value": float} sorted by date.
    Handles plain numbers, percentages, and dollar amounts.
    """
    session = requests.Session()
    session.headers.update(HEADERS)
    response = session.get(url, timeout=15)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    table = soup.find("table", id="datatable")
    if not table:
        raise ValueError("Could not find data table on page")

    data = []
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        date_str = cells[0].get_text(strip=True)
        val_str = cells[1].get_text(strip=True)
        # Remove estimate marker, whitespace chars, $, %
        val_str = (
            val_str.replace("\u2020", "")
            .replace("\u2002", "")
            .replace("$", "")
            .replace("%", "")
            .replace(",", "")
            .strip()
        )
        try:
            value = float(val_str)
            dt = datetime.strptime(date_str, "%b %d, %Y")
            data.append({"date": dt.strftime("%Y-%m-%d"), "value": round(value, 2)})
        except (ValueError, TypeError):
            continue

    data.sort(key=lambda d: d["date"])
    return data


def _compute_yoy_growth(raw_data):
    """Compute year-over-year growth rate from monthly raw values.

    For each data point, finds the value ~12 months prior and computes
    the percentage change. Returns the same format with growth rate as value.
    """
    # Build a lookup by (year, month) for fast matching
    by_month = {}
    for d in raw_data:
        parts = d["date"].split("-")
        key = (int(parts[0]), int(parts[1]))
        by_month[key] = d["value"]

    growth = []
    for d in raw_data:
        parts = d["date"].split("-")
        y, m = int(parts[0]), int(parts[1])
        prior_key = (y - 1, m)
        if prior_key in by_month and by_month[prior_key] != 0:
            pct = ((d["value"] - by_month[prior_key]) / abs(by_month[prior_key])) * 100
            growth.append({"date": d["date"], "value": round(pct, 2)})

    return growth


@https_fn.on_call(invoker="public", region="us-west1")
def fetch_pe_data(req: https_fn.CallableRequest) -> dict:
    metric = req.data.get("type", "trailing") if req.data else "trailing"
    if metric not in METRIC_URLS:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message=f"type must be one of: {', '.join(METRIC_URLS.keys())}",
        )

    now = time.time()
    cached = _metric_cache.get(metric)
    if cached and (now - cached["timestamp"]) < METRIC_CACHE_TTL:
        return cached["result"]

    try:
        raw = _scrape_multpl_table(METRIC_URLS[metric])
        if metric == "earnings":
            # Convert raw earnings to YoY growth rate
            data = _compute_yoy_growth(raw)
        else:
            data = raw
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not fetch data: {e}",
        )

    result = {"data": data, "type": metric}
    _metric_cache[metric] = {"result": result, "timestamp": now}
    return result


# ─── Metro Vancouver / Tri-Cities Events ─────────────────────────────────────
#
# Each entry in EVENT_SOURCES describes where to fetch events from and how to
# parse the response. `kind` selects the strategy in `_scrape_source`:
#   "ics"   - an iCalendar (.ics) feed, parsed with the `icalendar` package.
#             Most robust option; used wherever a city exposes one.
#   "tribe" - the WordPress "The Events Calendar" plugin's public REST API
#             (used by many BC tourism sites), returns structured JSON.
#   "html"  - generic HTML scrape. We first look for schema.org JSON-LD
#             `Event` blocks (increasingly common for SEO on modern sites,
#             including JS-rendered ones that still server-render metadata),
#             then fall back to a source-specific best-effort parser.
#
# NOTE: HTML/JSON-LD selectors are based on a point-in-time inspection of
# each site and may drift as these sites redesign. `refresh_events` reports
# a per-source error instead of failing the whole batch, so a broken source
# doesn't take down the others - check the returned `errors` and adjust the
# relevant `_parse_*` function if a source stops returning events.

EVENT_SOURCES = {
    "coquitlam": {
        "label": "City of Coquitlam",
        "kind": "ics",
        "url": "https://www.coquitlam.ca/common/modules/iCalendar/iCalendar.aspx?catID=22&feed=calendar",
        "region": "tri-cities",
        "city": "Coquitlam",
    },
    "port_moody": {
        "label": "City of Port Moody",
        "kind": "html",
        "url": "https://ecalendar.portmoody.ca/",
        "listUrl": "https://ecalendar.portmoody.ca/default/List",
        "region_base": "https://ecalendar.portmoody.ca",
        "region": "tri-cities",
        "city": "Port Moody",
    },
    "port_moody_signature": {
        "label": "Port Moody Signature Events",
        "kind": "html",
        "url": "https://www.portmoody.ca/arts-culture-and-heritage/events/events-at-a-glance/",
        "region": "tri-cities",
        "city": "Port Moody",
    },
    "seasonal_curated": {
        "label": "Seasonal Highlights",
        "kind": "html",
        "url": "https://www.destinationvancouver.com/events/annual-events",
        "region": "metro-vancouver",
        "city": None,
    },
    "vpl_kids": {
        "label": "Vancouver Public Library (Kids & Family)",
        "kind": "html",
        "url": "https://vpl.bibliocommons.com/v2/events",
        "region": "metro-vancouver",
        "city": "Vancouver",
    },
    "surrey_libraries_kids": {
        "label": "Surrey Libraries (Kids & Family)",
        "kind": "html",
        "url": "https://www.surreylibraries.ca/events",
        "region": "metro-vancouver",
        "city": "Surrey",
    },
    "port_coquitlam": {
        "label": "City of Port Coquitlam",
        "kind": "html",
        "url": "https://www.portcoquitlam.ca/explore-poco/events/community-calendar",
        "region": "tri-cities",
        "city": "Port Coquitlam",
    },
    "tourism_coquitlam": {
        "label": "Tourism Coquitlam",
        "kind": "tribe",
        "url": "https://visitcoquitlam.ca/wp-json/tribe/events/v1/events",
        "region": "tri-cities",
        "city": "Coquitlam",
    },
    "destination_vancouver": {
        "label": "Destination Vancouver",
        "kind": "html",
        "url": "https://www.destinationvancouver.com/events/events-calendar",
        "region": "metro-vancouver",
        "city": "Vancouver",
    },
    "metro_vancouver_parks": {
        "label": "Metro Vancouver Regional Parks",
        "kind": "html",
        "url": "https://metrovancouver.org/events/events-calendar",
        "region": "metro-vancouver",
        "city": None,
    },
    "tourism_burnaby": {
        "label": "Tourism Burnaby",
        "kind": "html",
        "url": "https://tourismburnaby.com/events/",
        "region": "metro-vancouver",
        "city": "Burnaby",
    },
    "new_westminster": {
        "label": "City of New Westminster",
        "kind": "html",
        "url": "https://www.newwestcity.ca/calendar-of-events",
        "region": "metro-vancouver",
        "city": "New Westminster",
    },
}

# Ordered longest-name-first so "Port Coquitlam" matches before the substring "Coquitlam".
KNOWN_CITIES = [
    "Port Coquitlam", "Port Moody", "New Westminster", "North Vancouver", "West Vancouver",
    "Coquitlam", "Burnaby", "Vancouver", "Langley", "Maple Ridge", "Pitt Meadows",
    "Surrey", "Richmond", "Delta", "Tsawwassen", "Anmore", "Belcarra",
    "Abbotsford", "Chilliwack",
]


def _guess_city(cfg, location):
    """Prefer the city named in the event's own address (accurate for
    multi-city sources like Metro Vancouver Parks); fall back to the source's
    default city, since most single-municipality sources never spell it out."""
    address = (location or {}).get("address") or (location or {}).get("name") or ""
    lower = address.lower()
    for city in KNOWN_CITIES:
        if city.lower() in lower:
            return city
    return cfg.get("city")

EVENTS_CACHE_TTL = 12 * 60 * 60  # 12 hours, per-source
_events_cache = {}
_geocode_cache = {}

GOOGLE_MAPS_API_KEY = os.environ.get("VITE_GOOGLE_MAPS_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY")


def _event_id(source, sk_or_url, title=None, start_date=None):
    """Deterministic Firestore doc id so re-scraping upserts instead of duplicating."""
    key = sk_or_url or f"{title}|{start_date}"
    digest = hashlib.sha1(f"{source}|{key}".encode("utf-8")).hexdigest()[:20]
    return f"{source}_{digest}"


# Soft viewport bias covering Metro Vancouver + the Fraser Valley, so bare venue
# names/generic street addresses (e.g. "920 Twelfth Street") resolve locally
# instead of matching a same-named place anywhere else on earth.
METRO_VANCOUVER_BOUNDS = "49.0,-123.3|49.5,-122.3"


def _geocode(address):
    """Geocode a free-text address via the Google Geocoding API, cached by string."""
    if not address or not GOOGLE_MAPS_API_KEY:
        return None
    if address in _geocode_cache:
        return _geocode_cache[address]
    try:
        resp = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={
                "address": address,
                "key": GOOGLE_MAPS_API_KEY,
                "region": "ca",
                "bounds": METRO_VANCOUVER_BOUNDS,
            },
            timeout=10,
        )
        data = resp.json()
        results = data.get("results") or []
        if not results:
            _geocode_cache[address] = None
            return None
        loc = results[0]["geometry"]["location"]
        result = {"lat": loc["lat"], "lng": loc["lng"], "address": results[0]["formatted_address"]}
        _geocode_cache[address] = result
        return result
    except Exception:
        _geocode_cache[address] = None
        return None


def _clean_text(text):
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip()


# A fixed, small vocabulary rather than passing scraped categories through
# as-is - raw source tags (e.g. WordPress event categories) fragment into
# dozens of one-off labels, which makes the tag filter mostly useless (each
# pill matches only 1-2 events). Matching keywords against this list instead
# means every event lands in one of a handful of buckets, so filtering by a
# tag reliably surfaces many events. Order doesn't matter - an event can (and
# often should) match multiple tags.
TAG_TAXONOMY = [
    ("Live Music", [r"\bconcert", r"\bmusic\b", r"\bband\b", r"\bchoir", r"\borchestra",
                     r"\bdj\b", r"\bsing", r"\bopen mic", r"\bjazz\b"]),
    ("Arts & Culture", [r"\bart\b", r"\bgallery", r"\bexhibit", r"\bmuseum", r"\btheatre",
                         r"\btheater", r"\bfilm\b", r"\bcinema", r"\bcultural", r"\bdance\b",
                         r"\bpaint", r"\bpottery", r"\bcraft\b"]),
    ("Family & Kids", [r"\bkids?\b", r"\bfamily\b", r"\bchildren", r"\byouth\b",
                        r"\btoddler", r"\bplayground"]),
    ("Market & Sale", [r"\bmarket\b", r"\bfair\b", r"\bswap\b", r"\bsale\b", r"\bvendor"]),
    ("Food & Drink", [r"\bfood\b", r"\bwine\b", r"\bbeer\b", r"\btasting", r"\bdinner\b",
                       r"\bbrunch\b", r"\bbbq\b", r"\bbarbecue", r"\bculinary", r"\bbrewery"]),
    ("Festival", [r"\bfestival", r"\bfest\b", r"\bcelebrat"]),
    ("Sports & Fitness", [r"\brun\b", r"\brace\b", r"\b5k\b", r"\b10k\b", r"\bmarathon",
                           r"\bfitness", r"\bsports?\b", r"\byoga\b", r"\bcycling", r"\bsoccer",
                           r"\bhockey"]),
    ("Outdoors & Nature", [r"\bpark\b", r"\bnature\b", r"\btrail\b", r"\bgarden", r"\bwildlife",
                            r"\bforest\b", r"\bhike\b", r"\bhiking", r"\bwalk\b", r"\becology"]),
    ("Holiday & Seasonal", [r"\bholiday", r"\bchristmas", r"\bhalloween", r"\bpumpkin",
                             r"\beaster\b", r"\bfestive", r"\bsanta\b", r"\bharvest",
                             r"\bthanksgiving", r"\bvalentine"]),
    ("Comedy", [r"\bcomedy", r"\bcomedian", r"\bstand-up"]),
    ("Community & Civic", [r"\bcouncil\b", r"\bmeeting\b", r"\bforum\b", r"\bvolunteer",
                            r"\bworkshop", r"\bseminar", r"\btown hall", r"\bengagement\b",
                            r"\bbudget\b", r"\belection", r"\bvoting", r"\bnotice\b"]),
]


def _standardize_tags(existing_tags, title, description, max_tags=3):
    blob = " ".join([title or "", description or "", " ".join(existing_tags or [])]).lower()
    matched = [label for label, patterns in TAG_TAXONOMY if any(re.search(p, blob) for p in patterns)]
    if not matched:
        matched = ["Other"]
    return matched[:max_tags]


def _parse_price_text(text):
    """Best-effort parse of a free-text price blurb into our price shape."""
    if not text:
        return {"isFree": True, "text": None, "ticketUrl": None, "advancePurchase": False}
    lower = text.lower()
    if "free" in lower and "$" not in text:
        return {"isFree": True, "text": None, "ticketUrl": None, "advancePurchase": False}
    return {
        "isFree": False,
        "text": _clean_text(text),
        "ticketUrl": None,
        "advancePurchase": "advance" in lower or "in advance" in lower,
    }


COST_RE = re.compile(r"Cost:\s*(.*?)(?:Registration ID:|$)", re.IGNORECASE)


def _fetch_event_details(url):
    """CivicPlus (e.g. Coquitlam) ICS feeds put only a bare detail-page URL in
    DESCRIPTION, so the real description text and any cost ("Cost: $34.65 +
    tax") only exist on that page, under an `itemprop="description"` block."""
    try:
        soup = _fetch_html(url)
        el = soup.find(attrs={"itemprop": "description"})
        text = _clean_text(el.get_text(" ")) if el else ""
        match = COST_RE.search(text)
        price = _parse_price_text(match.group(1)) if match else _parse_price_text(None)
        return {"description": text[:600] or None, "price": price}
    except Exception:
        return None


# ─── Strategy: iCalendar (.ics) feeds ─────────────────────────────────────────

def _parse_ics(source_key, cfg):
    session = requests.Session()
    session.headers.update(HEADERS)
    resp = session.get(cfg["url"], timeout=15)
    resp.raise_for_status()
    cal = Calendar.from_ical(resp.content)

    today = datetime.now().date()
    events = []
    for component in cal.walk("VEVENT"):
        try:
            summary = _clean_text(str(component.get("summary", "")))
            if not summary:
                continue
            dtstart = component.get("dtstart").dt
            dtend = component.get("dtend").dt if component.get("dtend") else None
            start_date = dtstart.date() if hasattr(dtstart, "date") else dtstart
            end_date = (dtend.date() if hasattr(dtend, "date") else dtend) if dtend else None
            if end_date and end_date < start_date:
                end_date = start_date
            if start_date < today - timedelta(days=1):
                continue

            location = _clean_text(str(component.get("location", "")))
            description = _clean_text(str(component.get("description", "")))
            url_prop = component.get("url")
            # datetime is a subclass of date, so check for a time component directly
            time_text = dtstart.strftime("%-I:%M %p") if isinstance(dtstart, datetime) else None

            # CivicPlus feeds (e.g. Coquitlam) set every VEVENT's URL property to the
            # *feed's own* URL rather than a per-event link, but put the real per-event
            # detail page URL as the entire DESCRIPTION. Prefer that when it looks bare.
            event_url = str(url_prop) if url_prop else None
            price = _parse_price_text(None)
            if description.startswith("http://") or description.startswith("https://"):
                event_url = description
                description = ""
                details = _fetch_event_details(event_url)
                if details:
                    description = details["description"] or ""
                    price = details["price"]

            events.append({
                "title": summary,
                "description": description[:600] or None,
                "tags": [],
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat() if end_date and end_date != start_date else None,
                "allDay": time_text is None,
                "timeText": time_text,
                "price": price,
                "url": event_url,
                "location": {"name": location, "address": location} if location else None,
                "source": source_key,
                "sourceEventUrl": event_url,
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


# ─── Strategy: "The Events Calendar" WordPress REST API ──────────────────────

def _parse_tribe(source_key, cfg):
    session = requests.Session()
    session.headers.update(HEADERS)
    resp = session.get(cfg["url"], params={"per_page": 50}, timeout=15)
    resp.raise_for_status()
    payload = resp.json()

    today = datetime.now().date()
    events = []
    for item in payload.get("events", []):
        try:
            title = _clean_text(item.get("title", ""))
            if not title:
                continue
            start_date = datetime.fromisoformat(item["start_date"]).date()
            end_date = datetime.fromisoformat(item["end_date"]).date() if item.get("end_date") else start_date
            if start_date < today - timedelta(days=1):
                continue

            venue = item.get("venue") or {}
            address_parts = [venue.get("address"), venue.get("city")]
            address = ", ".join(p for p in address_parts if p) or venue.get("venue")
            cost = item.get("cost") or ""
            is_free = (not cost) or cost.strip().lower() == "free" or cost.strip() == "$0"

            events.append({
                "title": title,
                "description": _clean_text(BeautifulSoup(item.get("description", ""), "html.parser").get_text())[:600] or None,
                "tags": [_clean_text(c.get("name", "")) for c in item.get("categories", []) if c.get("name")],
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat() if end_date != start_date else None,
                "allDay": bool(item.get("all_day")),
                "timeText": None if item.get("all_day") else item.get("start_date", "")[11:16] or None,
                "price": {
                    "isFree": is_free,
                    "text": None if is_free else _clean_text(cost),
                    "ticketUrl": item.get("website") or None,
                    "advancePurchase": bool(item.get("website")) and not is_free,
                },
                "url": item.get("url"),
                "location": ({"name": venue.get("venue"), "address": address} if venue else None),
                "source": source_key,
                "sourceEventUrl": item.get("url"),
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


# ─── Strategy: generic HTML / JSON-LD ─────────────────────────────────────────

def _extract_jsonld_events(soup, base_url):
    """Look for schema.org Event blocks embedded as JSON-LD (common for SEO)."""
    events = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue
        candidates = data if isinstance(data, list) else [data]
        for node in candidates:
            graph = node.get("@graph") if isinstance(node, dict) else None
            for item in (graph if graph else [node]):
                if not isinstance(item, dict):
                    continue
                types = item.get("@type")
                types = [types] if isinstance(types, str) else (types or [])
                if not any("Event" in t for t in types):
                    continue
                try:
                    start = item.get("startDate", "")[:10]
                    if not start:
                        continue
                    end = (item.get("endDate") or "")[:10] or None
                    loc = item.get("location") or {}
                    address = loc.get("address")
                    if isinstance(address, dict):
                        address = ", ".join(v for v in address.values() if isinstance(v, str))
                    offers = item.get("offers")
                    if isinstance(offers, list):
                        offers = offers[0] if offers else None
                    price_text = None
                    is_free = True
                    if isinstance(offers, dict):
                        price = offers.get("price")
                        if price not in (None, "0", 0):
                            is_free = False
                            price_text = f"${price}"
                    events.append({
                        "title": _clean_text(item.get("name", "")),
                        "description": _clean_text(item.get("description", ""))[:600] or None,
                        "tags": [],
                        "startDate": start,
                        "endDate": end if end and end != start else None,
                        "allDay": True,
                        "timeText": None,
                        "price": {
                            "isFree": is_free, "text": price_text,
                            "ticketUrl": (offers or {}).get("url"),
                            "advancePurchase": bool((offers or {}).get("url")) and not is_free,
                        },
                        "url": item.get("url") or base_url,
                        "location": {"name": loc.get("name"), "address": address} if loc else None,
                        "sourceEventUrl": item.get("url") or None,
                    })
                except Exception:
                    continue
    return events


def _fetch_html(url):
    session = requests.Session()
    session.headers.update(HEADERS)
    resp = session.get(url, timeout=15)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


DATE_RE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}"
)


WEEKDAY_SUFFIX_RE = re.compile(
    r"[-–—,]\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*$"
)


PORT_MOODY_DETAIL_RE = re.compile(r"/default/Detail/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-")


def _fetch_port_moody_details(url):
    """The listing view has no description/location, but each event's detail
    page's `og:description` meta packs "<date/time> <title>\\n\\n <description...>"
    together, and an "Address of event:" <h3> precedes a <p> with the venue -
    both only present when the event actually has that info."""
    try:
        soup = _fetch_html(url)
        meta = soup.find("meta", attrs={"property": "og:description"})
        content = meta.get("content") if meta else ""
        parts = [p.strip() for p in (content or "").split("\n\n") if p.strip()]
        description = _clean_text(" ".join(parts[1:]))[:600] or None

        addr_label = soup.find(lambda tag: tag.name == "h3" and "Address of event" in tag.get_text())
        address_el = addr_label.find_next("p") if addr_label else None
        address = _clean_text(address_el.get_text()) if address_el else None

        price_match = re.search(r"\$[\d,.]+", description or "")
        price = _parse_price_text(price_match.group(0)) if price_match else _parse_price_text(None)
        return {"description": description, "location": {"name": address, "address": address} if address else None, "price": price}
    except Exception:
        return None


def _parse_port_moody(source_key, cfg):
    """Port Moody's "events at a glance" page (the old source here) only lists
    a handful of annual signature events. The city's actual full calendar
    lives on a separate eSolutionsGroup-hosted site with no feed/API, so we
    walk its month-by-month list view and fetch each event's detail page."""
    session = requests.Session()
    session.headers.update(HEADERS)
    today = datetime.now().date()
    month_starts = []
    cursor = today.replace(day=1)
    for _ in range(4):  # this month + next 3
        month_starts.append(cursor)
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

    seen_urls = {}
    for month_start in month_starts:
        list_url = f"{cfg['listUrl']}?StartDate={month_start.strftime('%m/%d/%Y')}"
        try:
            resp = session.get(list_url, timeout=15)
            resp.raise_for_status()
        except Exception:
            continue
        soup = BeautifulSoup(resp.text, "html.parser")
        for a in soup.select('a[href*="/default/Detail/"]'):
            href = a.get("href", "")
            match = PORT_MOODY_DETAIL_RE.search(href)
            if not match or href in seen_urls:
                continue
            title = _clean_text(a.get_text())
            if not title or title.lower().startswith("notice"):
                continue
            seen_urls[href] = title

    events = []
    for href, title in seen_urls.items():
        try:
            match = PORT_MOODY_DETAIL_RE.search(href)
            y, mo, d, h, mi = (int(g) for g in match.groups())
            start_date = datetime(y, mo, d).date()
            if start_date < today - timedelta(days=1):
                continue
            event_url = href if href.startswith("http") else f"{cfg['region_base']}{href}"

            details = _fetch_port_moody_details(event_url) or {}

            events.append({
                "title": title,
                "description": details.get("description"),
                "tags": [],
                "startDate": start_date.isoformat(),
                "endDate": None,
                "allDay": False,
                "timeText": datetime(y, mo, d, h, mi).strftime("%-I:%M %p"),
                "price": details.get("price") or _parse_price_text(None),
                "url": event_url,
                "location": details.get("location"),
                "source": source_key,
                "sourceEventUrl": event_url,
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


SIGNATURE_HEADING_RE = re.compile(
    r"^(?P<title>.+?)\s+-\s+(?:\w+,\s+)?(?P<month>[A-Z][a-z]+)\s+(?P<d1>\d{1,2})"
    r"(?:\s*(?:&|-|and)\s*(?:\w+,\s+)?(?:[A-Z][a-z]+\s+)?(?P<d2>\d{1,2}))?,\s+(?P<year>\d{4})$"
)


def _parse_port_moody_signature(source_key, cfg):
    """Port Moody's "Events at a Glance" page lists the city's annual signature
    events (Fingerling Festival, Golden Spike Days, ...) that the eSolutions
    calendar doesn't carry. Each is an <h2> "Title - Saturday, May 2, 2026"
    inside an AccordionTrigger, followed by an AccordionContent description."""
    resp = requests.get(cfg["url"], headers=HEADERS, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    today = datetime.now().date()
    events = []
    for h2 in soup.select(".AccordionTrigger h2"):
        match = SIGNATURE_HEADING_RE.match(_clean_text(h2.get_text()).replace("\xa0", " "))
        if not match:
            continue
        try:
            month = datetime.strptime(match["month"][:3], "%b").month
            year = int(match["year"])
            start = datetime(year, month, int(match["d1"])).date()
            end = datetime(year, month, int(match["d2"])).date() if match["d2"] else None
        except ValueError:
            continue
        if (end or start) < today:
            continue
        content = h2.find_parent(class_="AccordionTrigger")
        content = content.find_next_sibling(class_="AccordionContent") if content else None
        link = content.find("a", href=True) if content else None
        events.append({
            "title": match["title"],
            "description": _clean_text(content.get_text())[:600] if content else None,
            "tags": [],
            "startDate": start.isoformat(),
            "endDate": end.isoformat() if end and end != start else None,
            "allDay": True,
            "timeText": None,
            "price": _parse_price_text(None),
            "url": link["href"] if link else cfg["url"],
            "location": None,
            "source": source_key,
            "sourceEventUrl": cfg["url"] + "#" + re.sub(r"\W+", "-", match["title"].lower()),
            "region": cfg["region"],
        })
    return events


# Hand-maintained annual events that none of the scraped sources carry (cities
# without a feed, plus paid attractions). Dates are from guide sites and should be
# re-checked each season; an entry whose end date has passed is dropped automatically.
# Fields: title, start/end (ISO), venue, address, city, lat/lng, free, price, url, tag.
CURATED_SEASONAL_EVENTS = [
    {"title": "VanDusen Festival of Lights", "start": "2026-11-27", "end": "2027-01-03",
     "venue": "VanDusen Botanical Garden", "address": "5251 Oak St, Vancouver, BC", "city": "Vancouver",
     "lat": 49.2394, "lng": -123.1296, "free": False, "price": "Ticketed",
     "url": "https://www.destinationvancouver.com/events/annual-events/vandusen-festival-of-lights-vancouver"},
    {"title": "Canyon Lights at Capilano Suspension Bridge", "start": "2026-11-20", "end": "2027-01-10",
     "venue": "Capilano Suspension Bridge Park", "address": "3735 Capilano Rd, North Vancouver, BC", "city": "North Vancouver",
     "lat": 49.3429, "lng": -123.1149, "free": False, "price": "Ticketed",
     "url": "https://www.destinationvancouver.com/events/annual-events/capilano-canyon-lights-vancouver"},
    {"title": "Peak of Christmas at Grouse Mountain", "start": "2026-11-27", "end": "2026-12-24",
     "venue": "Grouse Mountain", "address": "6400 Nancy Greene Way, North Vancouver, BC", "city": "North Vancouver",
     "lat": 49.3800, "lng": -123.0817, "free": False, "price": "Admission applies",
     "url": "https://www.grousemountain.com/"},
    {"title": "Heritage Christmas at Burnaby Village Museum", "start": "2026-11-25", "end": "2027-01-03",
     "venue": "Burnaby Village Museum", "address": "6501 Deer Lake Ave, Burnaby, BC", "city": "Burnaby",
     "lat": 49.2306, "lng": -122.9631, "free": True, "price": None,
     "url": "https://www.burnaby.ca/recreation-and-arts/burnaby-village-museum"},
    {"title": "Noel Holiday Light Festival (Bright Nights)", "start": "2026-11-27", "end": "2026-12-29",
     "venue": "Cloverdale Fairgrounds", "address": "6050 176 St, Surrey, BC", "city": "Surrey",
     "lat": 49.1060, "lng": -122.7283, "free": False, "price": "From $24, timed entry",
     "url": "https://vancouversbestplaces.com/events-calendar/december/top-things-to-do-at-christmas/noel-holiday-light-festival-surrey/"},
    {"title": "Surrey Tree Lighting Festival and Holiday Market", "start": "2026-11-21", "end": "2026-11-22",
     "venue": "Surrey City Hall", "address": "13450 104 Ave, Surrey, BC", "city": "Surrey",
     "lat": 49.1913, "lng": -122.8490, "free": True, "price": None,
     "url": "https://www.surrey.ca/"},
    {"title": "Glow Langley Christmas Lights", "start": "2026-11-19", "end": "2027-01-02",
     "venue": "Milner Village Garden Centre", "address": "21650 Fraser Hwy, Langley, BC", "city": "Langley",
     "lat": 49.0943, "lng": -122.6298, "free": False, "price": "Ticketed",
     "url": "https://vancouversbestplaces.com/events-calendar/december/top-things-to-do-at-christmas/langley-glow-christmas-lights/"},
    {"title": "Merry & Bright at Martini Town", "start": "2026-11-20", "end": "2026-12-31",
     "venue": "Martini Town", "address": "Langley, BC", "city": "Langley",
     "lat": None, "lng": None, "free": True, "price": None,
     "url": "https://vancouversbestplaces.com/events-calendar/december/top-things-to-do-at-christmas/"},
    {"title": "Christmas in the Village (Fort Langley)", "start": "2026-12-18", "end": "2026-12-20",
     "venue": "Fort Langley", "address": "Fort Langley, BC", "city": "Langley",
     "lat": 49.1696, "lng": -122.5798, "free": True, "price": None,
     "url": "https://vancouversbestplaces.com/christmas-craft-fairs/"},
    {"title": "Lights at Lafarge", "start": "2026-11-27", "end": "2027-02-14",
     "venue": "Lafarge Lake - Douglas", "address": "1200 Pinetree Way, Coquitlam, BC", "city": "Coquitlam",
     "lat": 49.2860, "lng": -122.7930, "free": True, "price": None,
     "url": "https://www.coquitlam.ca/"},
    {"title": "Make It Vancouver Holiday Craft Show", "start": "2026-12-10", "end": "2026-12-13",
     "venue": "PNE Forum", "address": "2901 E Hastings St, Vancouver, BC", "city": "Vancouver",
     "lat": 49.2827, "lng": -123.0426, "free": False, "price": "Ticketed",
     "url": "https://vancouversbestplaces.com/christmas-craft-fairs/"},
]


def _parse_seasonal_curated(source_key, cfg):
    today = datetime.now(PACIFIC_TZ).date().isoformat()
    events = []
    for item in CURATED_SEASONAL_EVENTS:
        if item["end"] < today:
            continue
        loc = {"name": item["venue"], "address": item["address"]}
        if item.get("lat"):
            loc.update(lat=item["lat"], lng=item["lng"],
                       mapsUrl=f"https://www.google.com/maps/search/?api=1&query={item['lat']},{item['lng']}")
        price = _parse_price_text(None if item["free"] else item["price"] or "Ticketed")
        price["isFree"] = item["free"]
        events.append({
            "title": item["title"],
            "description": f"Seasonal highlight in {item['city']}. Dates are approximate - check the event site before going.",
            "tags": [],
            "startDate": max(item["start"], today),
            "endDate": item["end"] if item["end"] != max(item["start"], today) else None,
            "allDay": True,
            "timeText": None,
            "price": price,
            "url": item["url"],
            "location": loc,
            "source": source_key,
            "sourceEventUrl": item["url"] + "#" + re.sub(r"\W+", "-", item["title"].lower()),
            "region": cfg["region"],
            "city": item["city"],
        })
    return events


# ─── Strategy: family programming from public library calendars ──────────────

LIBRARY_LOOKAHEAD_DAYS = 56
VPL_GATEWAY = "https://gateway.bibliocommons.com/v2/libraries/vpl/events/search"
# BiblioCommons audience ids for VPL: Babies, Toddlers, Preschool, School Age, Family
VPL_FAMILY_AUDIENCES = ",".join([
    "53c940484246f6147c00000d", "53c940484246f6147c00000e", "53c940484246f6147c00000f",
    "53c940484246f6147c000010", "620d47cd5a2694410016f05e",
])


def _parse_vpl_kids(source_key, cfg):
    """VPL runs on BiblioCommons, whose public gateway returns events as JSON
    (events + a `locations` entity map), filterable by audience. Online-only
    sessions are skipped since the Events page is location-based."""
    session = requests.Session()
    session.headers.update({**HEADERS, "Accept": "application/json"})
    today = datetime.now(PACIFIC_TZ).date()
    params = {
        "startDate": today.isoformat(),
        "endDate": (today + timedelta(days=LIBRARY_LOOKAHEAD_DAYS)).isoformat(),
        "audiences": VPL_FAMILY_AUDIENCES, "limit": 100, "page": 1,
    }
    events, page, pages = [], 1, 1
    while page <= min(pages, 15):
        params["page"] = page
        resp = session.get(VPL_GATEWAY, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        pages = data["events"]["pagination"]["pages"]
        page += 1
        entities = data.get("entities") or {}
        locations = entities.get("locations") or {}
        for ev_id in data["events"]["results"]:
            ev = (entities.get("events") or {}).get(ev_id)
            d = (ev or {}).get("definition") or {}
            if not d or d.get("isCancelled") or not d.get("start"):
                continue
            branch = locations.get(d.get("branchLocationId")) or {}
            if not branch or branch.get("id") == "BC_VIRTUAL":
                continue
            addr = branch.get("address") or {}
            street = " ".join(x for x in [(addr.get("number") or "").strip(), addr.get("street")] if x)
            start = datetime.fromisoformat(d["start"])
            end = datetime.fromisoformat(d["end"]) if d.get("end") else None
            desc = _clean_text(BeautifulSoup(d.get("description") or "", "html.parser").get_text(" "))
            events.append({
                "title": _clean_text(d.get("title") or ""),
                "description": desc[:600] or None,
                "tags": ["Family & Kids"],
                "startDate": start.date().isoformat(),
                "endDate": None,
                "allDay": False,
                "timeText": start.strftime("%-I:%M %p") + (f" - {end.strftime('%-I:%M %p')}" if end else ""),
                "price": _parse_price_text(None),
                "url": f"https://vpl.bibliocommons.com/v2/events/{ev_id}",
                "location": {"name": f"VPL {branch.get('name')}",
                             "address": f"{street}, Vancouver, BC" if street else f"{branch.get('name')} Library, Vancouver, BC"},
                "source": source_key,
                "sourceEventUrl": f"https://vpl.bibliocommons.com/v2/events/{ev_id}",
                "region": cfg["region"],
            })
    return [e for e in events if e["title"]]


# Surrey Libraries audience ids: Babies, Toddlers, Preschool Age, School Age
SURREY_FAMILY_AUDIENCES = ["148", "149", "150", "151"]


def _parse_surrey_libraries_kids(source_key, cfg):
    """Surrey Libraries' Drupal event list is filterable by audience and paged
    10 per page (`?page=N`). Each occurrence has its own `?eventdate=` link."""
    session = requests.Session()
    session.headers.update(HEADERS)
    today = datetime.now(PACIFIC_TZ).date()
    seen = {}
    for audience in SURREY_FAMILY_AUDIENCES:
        for page in range(25):
            resp = session.get(cfg["url"], params={
                "field_audience_target_id": audience,
                "field_date_value[min]": today.isoformat(),
                "field_date_value[max]": (today + timedelta(days=LIBRARY_LOOKAHEAD_DAYS)).isoformat(),
                "page": page,
            }, timeout=20)
            resp.raise_for_status()
            items = BeautifulSoup(resp.text, "html.parser").select(".event-info-item")
            if not items:
                break
            for item in items:
                link = item.select_one(".event-info-item-title a[href]")
                times = item.select("time[datetime]")
                if not link or not times:
                    continue
                href = link["href"]
                if href in seen:
                    continue
                start = datetime.fromisoformat(times[0]["datetime"])
                end = datetime.fromisoformat(times[-1]["datetime"]) if len(times) > 1 else None
                if start.date() < today:
                    continue
                branch_el = item.select_one(".views-field-field-address .field-content")
                branch = _clean_text(branch_el.get_text()) if branch_el else ""
                if branch.lower() in ("online", "mobile library"):
                    continue
                url = f"https://www.surreylibraries.ca{href}"
                seen[href] = {
                    "title": _clean_text(link.get_text()),
                    "description": None,
                    "tags": ["Family & Kids"],
                    "startDate": start.date().isoformat(),
                    "endDate": None,
                    "allDay": False,
                    "timeText": start.strftime("%-I:%M %p") + (f" - {end.strftime('%-I:%M %p')}" if end else ""),
                    "price": _parse_price_text(None),
                    "url": url,
                    "location": {"name": f"Surrey Libraries {branch}".strip(),
                                 "address": f"Surrey Libraries {branch}, Surrey, BC"},
                    "source": source_key,
                    "sourceEventUrl": url,
                    "region": cfg["region"],
                }
    return list(seen.values())


TIME_RANGE_RE = re.compile(r"\b\d{1,2}(:\d{2})?\s*(am|pm)\b.*?\d{1,2}(:\d{2})?\s*(am|pm)\b", re.IGNORECASE)


def _parse_port_coquitlam(source_key, cfg):
    """PoCo's community calendar is a Drupal calendar-view: each month page lists
    events as `li.calendar-view-day__row` (one per day a multi-day event spans),
    and `?calendar_timestamp=<unix month start>` pages between months. The
    daily "City Hall Illumination" lighting notices are skipped as noise."""
    session = requests.Session()
    session.headers.update(HEADERS)
    today = datetime.now(PACIFIC_TZ).date()
    month = today.replace(day=1)
    seen = {}
    for _ in range(4):  # this month + next 3
        ts = int(datetime(month.year, month.month, 1, tzinfo=PACIFIC_TZ).timestamp())
        try:
            resp = session.get(
                cfg["url"],
                params={"calendar_timestamp": ts, "date_format": "custom", "date_pattern": "F",
                        "use_previous_next": 1, "display_reset": 1, "pager_type": "calendar_month"},
                timeout=20,
            )
            resp.raise_for_status()
        except Exception:
            resp = None
        month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
        if resp is None:
            continue
        soup = BeautifulSoup(resp.text, "html.parser")
        for row in soup.select("li.calendar-view-day__row"):
            link = row.select_one(".views-field-title a[href]")
            times = row.select(".views-field-field-when time[datetime]")
            if not link or not times:
                continue
            title = _clean_text(link.get_text())
            if not title or title.lower().startswith("city hall illumination"):
                continue
            href = link["href"]
            if href in seen:
                continue
            try:
                start = datetime.fromisoformat(times[0]["datetime"])
                end = datetime.fromisoformat(times[-1]["datetime"])
            except ValueError:
                continue
            if end.date() < today:
                continue
            all_day = (start.hour, start.minute) == (0, 0) or (end - start) >= timedelta(hours=23)
            seen[href] = {
                "title": title,
                "description": None,
                "tags": [],
                "startDate": start.date().isoformat(),
                "endDate": end.date().isoformat() if end.date() != start.date() else None,
                "allDay": all_day,
                "timeText": None if all_day else start.strftime("%-I:%M %p"),
                "price": _parse_price_text(None),
                "url": f"https://www.portcoquitlam.ca{href}",
                "location": None,
                "source": source_key,
                "sourceEventUrl": f"https://www.portcoquitlam.ca{href}",
                "region": cfg["region"],
            }
    return list(seen.values())


JSONLD_DATETIME_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2}))?")


def _parse_jsonld_local_datetime(raw):
    """Tourism Burnaby's JSON-LD emits non-zero-padded, offset-suffixed
    datetimes (e.g. "2026-9-4T15:00-7:00") that stdlib isoformat parsing
    rejects. The offset always matches BC local time here, so we just read
    the date/time fields as-is rather than doing real timezone math."""
    if not raw:
        return None, None
    match = JSONLD_DATETIME_RE.match(raw)
    if not match:
        return None, None
    y, mo, d, h, mi = match.groups()
    date_obj = datetime(int(y), int(mo), int(d)).date()
    time_text = datetime(int(y), int(mo), int(d), int(h), int(mi)).strftime("%-I:%M %p") if h else None
    return date_obj, time_text


def _parse_tourism_burnaby(source_key, cfg):
    """Tourism Burnaby (WordPress + EventON) embeds a full JSON-LD Event block
    per listing directly in the events page - no per-event fetch needed. It
    never includes `offers`/price though, so cost is best-effort parsed out
    of the description text instead."""
    soup = _fetch_html(cfg["url"])
    today = datetime.now().date()
    events = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue
        if not isinstance(data, dict) or data.get("@type") != "Event":
            continue
        try:
            start_date, time_text = _parse_jsonld_local_datetime(data.get("startDate"))
            end_date, _ = _parse_jsonld_local_datetime(data.get("endDate"))
            if not start_date or start_date < today - timedelta(days=1):
                continue

            desc_text = _clean_text(BeautifulSoup(data.get("description") or "", "html.parser").get_text(" "))
            price_match = re.search(r"\$[\d,.]+", desc_text)
            price = _parse_price_text(price_match.group(0)) if price_match else _parse_price_text(None)

            locations = data.get("location")
            place = (locations[0] if isinstance(locations, list) else locations) or {}
            address = (place.get("address") or {}).get("streetAddress")

            events.append({
                "title": _clean_text(data.get("name", "")),
                "description": desc_text[:600] or None,
                "tags": [],
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat() if end_date and end_date != start_date else None,
                "allDay": time_text is None,
                "timeText": time_text,
                "price": price,
                "url": data.get("url") or cfg["url"],
                "location": {"name": _clean_text(place.get("name", "")), "address": _clean_text(address or "")} if place else None,
                "source": source_key,
                "sourceEventUrl": data.get("url"),
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


DESTINATION_VANCOUVER_API = "https://flus6j8v.apicdn.sanity.io/v2023-05-03/data/query/production"
DESTINATION_VANCOUVER_QUERY = (
    '*[_type=="event" && endDate>="@TODAY" && nextDate<="@HORIZON"]'
    '{title,venue,address,categories,isFree,price,bookingLink,website,nextDate,endDate,longTerm,'
    '"lat":location.geopoint.lat,"lng":location.geopoint.lng,"slug":slug.current,'
    '"description":pt::text(richTextDescription)}'
)


def _parse_destination_vancouver(source_key, cfg):
    """The calendar page renders client-side with no JSON-LD, so there's nothing
    to scrape from the HTML. The site is a Next.js app on a Sanity CMS whose
    public read API (the same one the page uses) returns every listed `event`
    document with coordinates, so we query that for the next ~4 months."""
    today = datetime.now(PACIFIC_TZ).date()
    query = (DESTINATION_VANCOUVER_QUERY
             .replace("@TODAY", today.isoformat())
             .replace("@HORIZON", (today + timedelta(days=120)).isoformat()))
    resp = requests.get(DESTINATION_VANCOUVER_API, params={"query": query}, headers=HEADERS, timeout=30)
    resp.raise_for_status()

    def local(raw):
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(PACIFIC_TZ)

    events = []
    for item in resp.json().get("result") or []:
        try:
            title = _clean_text(item.get("title") or "")
            if not title or not item.get("nextDate"):
                continue
            start = local(item["nextDate"])
            end = local(item["endDate"]) if item.get("endDate") else start
            # Long-running listings (exhibitions, seasonal markets) span weeks; a
            # single occurrence is shown as that day only.
            multi_day = bool(item.get("longTerm")) and end.date() > start.date()
            address = item.get("address") or {}
            venue = _clean_text(item.get("venue") or "")
            loc = None
            if venue or address.get("formattedAddress"):
                loc = {"name": venue or None, "address": address.get("formattedAddress") or None}
                if item.get("lat") and item.get("lng"):
                    loc["lat"], loc["lng"] = item["lat"], item["lng"]
                    loc["mapsUrl"] = f"https://www.google.com/maps/search/?api=1&query={item['lat']},{item['lng']}"
            price_text = item.get("price")
            if item.get("isFree"):
                price = _parse_price_text(None)
            else:
                price = _parse_price_text(f"${price_text}" if price_text else None)
            price["isFree"] = bool(item.get("isFree"))
            ticket = item.get("bookingLink") or None
            if ticket:
                price["ticketUrl"] = ticket
            slug = item.get("slug")
            event_url = (f"https://www.destinationvancouver.com/events/{slug}" if slug
                         else item.get("website") or cfg["url"])
            events.append({
                "title": title,
                "description": _clean_text(item.get("description") or "")[:600] or None,
                "tags": item.get("categories") or [],
                "startDate": start.date().isoformat(),
                "endDate": end.date().isoformat() if multi_day else None,
                "allDay": False,
                "timeText": start.strftime("%-I:%M %p"),
                "price": price,
                "url": event_url,
                "location": loc,
                "source": source_key,
                "sourceEventUrl": event_url,
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


# ─── Strategy: Metro Vancouver's SharePoint "Calendar" list ──────────────────

METRO_VANCOUVER_PARKS_API = (
    "https://metrovancouver.org/events/_api/web/lists/getbytitle('Calendar')/items"
)
PACIFIC_TZ = ZoneInfo("America/Vancouver")


def _parse_metro_vancouver_parks(source_key, cfg):
    """Metro Vancouver's public events page is a SharePoint site whose "Calendar"
    list is readable anonymously via the REST API. That list also holds
    non-event governance notices (budget consultations, plan amendments), so we
    only keep items tagged with a `Park` taxonomy value - a reliable signal
    for an actual park program rather than a public-notice posting."""
    session = requests.Session()
    session.headers.update(HEADERS)
    session.headers["Accept"] = "application/json;odata=verbose"
    today = datetime.now().date()
    params = {
        "$top": 200,
        "$orderby": "EventStartDate asc",
        "$filter": f"EventStartDate ge datetime'{today.isoformat()}T00:00:00Z'",
        "$select": "Title,Park,Location,EventStartDate,EventEndDate,Description1,Link2,fAllDayEvent",
    }
    resp = session.get(METRO_VANCOUVER_PARKS_API, params=params, timeout=15)
    resp.raise_for_status()
    payload = resp.json()

    events = []
    for item in payload.get("d", {}).get("results", []):
        try:
            if not item.get("Park"):
                continue
            title = _clean_text(item.get("Title", ""))
            start_raw = item.get("EventStartDate")
            if not title or not start_raw:
                continue
            end_raw = item.get("EventEndDate") or start_raw
            start_local = datetime.fromisoformat(start_raw.replace("Z", "+00:00")).astimezone(PACIFIC_TZ)
            end_local = datetime.fromisoformat(end_raw.replace("Z", "+00:00")).astimezone(PACIFIC_TZ)
            start_date, end_date = start_local.date(), end_local.date()

            desc_text = _clean_text(BeautifulSoup(item.get("Description1") or "", "html.parser").get_text(" "))
            price_match = re.search(r"\$[\d,.]+(?:\s*per\s*\w+)?", desc_text)
            price = _parse_price_text(price_match.group(0)) if price_match else _parse_price_text(None)

            link_url = (item.get("Link2") or {}).get("Url")
            all_day = bool(item.get("fAllDayEvent"))

            events.append({
                "title": title,
                "description": desc_text[:600] or None,
                "tags": [],
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat() if end_date != start_date else None,
                "allDay": all_day,
                "timeText": None if all_day else start_local.strftime("%-I:%M %p"),
                "price": price,
                "url": link_url or cfg["url"],
                "location": {"name": item.get("Location"), "address": item.get("Location")} if item.get("Location") else None,
                "source": source_key,
                "sourceEventUrl": link_url,
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]


def _fetch_new_westminster_details(url):
    """The listing page has no description/time/location, but each event's own
    detail page does, in consistently-classed `.display_point` divs."""
    try:
        soup = _fetch_html(url)
        start_time_el = soup.select_one(".start_time")
        location_el = soup.select_one(".location")
        desc_el = soup.select_one(".page-text")
        location_text = _clean_text(location_el.get_text()) if location_el else None
        # Street addresses here (e.g. "920 Twelfth Street") never include a city,
        # so geocoding them as-is can match a same-named street anywhere on earth.
        geocode_text = location_text
        if geocode_text and "new westminster" not in geocode_text.lower():
            geocode_text = f"{geocode_text}, New Westminster, BC"
        return {
            "timeText": _clean_text(start_time_el.get_text()) if start_time_el else None,
            "location": {"name": location_text, "address": geocode_text} if location_text else None,
            "description": _clean_text(desc_el.get_text())[:600] if desc_el else None,
        }
    except Exception:
        return None


def _parse_new_westminster(source_key, cfg):
    """City of New Westminster's calendar listing has no JSON-LD, but each
    event `<li id="events-omni-N">` has clean, consistent child markup (date,
    title/link, cost) we can select directly. Description/time/location live
    only on the per-event detail page, so we fetch that too."""
    soup = _fetch_html(cfg["url"])
    today = datetime.now().date()
    events = []
    for li in soup.select('li[id^="events-omni-"]'):
        try:
            start_month_el = li.select_one(".start.month")
            start_day_el = li.select_one(".start.day")
            year_el = li.select_one(".current-date")
            title_el = li.select_one(".text-group h2.title a")
            if not (start_month_el and start_day_el and year_el and title_el):
                continue

            year = int(_clean_text(year_el.get_text()))
            start_month = MONTH_NAMES.index(_clean_text(start_month_el.get_text())) + 1
            start_day = int(_clean_text(start_day_el.get_text()))
            start_date = datetime(year, start_month, start_day).date()

            end_date = start_date
            end_month_el, end_day_el = li.select_one(".end.month"), li.select_one(".end.day")
            if end_month_el and end_day_el:
                end_month = MONTH_NAMES.index(_clean_text(end_month_el.get_text())) + 1
                end_day = int(_clean_text(end_day_el.get_text()))
                # A date range spanning New Year's Eve is the only case where the
                # end month can be numerically earlier than the start month.
                end_year = year if end_month >= start_month else year + 1
                end_date = datetime(end_year, end_month, end_day).date()
            if end_date < today - timedelta(days=1):
                continue

            title = _clean_text(title_el.get_text())
            url = title_el.get("href")
            cost_el = li.select_one(".cost")
            cost_text = _clean_text(cost_el.get_text()) if cost_el else ""
            price = _parse_price_text(None if cost_text.lower() in ("", "none") else cost_text)

            details = _fetch_new_westminster_details(url) if url else None
            details = details or {}

            events.append({
                "title": title,
                "description": details.get("description"),
                "tags": [],
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat() if end_date != start_date else None,
                "allDay": details.get("timeText") is None,
                "timeText": details.get("timeText"),
                "price": price,
                "url": url,
                "location": details.get("location"),
                "source": source_key,
                "sourceEventUrl": url,
                "region": cfg["region"],
            })
        except Exception:
            continue
    return events


_HTML_PARSERS = {
    "port_moody": _parse_port_moody,
    "port_moody_signature": _parse_port_moody_signature,
    "seasonal_curated": _parse_seasonal_curated,
    "vpl_kids": _parse_vpl_kids,
    "surrey_libraries_kids": _parse_surrey_libraries_kids,
    "port_coquitlam": _parse_port_coquitlam,
    "metro_vancouver_parks": _parse_metro_vancouver_parks,
    "destination_vancouver": _parse_destination_vancouver,
    "tourism_burnaby": _parse_tourism_burnaby,
    "new_westminster": _parse_new_westminster,
}


def _scrape_source(source_key, cfg):
    kind = cfg["kind"]
    if kind == "ics":
        events = _parse_ics(source_key, cfg)
    elif kind == "tribe":
        events = _parse_tribe(source_key, cfg)
    elif kind == "html":
        events = _HTML_PARSERS[source_key](source_key, cfg)
    else:
        raise ValueError(f"Unknown source kind: {kind}")

    for e in events:
        # Geocode any event with a venue but no coordinates yet
        loc = e.get("location")
        if loc and not loc.get("lat"):
            address = loc.get("address") or loc.get("name")
            geo = _geocode(address)
            if geo:
                loc["lat"], loc["lng"] = geo["lat"], geo["lng"]
                loc["mapsUrl"] = f"https://www.google.com/maps/search/?api=1&query={geo['lat']},{geo['lng']}"
        e["city"] = _guess_city(cfg, loc)
        e["tags"] = _standardize_tags(e.get("tags"), e.get("title"), e.get("description"))
    return _dedupe_events(events)


def _dedupe_key(e):
    norm = lambda t: re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()
    loc = e.get("location") or {}
    return (norm(e.get("title")), e.get("startDate"),
            re.sub(r"\s+", "", (e.get("timeText") or "").lower()), norm(loc.get("name")))


def _dedupe_events(events):
    """Drop repeats of the same listing within one source (same title, day,
    time and venue), keeping the first - sources like Tourism Burnaby list an
    event under several categories."""
    seen, unique = set(), []
    for e in events:
        key = _dedupe_key(e)
        if key in seen:
            continue
        seen.add(key)
        unique.append(e)
    return unique


def _upsert_events(events):
    db_client = firestore.client()
    batch = db_client.batch()
    count = 0
    for e in events:
        doc_id = _event_id(e["source"], e.get("sourceEventUrl"), e["title"], e["startDate"])
        ref = db_client.collection("events").document(doc_id)
        batch.set(ref, {**e, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
        count += 1
        if count % 400 == 0:  # Firestore batch limit is 500 writes
            batch.commit()
            batch = db_client.batch()
    if count % 400 != 0:
        batch.commit()
    return count


def _prune_past_events(db_client, cutoff_iso):
    # Firestore doesn't allow inequality filters on two different fields in one
    # query, so filter startDate server-side and exclude manual entries in Python.
    stale = db_client.collection("events").where("startDate", "<", cutoff_iso).stream()
    batch = db_client.batch()
    n = 0
    for doc in stale:
        if doc.get("source") == "manual":
            continue
        batch.delete(doc.reference)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db_client.batch()
    if n % 400 != 0:
        batch.commit()
    return n


@scheduler_fn.on_schedule(schedule="0 3 * * *", region="us-west1", timezone="America/Vancouver")
def prune_past_events(event: scheduler_fn.ScheduledEvent) -> None:
    """Daily cron: delete scraped events whose startDate has already passed."""
    cutoff = (datetime.now().date() - timedelta(days=1)).isoformat()
    _prune_past_events(firestore.client(), cutoff)


def _refresh_sources(requested):
    now = time.time()
    results = {}
    for source_key in requested:
        cfg = EVENT_SOURCES[source_key]
        cached = _events_cache.get(source_key)
        if cached and (now - cached["timestamp"]) < EVENTS_CACHE_TTL:
            results[source_key] = cached["result"]
            continue
        try:
            events = _scrape_source(source_key, cfg)
            count = _upsert_events(events)
            result = {"count": count, "label": cfg["label"]}
        except Exception as e:
            result = {"count": 0, "label": cfg["label"], "error": str(e)}
        results[source_key] = result
        _events_cache[source_key] = {"result": result, "timestamp": now}

    try:
        cutoff = (datetime.now().date() - timedelta(days=1)).isoformat()
        _prune_past_events(firestore.client(), cutoff)
    except Exception:
        pass  # pruning is best-effort; a failure here shouldn't fail the refresh

    return results


@https_fn.on_call(invoker="public", region="us-west1", memory=512, timeout_sec=300)
def refresh_events(req: https_fn.CallableRequest) -> dict:
    """Admin action: re-scrape one or more known sources and upsert into Firestore."""
    requested = (req.data or {}).get("sources") or list(EVENT_SOURCES.keys())
    unknown = [s for s in requested if s not in EVENT_SOURCES]
    if unknown:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message=f"Unknown source(s): {', '.join(unknown)}",
        )
    return {"results": _refresh_sources(requested)}


@scheduler_fn.on_schedule(schedule="0 4 * * *", region="us-west1", timezone="America/Vancouver",
                           memory=512, timeout_sec=540)
def scheduled_refresh_events(event: scheduler_fn.ScheduledEvent) -> None:
    """Daily cron: re-scrape every known source. Replaces the old admin
    "Manage sources" UI as the only way events stay up to date now."""
    _refresh_sources(list(EVENT_SOURCES.keys()))


@https_fn.on_call(invoker="public", region="us-west1", memory=512, timeout_sec=60)
def scrape_events(req: https_fn.CallableRequest) -> dict:
    """Admin action: scrape an ad hoc source URL not yet in the registry.

    Tries, in order: an .ics feed, a "The Events Calendar" REST endpoint,
    then falls back to generic JSON-LD Event extraction from the page HTML.
    """
    source_key = (req.data or {}).get("source_key", "").strip()
    url = (req.data or {}).get("url", "").strip()
    if not source_key or not url:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="source_key and url are required",
        )

    cfg = {"label": source_key, "url": url, "region": "metro-vancouver"}
    events = []
    try:
        if url.lower().endswith(".ics") or "ical" in url.lower():
            events = _parse_ics(source_key, cfg)
        elif "wp-json/tribe/events" in url:
            events = _parse_tribe(source_key, cfg)
        else:
            soup = _fetch_html(url)
            events = [{**e, "source": source_key, "region": cfg["region"]}
                      for e in _extract_jsonld_events(soup, url)]
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not scrape source: {e}",
        )

    if not events:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.NOT_FOUND,
            message="No events found at this URL (tried .ics, Events Calendar API, and JSON-LD).",
        )

    for e in events:
        loc = e.get("location")
        if loc and not loc.get("lat"):
            geo = _geocode(loc.get("address") or loc.get("name"))
            if geo:
                loc["lat"], loc["lng"] = geo["lat"], geo["lng"]
                loc["mapsUrl"] = f"https://www.google.com/maps/search/?api=1&query={geo['lat']},{geo['lng']}"

    count = _upsert_events(events)
    return {"count": count, "source_key": source_key}


# ─── Price Tracker ────────────────────────────────────────────────────────────
#
# Watches product pages (single item) or retailer listing/brand pages
# (category watch, e.g. "any Thule roof box") for price drops and emails
# PRICE_ALERT_TO when the tracked lowest price beats both the watch's
# baseline and the last price we already alerted on.
#
# Most big-box retailers (MEC, Canadian Tire, Amazon, SportChek) block plain
# server-side requests outright, so fetching routes through ScraperAPI for
# domains flagged `proxy: True` below, or as a fallback when a direct fetch
# comes back 403/429/503. Smaller/Shopify-style sites (Thule.com, TDot
# Performance, Altitude Sports, Rack Attack) serve clean HTML directly.

PRICE_RETAILERS = {
    "mec.ca": {"label": "MEC", "proxy": True},
    "canadiantire.ca": {"label": "Canadian Tire", "proxy": True},
    "amazon.ca": {"label": "Amazon.ca", "proxy": True},
    "sportchek.ca": {"label": "SportChek", "proxy": True},
    "atmosphere.ca": {"label": "Atmosphere", "proxy": True},
    "walmart.ca": {"label": "Walmart.ca", "proxy": True},
    "thule.com": {"label": "Thule", "proxy": False},
    "tdotperformance.ca": {"label": "TDot Performance", "proxy": False},
    "altitude-sports.com": {"label": "Altitude Sports", "proxy": False},
    "rackattack.ca": {"label": "Rack Attack", "proxy": False},
}

SCRAPERAPI_KEY = os.environ.get("SCRAPERAPI_KEY")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
PRICE_ALERT_FROM = os.environ.get("PRICE_ALERT_FROM")
PRICE_ALERT_TO = os.environ.get("PRICE_ALERT_TO")

PRICE_RE = re.compile(r"\$?\s*([\d,]+\.\d{2}|\d{1,3}(?:,\d{3})*|\d+)")


def _retailer_for(url):
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    for domain, cfg in PRICE_RETAILERS.items():
        if host == domain or host.endswith("." + domain):
            return domain, cfg
    return host, {"label": host, "proxy": False}


def _fetch_price_html(url, force_proxy=False):
    """Fetch a product/listing page, routing through ScraperAPI when the
    retailer is known to block direct requests or a direct attempt is
    blocked. Returns (html, used_proxy); raises with a short reason on
    total failure so the caller can record it in `lastErrors`."""
    domain, cfg = _retailer_for(url)
    use_proxy_first = force_proxy or cfg.get("proxy")

    def via_proxy():
        if not SCRAPERAPI_KEY:
            raise RuntimeError("blocked and no SCRAPERAPI_KEY configured")
        resp = requests.get(
            "https://api.scraperapi.com/",
            params={"api_key": SCRAPERAPI_KEY, "url": url, "country_code": "ca"},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.text

    if use_proxy_first:
        return via_proxy(), True

    try:
        session = requests.Session()
        session.headers.update(HEADERS)
        resp = session.get(url, timeout=15)
        if resp.status_code in (403, 429, 503):
            raise requests.HTTPError(f"{resp.status_code} blocked")
        resp.raise_for_status()
        return resp.text, False
    except Exception:
        return via_proxy(), True


def _parse_money(text):
    if not text:
        return None
    match = PRICE_RE.search(text.replace(",", ""))
    if not match:
        return None
    try:
        value = float(match.group(1))
        return value if 0 < value < 100000 else None
    except ValueError:
        return None


def _extract_jsonld_offers(soup, base_url):
    """Walk schema.org Product/Offer JSON-LD blocks, same traversal shape as
    `_extract_jsonld_events`, and return a list of {title, price, url}."""
    offers = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue
        candidates = data if isinstance(data, list) else [data]
        for node in candidates:
            graph = node.get("@graph") if isinstance(node, dict) else None
            for item in (graph if graph else [node]):
                if not isinstance(item, dict):
                    continue
                types = item.get("@type")
                types = [types] if isinstance(types, str) else (types or [])
                if not any("Product" in t for t in types):
                    continue
                offer = item.get("offers")
                if isinstance(offer, list):
                    offer = offer[0] if offer else None
                if not isinstance(offer, dict):
                    continue
                price = _parse_money(str(offer.get("price") or offer.get("lowPrice") or ""))
                if price is None:
                    continue
                offers.append({
                    "title": _clean_text(item.get("name", "")),
                    "price": price,
                    "url": offer.get("url") or item.get("url") or base_url,
                })
    return offers


def _extract_meta_offer(soup, base_url):
    """Fallback for pages with a single product and og:/product: meta price
    tags but no (or malformed) JSON-LD."""
    for prop in ("product:price:amount", "og:price:amount"):
        meta = soup.find("meta", attrs={"property": prop})
        if meta and meta.get("content"):
            price = _parse_money(meta["content"])
            if price is not None:
                title_meta = soup.find("meta", attrs={"property": "og:title"})
                title = _clean_text(title_meta["content"]) if title_meta and title_meta.get("content") else _clean_text(soup.title.get_text() if soup.title else "")
                return [{"title": title, "price": price, "url": base_url}]
    price_meta = soup.find(attrs={"itemprop": "price"})
    if price_meta:
        price = _parse_money(price_meta.get("content") or price_meta.get_text())
        if price is not None:
            title = _clean_text(soup.title.get_text()) if soup.title else ""
            return [{"title": title, "price": price, "url": base_url}]
    return []


def _extract_card_offers(soup, base_url):
    """Generic fallback for listing/brand pages: schema.org Product JSON-LD
    almost never appears on a *listing* page (only per-product detail pages),
    so instead walk every element whose class name contains "price", read a
    dollar amount out of it, then climb to the nearest ancestor holding a
    product `<a href>` for the title/url. Works across the common Magento/
    Shopify/BigCommerce card markup without a retailer-specific parser.
    Callers must filter the (noisy) results by matchTerms/excludeTerms."""
    from urllib.parse import urljoin
    generic_link_text = {
        "learn more", "view", "quick view", "add to cart", "shop now",
        "buy now", "details", "select options", "compare", "add to compare",
    }

    def link_title(link):
        text = _clean_text(link.get_text(strip=True))
        if text and text.lower() not in generic_link_text:
            return text
        img = link.find("img")
        if img and img.get("alt"):
            return _clean_text(img["alt"])
        title_attr = link.get("title")
        return _clean_text(title_attr) if title_attr else ""

    offers, seen_urls = [], set()
    for price_el in soup.select('[class*="price" i]'):
        price = _parse_money(price_el.get_text())
        if price is None:
            continue
        # Climb until we find an ancestor holding a real (non-CTA) product link,
        # since the nearest <a> to a price is often a generic "Learn More" button.
        container, best_link, best_title = price_el, None, ""
        for _ in range(6):
            if container is None:
                break
            for link in container.find_all("a", href=True):
                title = link_title(link)
                if title:
                    best_link, best_title = link, title
                    break
            if best_link:
                break
            container = container.parent
        if not best_link:
            continue
        url = urljoin(base_url, best_link["href"])
        if url in seen_urls:
            continue
        seen_urls.add(url)
        offers.append({"title": best_title, "price": price, "url": url})
    return offers


def _extract_offers(html_text, base_url, kind="product"):
    """Best-effort product offer extraction. Product pages try structured
    data first (JSON-LD, then meta/itemprop price tags), falling back to the
    generic card scan. Listing pages go straight to the card scan, since
    structured Product data is rarely present on a listing/brand page."""
    soup = BeautifulSoup(html_text, "html.parser")
    if kind == "listing":
        return _extract_card_offers(soup, base_url)
    offers = _extract_jsonld_offers(soup, base_url)
    if offers:
        return offers
    offers = _extract_meta_offer(soup, base_url)
    if offers:
        return offers
    return _extract_card_offers(soup, base_url)


def _matches_terms(title, match_terms, exclude_terms):
    lower = (title or "").lower()
    if match_terms and not all(t.lower() in lower for t in match_terms):
        return False
    if exclude_terms and any(t.lower() in lower for t in exclude_terms):
        return False
    return True


def _check_source(source, match_terms, exclude_terms):
    """Fetch one watch source and return (offers, error). `offers` is a list
    of {retailer, title, price, url}; for a listing page this can be many,
    filtered by matchTerms/excludeTerms; for a product page it's normally one."""
    domain, cfg = _retailer_for(source["url"])
    try:
        html_text, _used_proxy = _fetch_price_html(source["url"])
        raw_offers = _extract_offers(html_text, source["url"], source.get("kind", "product"))
        if not raw_offers:
            return [], "No price found on page"
        offers = [
            {"retailer": cfg["label"], "title": o["title"], "price": o["price"], "url": o["url"]}
            for o in raw_offers
            if source.get("kind") != "listing" or _matches_terms(o["title"], match_terms, exclude_terms)
        ]
        if not offers:
            return [], "No matching products found"
        return offers, None
    except Exception as e:
        return [], str(e)


def _check_watch(db_client, watch_id, watch):
    sources = watch.get("sources") or []
    match_terms = watch.get("matchTerms") or []
    exclude_terms = watch.get("excludeTerms") or []

    all_offers, errors = [], {}
    for source in sources:
        offers, error = _check_source(source, match_terms, exclude_terms)
        all_offers.extend(offers)
        if error:
            errors[source["retailer"]] = error

    watch_ref = db_client.collection("price_watches").document(watch_id)
    now = datetime.now(ZoneInfo("America/Vancouver"))
    today_iso = now.date().isoformat()

    if not all_offers:
        watch_ref.set({"lastCheckedAt": firestore.SERVER_TIMESTAMP, "lastErrors": errors}, merge=True)
        return None

    lowest = min(all_offers, key=lambda o: o["price"])
    watch_ref.collection("history").document(today_iso).set({
        "date": today_iso,
        "lowest": lowest,
        "offers": all_offers,
    })

    updates = {
        "lowestNow": {**lowest, "checkedAt": firestore.SERVER_TIMESTAMP},
        "lastCheckedAt": firestore.SERVER_TIMESTAMP,
        "lastErrors": errors,
    }
    all_time_low = watch.get("allTimeLow")
    if not all_time_low or lowest["price"] < all_time_low["price"]:
        updates["allTimeLow"] = {**lowest, "date": today_iso}
    watch_ref.set(updates, merge=True)

    baseline = watch.get("baselinePrice")
    target = watch.get("targetPrice")
    last_notified = watch.get("lastNotifiedPrice")
    should_alert = (
        baseline is not None and lowest["price"] < baseline
        and (last_notified is None or lowest["price"] < last_notified)
        and (target is None or lowest["price"] <= target)
    )
    if should_alert:
        watch_ref.set({"lastNotifiedPrice": lowest["price"]}, merge=True)
        return {"watchName": watch.get("name"), "baseline": baseline, **lowest}
    return None


def _send_price_email(drops):
    if not (RESEND_API_KEY and PRICE_ALERT_FROM and PRICE_ALERT_TO):
        return
    rows = "".join(
        f"<tr><td style='padding:8px 12px;border-bottom:1px solid #e8e2da'>{d['watchName']}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #e8e2da'>{d['retailer']}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #e8e2da'>${d['baseline']:.2f} → ${d['price']:.2f}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #e8e2da'><a href='{d['url']}'>View</a></td></tr>"
        for d in drops
    )
    html_body = (
        "<h2>Price drop alert</h2>"
        "<table style='border-collapse:collapse;font-family:sans-serif;font-size:14px'>"
        "<tr><th align='left' style='padding:8px 12px'>Item</th><th align='left' style='padding:8px 12px'>Retailer</th>"
        "<th align='left' style='padding:8px 12px'>Price</th><th align='left' style='padding:8px 12px'></th></tr>"
        f"{rows}</table>"
    )
    try:
        requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
            json={
                "from": PRICE_ALERT_FROM,
                "to": [PRICE_ALERT_TO],
                "subject": f"Price drop: {len(drops)} item(s) cheaper",
                "html": html_body,
            },
            timeout=15,
        )
    except Exception:
        pass  # best-effort; failures here shouldn't break the price check


def _check_all_watches():
    db_client = firestore.client()
    watches = db_client.collection("price_watches").where("active", "==", True).stream()
    drops = []
    for doc in watches:
        result = _check_watch(db_client, doc.id, doc.to_dict())
        if result:
            drops.append(result)
    if drops:
        _send_price_email(drops)
    return len(drops)


@scheduler_fn.on_schedule(schedule="0 8 * * *", region="us-west1", timezone="America/Vancouver",
                           memory=512, timeout_sec=540)
def scheduled_check_prices(event: scheduler_fn.ScheduledEvent) -> None:
    """Daily cron: re-check every active price watch and email on drops."""
    _check_all_watches()


@https_fn.on_call(invoker="public", region="us-west1", memory=512, timeout_sec=300)
def check_prices_now(req: https_fn.CallableRequest) -> dict:
    """Admin action: re-check one watch (or all, if watchId is omitted)."""
    watch_id = (req.data or {}).get("watchId")
    db_client = firestore.client()
    if watch_id:
        ref = db_client.collection("price_watches").document(watch_id)
        snap = ref.get()
        if not snap.exists:
            raise https_fn.HttpsError(
                code=https_fn.FunctionsErrorCode.NOT_FOUND, message="Watch not found",
            )
        result = _check_watch(db_client, watch_id, snap.to_dict())
        if result:
            _send_price_email([result])
        return {"checked": 1, "dropped": 1 if result else 0}
    return {"checked": None, "dropped": _check_all_watches()}


@https_fn.on_call(invoker="public", region="us-west1", memory=512, timeout_sec=60)
def preview_price_source(req: https_fn.CallableRequest) -> dict:
    """Admin action: validate a URL for the add-watch form before saving,
    returning the retailer label plus whatever offer(s) were found so the
    baseline price can be set from a real result."""
    data = req.data or {}
    url = (data.get("url") or "").strip()
    kind = data.get("kind", "product")
    match_terms = data.get("matchTerms") or []
    exclude_terms = data.get("excludeTerms") or []
    if not url:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="url is required",
        )

    domain, cfg = _retailer_for(url)
    offers, error = _check_source({"url": url, "retailer": cfg["label"], "kind": kind}, match_terms, exclude_terms)
    if error:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE, message=error,
        )
    lowest = min(offers, key=lambda o: o["price"])
    return {"retailer": cfg["label"], "offerCount": len(offers), **lowest}


TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY")


def _tavily_search(query, include_domains=None, max_results=8):
    body = {"api_key": TAVILY_API_KEY, "query": query, "max_results": max_results}
    if include_domains:
        body["include_domains"] = include_domains
    resp = requests.post("https://api.tavily.com/search", json=body, timeout=15)
    resp.raise_for_status()
    return resp.json().get("results", [])


@https_fn.on_call(invoker="public", region="us-west1", memory=256, timeout_sec=30)
def find_retailer_sources(req: https_fn.CallableRequest) -> dict:
    """Admin action: search the web for retailer pages that might sell the
    named item, biased toward the retailers already in PRICE_RETAILERS but
    not limited to them (good sources are item-dependent). Returns candidate
    links only - no price fetch here, that's the existing per-row "Test"
    button (preview_price_source), so this stays fast and cheap."""
    data = req.data or {}
    name = (data.get("name") or "").strip()
    match_terms = data.get("matchTerms") or []
    if not name:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="name is required",
        )
    if not TAVILY_API_KEY:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="TAVILY_API_KEY is not configured on the server.",
        )

    query = " ".join([name, *match_terms, "buy canada"])
    try:
        known_results = _tavily_search(query, include_domains=list(PRICE_RETAILERS.keys()))
        general_results = _tavily_search(query)
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE, message=f"Search failed: {e}",
        )

    candidates, seen_domains = [], set()
    for result in known_results + general_results:
        url = result.get("url")
        if not url:
            continue
        domain, cfg = _retailer_for(url)
        if domain in seen_domains:
            continue
        seen_domains.add(domain)
        candidates.append({
            "title": result.get("title") or cfg["label"],
            "url": url,
            "domain": domain,
            "retailer": cfg["label"],
            "known": domain in PRICE_RETAILERS,
        })
        if len(candidates) >= 8:
            break

    return {"candidates": candidates}


# ─── Places Autocomplete Proxy ────────────────────────────────────────────────
#
# Keeps the Google Maps API key server-side only. The frontend calls these
# instead of loading the Maps JavaScript SDK (which would embed the key in
# every page load). Uses the Places API (New) REST endpoints.

PLACES_API_BASE = "https://places.googleapis.com/v1"


def _extract_country(address_components):
    """Pull the ISO 3166-1 alpha-2 country code out of a Places API (New)
    addressComponents list, so callers can filter out cross-border results
    (e.g. a Detroit search circle spilling across the river into Windsor)."""
    for comp in address_components or []:
        if "country" in (comp.get("types") or []):
            return comp.get("shortText")
    return None


@https_fn.on_call(invoker="public", region="us-west1")
def places_autocomplete(req: https_fn.CallableRequest) -> dict:
    input_text = (req.data or {}).get("input", "").strip()
    if not input_text:
        return {"predictions": []}
    if not GOOGLE_MAPS_API_KEY:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="GOOGLE_MAPS_API_KEY is not configured on the server.",
        )

    # Recommendations/Events default to Canada-only results; City Walk Planner
    # passes an explicit (possibly empty) list to search worldwide.
    region_codes = (req.data or {}).get("regionCodes", ["ca"])

    request_body = {"input": input_text}
    if region_codes:
        request_body["includedRegionCodes"] = region_codes

    try:
        resp = requests.post(
            f"{PLACES_API_BASE}/places:autocomplete",
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY},
            json=request_body,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Autocomplete request failed: {e}",
        )

    predictions = []
    for s in data.get("suggestions", []):
        pred = s.get("placePrediction")
        if not pred:
            continue
        predictions.append({
            "place_id": pred.get("placeId"),
            "description": (pred.get("text") or {}).get("text", ""),
        })
    return {"predictions": predictions}


@https_fn.on_call(invoker="public", region="us-west1")
def place_details(req: https_fn.CallableRequest) -> dict:
    place_id = (req.data or {}).get("placeId", "").strip()
    if not place_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="placeId is required",
        )
    if not GOOGLE_MAPS_API_KEY:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="GOOGLE_MAPS_API_KEY is not configured on the server.",
        )

    try:
        resp = requests.get(
            f"{PLACES_API_BASE}/places/{place_id}",
            headers={
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": (
                    "location,formattedAddress,displayName,googleMapsUri,addressComponents,"
                    "rating,userRatingCount,regularOpeningHours.weekdayDescriptions,"
                    "editorialSummary,primaryTypeDisplayName"
                ),
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Place details request failed: {e}",
        )

    location = data.get("location") or {}
    return {
        "lat": location.get("latitude"),
        "lng": location.get("longitude"),
        "address": data.get("formattedAddress"),
        "name": (data.get("displayName") or {}).get("text"),
        "mapsUrl": data.get("googleMapsUri"),
        "country": _extract_country(data.get("addressComponents")),
        "rating": data.get("rating"),
        "ratingCount": data.get("userRatingCount"),
        "hours": (data.get("regularOpeningHours") or {}).get("weekdayDescriptions"),
        "description": (data.get("editorialSummary") or {}).get("text"),
        "categoryLabel": (data.get("primaryTypeDisplayName") or {}).get("text"),
    }


# ─── City Walk Planner: POI search + directions proxy ─────────────────────────
#
# Same server-side-key pattern as the autocomplete/details proxies above.

@https_fn.on_call(invoker="public", region="us-west1")
def nearby_places(req: https_fn.CallableRequest) -> dict:
    data = req.data or {}
    lat, lng = data.get("lat"), data.get("lng")
    included_types = data.get("includedTypes") or []
    radius = data.get("radius", 1500)
    max_results = data.get("maxResultCount", 15)

    if lat is None or lng is None or not included_types:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="lat, lng, and includedTypes are required",
        )
    if not GOOGLE_MAPS_API_KEY:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="GOOGLE_MAPS_API_KEY is not configured on the server.",
        )

    try:
        resp = requests.post(
            f"{PLACES_API_BASE}/places:searchNearby",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": (
                    "places.id,places.displayName,places.location,places.rating,"
                    "places.userRatingCount,places.types,places.googleMapsUri,places.primaryType,"
                    "places.addressComponents,places.regularOpeningHours.weekdayDescriptions,"
                    "places.editorialSummary,places.primaryTypeDisplayName"
                ),
            },
            json={
                "includedTypes": included_types,
                "maxResultCount": max_results,
                "locationRestriction": {
                    "circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius}
                },
            },
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json()
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Nearby search failed: {e}",
        )

    places = []
    for p in result.get("places", []):
        loc = p.get("location") or {}
        places.append({
            "placeId": p.get("id"),
            "name": (p.get("displayName") or {}).get("text"),
            "lat": loc.get("latitude"),
            "lng": loc.get("longitude"),
            "rating": p.get("rating"),
            "ratingCount": p.get("userRatingCount"),
            "types": p.get("types", []),
            "primaryType": p.get("primaryType"),
            "mapsUrl": p.get("googleMapsUri"),
            "country": _extract_country(p.get("addressComponents")),
            "hours": (p.get("regularOpeningHours") or {}).get("weekdayDescriptions"),
            "description": (p.get("editorialSummary") or {}).get("text"),
            "categoryLabel": (p.get("primaryTypeDisplayName") or {}).get("text"),
        })
    return {"places": places}


@https_fn.on_call(invoker="public", region="us-west1")
def walk_directions(req: https_fn.CallableRequest) -> dict:
    data = req.data or {}
    origin, destination = data.get("origin"), data.get("destination")
    intermediates = data.get("intermediates") or []
    mode = data.get("mode", "WALK")
    optimize = bool(data.get("optimize", False))

    if not origin or not destination:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="origin and destination are required",
        )
    if not GOOGLE_MAPS_API_KEY:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="GOOGLE_MAPS_API_KEY is not configured on the server.",
        )

    def waypoint(p):
        return {"location": {"latLng": {"latitude": p["lat"], "longitude": p["lng"]}}}

    body = {
        "origin": waypoint(origin),
        "destination": waypoint(destination),
        "intermediates": [waypoint(p) for p in intermediates],
        "travelMode": mode,
        "optimizeWaypointOrder": optimize,
    }

    try:
        resp = requests.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": (
                    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,"
                    "routes.legs.duration,routes.legs.distanceMeters,"
                    "routes.optimizedIntermediateWaypointIndex"
                ),
            },
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.json()
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Directions request failed: {e}",
        )

    routes = result.get("routes") or []
    if not routes:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.NOT_FOUND,
            message="No route found between the given stops.",
        )
    route = routes[0]

    def parse_duration(d):
        # Routes API durations are strings like "123s"
        return int(str(d or "0s").rstrip("s") or 0)

    return {
        "durationSec": parse_duration(route.get("duration")),
        "distanceMeters": route.get("distanceMeters", 0),
        "encodedPolyline": (route.get("polyline") or {}).get("encodedPolyline"),
        "legs": [
            {"durationSec": parse_duration(leg.get("duration")), "distanceMeters": leg.get("distanceMeters", 0)}
            for leg in route.get("legs", [])
        ],
        "order": route.get("optimizedIntermediateWaypointIndex"),
    }


# ─── Podcast episode audio (Better Spotify feed player) ───────────────────────
#
# Finds a Spotify podcast episode in the show's public RSS feed (via the iTunes
# directory) and returns its audio file URL, so the page can play it in a plain
# <audio> element with speed control and lock-screen controls. Spotify-exclusive
# shows have no feed; the page falls back to Spotify playback when url is None.
#
# Some hosts (e.g. the BBC's) only serve the final audio over http, which an https
# page can't play; those are returned as a signed podcast_audio_proxy link instead.

_ITUNES_NS = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
_FEED_TTL_S = 1800
_feed_cache = {}  # feed_url -> (fetched_at, items); per function instance
_FEED_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; DavesWorld/1.0; podcast player)"}
_PROXY_URL = "https://us-west1-daves-world-32.cloudfunctions.net/podcast_audio_proxy"


def _norm_title(text):
    text = html.unescape(text or "").lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _itunes_duration_s(text):
    """'1:02:03', '62:03' or '3723' -> seconds (None if unparseable)."""
    try:
        parts = [float(p) for p in (text or "").strip().split(":")]
    except ValueError:
        return None
    if not parts or len(parts) > 3:
        return None
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def _find_podcast_feed(show, publisher):
    resp = requests.get(
        "https://itunes.apple.com/search",
        params={"media": "podcast", "entity": "podcast", "term": show, "limit": 10},
        timeout=10,
    )
    resp.raise_for_status()
    target, pub = _norm_title(show), _norm_title(publisher)

    def score(result):
        name = _norm_title(result.get("collectionName"))
        s = 0
        if name == target:
            s += 3
        elif name and (target in name or name in target):
            s += 1
        if pub and _norm_title(result.get("artistName")) == pub:
            s += 1
        return s

    results = [r for r in resp.json().get("results", []) if r.get("feedUrl")]
    best = max(results, key=score, default=None)
    return best["feedUrl"] if best and score(best) > 0 else None


def _feed_episodes(feed_url):
    hit = _feed_cache.get(feed_url)
    if hit and time.time() - hit[0] < _FEED_TTL_S:
        return hit[1]
    resp = requests.get(feed_url, headers=_FEED_HEADERS, timeout=20)
    resp.raise_for_status()
    root = ElementTree.fromstring(resp.content)
    items = []
    for it in root.iter("item"):
        enc = it.find("enclosure")
        url = enc.get("url") if enc is not None else None
        if not url:
            continue
        try:
            date = email.utils.parsedate_to_datetime(it.findtext("pubDate")).date()
        except (TypeError, ValueError):
            date = None
        items.append({
            "title": it.findtext("title") or "",
            # https pages can't play http audio; most hosts serve both.
            "url": re.sub(r"^http://", "https://", url.strip()),
            "date": date,
            "duration": _itunes_duration_s(it.findtext(_ITUNES_NS + "duration")),
        })
    _feed_cache[feed_url] = (time.time(), items)
    return items


def _match_episode(items, title, release_date, duration_s):
    target = _norm_title(title)
    try:
        day = datetime.strptime(release_date, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        day = None
    best, best_score = None, 0
    for it in items:
        name = _norm_title(it["title"])
        s = 0
        if name == target:
            s += 10
        elif target and name and min(len(name), len(target)) >= 12 and (name in target or target in name):
            s += 6
        if day and it["date"] and abs((it["date"] - day).days) <= 1:
            s += 3
        if duration_s and it["duration"] and abs(it["duration"] - duration_s) <= 90:
            s += 2
        if s > best_score:
            best, best_score = it, s
    # A title match, or (when titles differ between Spotify and the feed) same day + same length.
    return best if best_score >= 5 else None


@https_fn.on_call(invoker="public", region="us-west1", memory=256, timeout_sec=30)
def podcast_episode_audio(req: https_fn.CallableRequest) -> dict:
    data = req.data or {}
    show = (data.get("show") or "").strip()
    title = (data.get("title") or "").strip()
    if not show or not title:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="show and title are required",
        )
    try:
        feed_url = _find_podcast_feed(show, data.get("publisher") or "")
        if not feed_url:
            return {"url": None, "reason": "no feed"}
        duration_ms = data.get("durationMs") or 0
        match = _match_episode(
            _feed_episodes(feed_url), title, data.get("releaseDate") or "",
            duration_ms / 1000 if duration_ms else None,
        )
    except (requests.RequestException, ElementTree.ParseError) as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not read the podcast feed: {e}",
        )
    if not match:
        return {"url": None, "reason": "no matching episode"}
    url = match["url"]
    if _needs_proxy(url):
        url = f"{_PROXY_URL}?{urlencode({'u': url, 's': _proxy_sig(url)})}"
    return {"url": url}


def _proxy_sig(url):
    key = os.environ.get("PODCAST_PROXY_SECRET", "").encode()
    return hmac.new(key, url.encode(), hashlib.sha256).hexdigest()


def _needs_proxy(url):
    """True if following the URL's redirects lands on (or passes through) plain http."""
    try:
        resp = requests.get(url, headers={**_FEED_HEADERS, "Range": "bytes=0-0"},
                            stream=True, allow_redirects=True, timeout=10)
        resp.close()
    except requests.RequestException:
        return False  # let the browser try it directly
    hops = [h.headers.get("Location", "") for h in resp.history] + [resp.url]
    return any(h.startswith("http://") for h in hops)


# Streams http-only podcast audio to the page over https. Only signed links (made by
# podcast_episode_audio) are served, so this isn't an open proxy. Range requests are
# passed through so the player can seek.
@https_fn.on_request(region="us-west1", memory=256, timeout_sec=3600)
def podcast_audio_proxy(req: https_fn.Request) -> https_fn.Response:
    url = req.args.get("u", "")
    if not url.startswith("https://") or not hmac.compare_digest(req.args.get("s", ""), _proxy_sig(url)):
        return https_fn.Response("Forbidden", status=403)
    headers = dict(_FEED_HEADERS)
    if req.headers.get("Range"):
        headers["Range"] = req.headers["Range"]
    try:
        upstream = requests.get(url, headers=headers, stream=True, allow_redirects=True, timeout=20)
    except requests.RequestException:
        return https_fn.Response("Upstream unavailable", status=502)
    if upstream.status_code not in (200, 206):
        upstream.close()
        return https_fn.Response("Upstream error", status=502)
    out = {k: upstream.headers[k] for k in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")
           if k in upstream.headers}
    out["Cache-Control"] = "private, max-age=3600"
    return https_fn.Response(upstream.iter_content(chunk_size=64 * 1024), status=upstream.status_code, headers=out)


# ─── Sites and Bites: curated destination guides ─────────────────────────────
#
# Admin-only. Claude proposes the must-see places and neighbourhoods for a
# destination; each place is then resolved through Places Text Search so the
# map pins use real coordinates (and hallucinated or closed places are dropped).
# The result is cached in Firestore `destinations/{placeId}`.

import concurrent.futures
import difflib
import math
import threading

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
SITES_BITES_MODEL = os.environ.get("SITES_BITES_MODEL", "claude-sonnet-5-5")
SITES_BITES_ADMIN_UID = os.environ.get("ADMIN_UID", "8THLJbKP0qRINQ5RqjoUKIMtdVY2")
SITES_BITES_CATEGORIES = ("eat", "drink", "cafe", "museum", "attraction", "activity", "outdoors")

SITES_BITES_MIN_RATING = 4.1  # drop verified places rated below this (once they have 20+ reviews)

SITES_BITES_AREAS_PROMPT = """You are an expert travel editor planning a visitor guide for: {dest}.

Output JSON Lines: one complete JSON object per line, no markdown fences, no commentary. In this order:
1. Exactly one summary line:
{{"type":"summary","text":"2-3 sentence overview of the destination and what it is known for"}}
2. 4 to 8 area lines. Areas are distinct neighbourhoods or districts that together cover everywhere a visitor will spend time, with no overlap:
{{"type":"area","id":"short-slug","name":"Area name","description":"1-2 sentences on its character and why to go","bestFor":"e.g. nightlife, history, beaches"}}
"""

SITES_BITES_CATEGORY_PROMPT = """You are an expert travel editor compiling the definitive visitor guide for: {dest}. This request covers one category only: {label}.

{definition}

Be exhaustive within the bar of quality: list every {noun} that a well-informed local or seasoned traveller would genuinely recommend to a visitor, so that the reader never needs to consult a travel blog. Aim for about {target}; list fewer only if there truly are not that many good ones. Rank the most essential first. Skip chains and generic tourist traps unless iconic. Only include places you are confident exist, are currently operating, and can be found by exact official name.

Areas of {dest} (use these ids):
{areas}

Output JSON Lines: one complete JSON object per line, no markdown fences, no commentary:
{{"type":"place","name":"Exact official name","area":"an area id from above","tier":"must|great","kidFriendly":true,"locationHint":"street or neighbourhood plus city, to disambiguate","why":"max 25 words on what makes it special","tip":"max 15 words of practical advice (what to order, when to go, book ahead)"}}

- tier "must" is only for the true must-visits (about one in five); the rest are "great".
- kidFriendly is true only if genuinely enjoyable and practical for young children and families (not merely "children allowed"), otherwise false.
"""

SITES_BITES_CATEGORY_SPECS = {
    "eat": ("Restaurants", "restaurant", "Restaurants and places for a proper meal, across price points and cuisines, including standout casual spots.", 25),
    "drink": ("Bars and drinks", "bar or drinks venue", "Bars, cocktail lounges, breweries, wineries, distilleries and notable pubs.", 15),
    "cafe": ("Cafes and bakeries", "cafe, bakery or dessert shop", "Coffee shops, bakeries, patisseries, ice cream and dessert spots.", 15),
    "museum": ("Museums and culture", "museum, gallery or cultural site", "Museums, galleries, historic sites, architecture and notable cultural venues.", 12),
    "attraction": ("Attractions", "attraction", "Landmarks, markets, shopping districts and entertainment venues.", 15),
    "activity": ("Activities", "activity or experience", "Things to do and book: tours, spas, classes, adventure and sports experiences, scenic rides, shows.", 15),
    "outdoors": ("Outdoors", "outdoor spot", "Parks, beaches, trails, gardens and viewpoints.", 12),
}


def _sb_error(code, message):
    raise https_fn.HttpsError(code=code, message=message)


def _sb_norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _sb_name_match(a, b):
    a, b = _sb_norm(a), _sb_norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 0.95
    return difflib.SequenceMatcher(None, a, b).ratio()


def _sb_distance_km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    h = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def _sb_destination_details(place_id):
    resp = requests.get(
        f"{PLACES_API_BASE}/places/{place_id}",
        headers={
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask": "displayName,formattedAddress,location,viewport",
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    loc = data.get("location") or {}
    vp = data.get("viewport") or {}
    lo, hi = vp.get("low") or {}, vp.get("high") or {}
    if lo and hi:
        radius_km = _sb_distance_km(lo["latitude"], lo["longitude"], hi["latitude"], hi["longitude"]) / 2
    else:
        radius_km = 10
    return {
        "name": (data.get("displayName") or {}).get("text") or "",
        "address": data.get("formattedAddress") or "",
        "lat": loc.get("latitude"),
        "lng": loc.get("longitude"),
        "radiusKm": max(3.0, min(radius_km, 60.0)),
    }


def _sb_stream(prompt, max_tokens):
    """Stream a JSON Lines answer from Claude, yielding each completed line as a dict."""
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": SITES_BITES_MODEL,
            "max_tokens": max_tokens,
            "stream": True,
            "messages": [{"role": "user", "content": prompt}],
        },
        stream=True,
        timeout=(10, 120),
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API {resp.status_code}: {resp.text[:300]}")

    def parse(line):
        line = line.strip()
        if not line.startswith("{"):
            return None
        try:
            return json.loads(line)
        except ValueError:
            return None

    buffer = ""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        try:
            event = json.loads(raw[5:].strip())
        except ValueError:
            continue
        if event.get("type") == "error":
            raise RuntimeError(f"Anthropic stream error: {event.get('error')}")
        delta = event.get("delta") or {}
        if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
            buffer += delta.get("text", "")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                obj = parse(line)
                if obj:
                    yield obj
    obj = parse(buffer)
    if obj:
        yield obj



def _sb_resolve_place(p, center, radius_km):
    """Find the real Google place for a model-suggested place; None if unverifiable."""
    query = f"{p['name']}, {p.get('locationHint') or ''}".strip(", ")
    try:
        resp = requests.post(
            f"{PLACES_API_BASE}/places:searchText",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
                "X-Goog-FieldMask": (
                    "places.id,places.displayName,places.location,places.formattedAddress,"
                    "places.rating,places.userRatingCount,places.googleMapsUri,"
                    "places.businessStatus,places.websiteUri"
                ),
            },
            json={
                "textQuery": query,
                "pageSize": 3,
                "locationBias": {"circle": {
                    "center": {"latitude": center["lat"], "longitude": center["lng"]},
                    "radius": min(50000.0, radius_km * 1000 * 1.5),
                }},
            },
            timeout=15,
        )
        resp.raise_for_status()
        candidates = resp.json().get("places", [])
    except Exception:
        return None

    best, best_score = None, 0.0
    for c in candidates:
        if c.get("businessStatus") not in (None, "OPERATIONAL"):
            continue
        loc = c.get("location") or {}
        if loc.get("latitude") is None:
            continue
        if _sb_distance_km(center["lat"], center["lng"], loc["latitude"], loc["longitude"]) > radius_km * 1.5 + 3:
            continue
        score = _sb_name_match(p["name"], (c.get("displayName") or {}).get("text"))
        if score > best_score:
            best, best_score = c, score
    if not best or best_score < 0.55:
        return None

    rating, review_count = best.get("rating"), best.get("userRatingCount") or 0
    if rating is not None and review_count >= 20 and rating < SITES_BITES_MIN_RATING:
        return None

    loc = best["location"]
    return {
        "placeId": best.get("id"),
        "name": (best.get("displayName") or {}).get("text") or p["name"],
        "category": p["category"],
        "areaId": p["area"],
        "tier": "must" if p.get("tier") == "must" else "great",
        "kidFriendly": bool(p.get("kidFriendly")),
        "why": (p.get("why") or "").strip(),
        "tip": (p.get("tip") or "").strip(),
        "lat": loc["latitude"],
        "lng": loc["longitude"],
        "address": best.get("formattedAddress"),
        "rating": best.get("rating"),
        "ratingCount": best.get("userRatingCount"),
        "mapsUrl": best.get("googleMapsUri"),
        "website": best.get("websiteUri"),
    }


@https_fn.on_call(invoker="public", region="us-west1", memory=1024, timeout_sec=540)
def generate_destination(req: https_fn.CallableRequest) -> dict:
    """Admin action: build (or rebuild) the guide for a destination.

    Claude first defines the areas, then one call per category runs in parallel,
    each asked for an exhaustive list. Every place is verified through Places and
    written to the Firestore doc as it is found (status "generating"), so the
    page fills in live.
    """
    if not req.auth or req.auth.uid != SITES_BITES_ADMIN_UID:
        _sb_error(https_fn.FunctionsErrorCode.PERMISSION_DENIED, "Admin only")
    place_id = ((req.data or {}).get("placeId") or "").strip()
    if not place_id:
        _sb_error(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "placeId is required")
    if not GOOGLE_MAPS_API_KEY or not ANTHROPIC_API_KEY:
        _sb_error(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            "GOOGLE_MAPS_API_KEY and ANTHROPIC_API_KEY must be set in functions/.env",
        )

    db_client = firestore.client()
    ref = db_client.collection("destinations").document(place_id)
    existing = ref.get()
    if existing.exists and not (req.data or {}).get("refresh"):
        return {"id": place_id, "cached": True}

    try:
        dest = _sb_destination_details(place_id)
    except Exception as e:
        _sb_error(https_fn.FunctionsErrorCode.UNAVAILABLE, f"Could not look up destination: {e}")
    if dest["lat"] is None:
        _sb_error(https_fn.FunctionsErrorCode.NOT_FOUND, "Destination has no location")

    center = {"lat": dest["lat"], "lng": dest["lng"]}
    label = dest["address"] or dest["name"]
    ref.set({
        "name": dest["name"],
        "address": dest["address"],
        "center": center,
        "radiusKm": dest["radiusKm"],
        "summary": "",
        "areas": [],
        "places": [],
        "status": "generating",
        "model": SITES_BITES_MODEL,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })

    lock = threading.Lock()
    seen = set()
    stats = {"suggested": 0, "kept": 0}
    failures = []

    try:
        # Step 1: summary and areas.
        areas = []
        for obj in _sb_stream(SITES_BITES_AREAS_PROMPT.format(dest=label), 3000):
            if obj.get("type") == "summary":
                ref.update({"summary": obj.get("text") or ""})
            elif obj.get("type") == "area" and obj.get("id"):
                area = {
                    "id": obj["id"],
                    "name": obj.get("name") or obj["id"],
                    "description": obj.get("description") or "",
                    "bestFor": obj.get("bestFor") or "",
                }
                areas.append(area)
                ref.update({"areas": firestore.ArrayUnion([area])})
        if not areas:
            raise RuntimeError("Could not work out the areas of this destination")
        area_ids = {a["id"] for a in areas}
        area_text = "\n".join(f"- {a['id']}: {a['name']} ({a['description']})" for a in areas)
        scale = 1.0 if dest["radiusKm"] > 15 else 0.7

        # Step 2: one exhaustive call per category, in parallel.
        def run_category(key):
            title, noun, definition, target = SITES_BITES_CATEGORY_SPECS[key]
            prompt = SITES_BITES_CATEGORY_PROMPT.format(
                dest=label, label=title, noun=noun, definition=definition,
                target=max(5, round(target * scale)), areas=area_text,
            )
            for obj in _sb_stream(prompt, 6000):
                if obj.get("type") != "place" or not obj.get("name") or obj.get("area") not in area_ids:
                    continue
                with lock:
                    stats["suggested"] += 1
                obj["category"] = key
                r = _sb_resolve_place(obj, center, dest["radiusKm"])
                if not r:
                    continue
                with lock:
                    if r["placeId"] in seen:
                        continue
                    seen.add(r["placeId"])
                    stats["kept"] += 1
                ref.update({"places": firestore.ArrayUnion([r])})

        def safe_run(key):
            try:
                run_category(key)
            except Exception as e:
                failures.append(f"{key}: {e}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(SITES_BITES_CATEGORY_SPECS)) as pool:
            list(pool.map(safe_run, SITES_BITES_CATEGORY_SPECS))

        if stats["kept"] == 0:
            raise RuntimeError("No verifiable places were found for this destination" + (f" ({failures[0]})" if failures else ""))

        # Drop areas that ended up with no verified places.
        snap = ref.get().to_dict()
        used = {p["areaId"] for p in snap.get("places", [])}
        update = {
            "areas": [a for a in snap.get("areas", []) if a["id"] in used],
            "status": "ready",
            "droppedCount": stats["suggested"] - stats["kept"],
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if failures:
            update["error"] = "Some categories failed: " + "; ".join(failures)[:250]
        ref.update(update)
    except Exception as e:
        ref.update({"status": "error", "error": str(e)[:300]})
        _sb_error(https_fn.FunctionsErrorCode.UNAVAILABLE, f"Guide generation failed: {e}")

    return {"id": place_id, "cached": False, "places": stats["kept"], "dropped": stats["suggested"] - stats["kept"]}
