import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timedelta
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


TIME_RANGE_RE = re.compile(r"\b\d{1,2}(:\d{2})?\s*(am|pm)\b.*?\d{1,2}(:\d{2})?\s*(am|pm)\b", re.IGNORECASE)


def _parse_port_coquitlam(source_key, cfg):
    soup = _fetch_html(cfg["url"])
    events = _extract_jsonld_events(soup, cfg["url"])
    if events:
        return [{**e, "source": source_key, "region": cfg["region"]} for e in events]

    # Fallback: event links inside the community calendar list view
    today = datetime.now().date()
    for link in soup.select("a[href*='/explore-poco/']"):
        title = _clean_text(link.get_text())
        if not title or len(title) < 3:
            continue
        container = link.find_parent(["li", "div", "article"]) or link.parent
        context = _clean_text(container.get_text()) if container else ""
        date_match = DATE_RE.search(context)
        if not date_match:
            continue
        try:
            dt = datetime.strptime(date_match.group(0).replace(",", ""), "%B %d %Y").date()
        except ValueError:
            continue
        if dt < today - timedelta(days=1):
            continue
        time_match = TIME_RANGE_RE.search(context)
        events.append({
            "title": title,
            "description": None,
            "tags": [],
            "startDate": dt.isoformat(),
            "endDate": None,
            "allDay": time_match is None,
            "timeText": time_match.group(0) if time_match else None,
            "price": _parse_price_text(None),
            "url": link.get("href"),
            "location": None,
            "source": source_key,
            "sourceEventUrl": link.get("href"),
            "region": cfg["region"],
        })
    # De-dupe (same title/date can appear in both calendar + list DOM sections)
    seen, unique = set(), []
    for e in events:
        key = (e["title"], e["startDate"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(e)
    return unique


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


def _parse_destination_vancouver(source_key, cfg):
    soup = _fetch_html(cfg["url"])
    events = _extract_jsonld_events(soup, cfg["url"])
    # This page renders its calendar client-side via JS; JSON-LD (if present)
    # is the only reliable extraction point without a headless browser. If
    # it comes back empty, `refresh_events` will report 0 for this source.
    return [{**e, "source": source_key, "region": cfg["region"]} for e in events]


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
    return events


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
