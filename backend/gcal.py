"""
gcal.py

Google Calendar: read your upcoming events (so "what's on my calendar
tomorrow?" works and they show in the Today tab), remind you of them like
tasks (15 minutes before and at the start, exactly once), and add events
("put dentist on my calendar Friday at 4").

Connecting is Google's standard sign-in for desktop apps: you create an
OAuth "Desktop app" client in Google Cloud and save its JSON as
backend/client_secret.json, then press Connect in Settings: your browser
opens, you approve, and a token is saved as backend/token_google.json. Both
files are gitignored and never leave the laptop except to talk to Google.
Only Calendar *events* access is requested.

Everything talks to Google through `client` (swappable: the tests use a
fake calendar).
"""

import json
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional, Protocol

import schedule_store

BASE = Path(__file__).parent
CLIENT_SECRET = BASE / "client_secret.json"
TOKEN = BASE / "token_google.json"
SCOPES = ["https://www.googleapis.com/auth/calendar.events"]
API = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
CACHE_S = 120
WARN_MINUTES = 15


class CalendarClient(Protocol):
    def list(self, start: datetime, end: datetime) -> list[dict]: ...
    def insert(self, body: dict) -> dict: ...


class GoogleClient:
    """The real calendar, via an authorised session (refreshes its token by itself)."""

    def __init__(self, creds):
        from google.auth.transport.requests import AuthorizedSession

        self.session = AuthorizedSession(creds)

    def list(self, start: datetime, end: datetime) -> list[dict]:
        r = self.session.get(API, params={
            "timeMin": start.astimezone().isoformat(), "timeMax": end.astimezone().isoformat(),
            "singleEvents": "true", "orderBy": "startTime", "maxResults": 100,
        }, timeout=15)
        r.raise_for_status()
        return r.json().get("items", [])

    def insert(self, body: dict) -> dict:
        r = self.session.post(API, json=body, timeout=15)
        r.raise_for_status()
        return r.json()


client: Optional[CalendarClient] = None
_cache: dict = {"at": 0.0, "key": None, "events": []}
_connect_error: Optional[str] = None
_connecting = False


def _load() -> None:
    """Use the saved token, if there is one."""
    global client
    if client is not None or not TOKEN.exists():
        return
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
        if not creds.valid and creds.refresh_token:
            creds.refresh(Request())
            TOKEN.write_text(creds.to_json(), encoding="utf-8")
        client = GoogleClient(creds)
    except Exception as err:
        print(f"[calendar] saved sign-in didn't work ({type(err).__name__}); connect again in Settings")


def status() -> dict:
    _load()
    return {
        "connected": client is not None,
        "connecting": _connecting,
        "set_up": CLIENT_SECRET.exists(),
        "error": _connect_error,
    }


def connect() -> dict:
    """Open Google's sign-in in the browser and wait for your approval (runs in a thread)."""
    global client, _connect_error, _connecting
    if not CLIENT_SECRET.exists():
        _connect_error = "Save your Google OAuth client as backend/client_secret.json first (see the README)."
        return status()
    _connecting, _connect_error = True, None
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow

        flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
        creds = flow.run_local_server(port=0, open_browser=True, timeout_seconds=300,
                                      success_message="Bit is connected to your Google Calendar. You can close this tab.")
        TOKEN.write_text(creds.to_json(), encoding="utf-8")
        client = GoogleClient(creds)
        _cache["at"] = 0
    except Exception as err:
        _connect_error = f"Couldn't connect ({type(err).__name__})."
    finally:
        _connecting = False
    return status()


def disconnect() -> dict:
    global client
    client = None
    _cache["at"] = 0
    TOKEN.unlink(missing_ok=True)
    return status()


def _simplify(ev: dict) -> Optional[dict]:
    if ev.get("status") == "cancelled":
        return None
    s, e = ev.get("start", {}), ev.get("end", {})
    all_day = "date" in s
    try:
        start = datetime.fromisoformat(s["date"]) if all_day else datetime.fromisoformat(s["dateTime"]).astimezone().replace(tzinfo=None)
    except (KeyError, ValueError):
        return None
    end = None
    try:
        end = datetime.fromisoformat(e["date"]) if "date" in e else datetime.fromisoformat(e["dateTime"]).astimezone().replace(tzinfo=None)
    except (KeyError, ValueError):
        pass
    return {"id": ev.get("id", ""), "title": ev.get("summary") or "(no title)", "start": start, "end": end, "all_day": all_day,
            "location": ev.get("location") or ""}


def events(start: datetime, end: datetime) -> list[dict]:
    """Your events in a window (cached a couple of minutes). [] when not connected or Google can't be reached."""
    _load()
    if client is None:
        return []
    key = (start.replace(second=0, microsecond=0), end.replace(second=0, microsecond=0))
    if _cache["key"] == key and time.time() - _cache["at"] < CACHE_S:
        return _cache["events"]
    try:
        out = [x for x in (_simplify(e) for e in client.list(start, end)) if x]
    except Exception as err:
        print(f"[calendar] couldn't read events ({type(err).__name__})")
        return _cache["events"] if _cache["key"] == key else []
    _cache.update(at=time.time(), key=key, events=out)
    return out


def upcoming(days: int = 7) -> list[dict]:
    d0 = datetime.combine(date.today(), datetime.min.time())
    return events(d0, d0 + timedelta(days=days + 1))


def for_prompt(days: int = 7) -> str:
    lines = []
    for e in upcoming(days):
        when = e["start"].strftime("%a %d %b") + ("" if e["all_day"] else e["start"].strftime(" %H:%M"))
        lines.append(f"{when} | {e['title']}" + (f" | {e['location']}" if e["location"] else ""))
    return "\n".join(lines)


def add(title: str, day: str, at: Optional[str], minutes: int = 60) -> dict:
    """Create an event. day YYYY-MM-DD, at HH:MM (None = all day)."""
    _load()
    if client is None:
        raise RuntimeError("not connected")
    title = " ".join(str(title).split())[:200] or "Event"
    d = date.fromisoformat(day)
    if at:
        start = datetime.combine(d, datetime.strptime(at, "%H:%M").time()).astimezone()
        body = {"summary": title, "start": {"dateTime": start.isoformat()}, "end": {"dateTime": (start + timedelta(minutes=max(5, min(minutes, 24 * 60)))).isoformat()}}
    else:
        body = {"summary": title, "start": {"date": d.isoformat()}, "end": {"date": (d + timedelta(days=1)).isoformat()}}
    created = client.insert(body)
    _cache["at"] = 0
    return _simplify(created) or {"title": title}


# ------------------------------------------------------------------ reminders for events

def init_tables() -> None:
    with schedule_store.get_conn() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS calendar_fired (
                            event_id TEXT NOT NULL, start TEXT NOT NULL, kind TEXT NOT NULL, fired_at TEXT NOT NULL,
                            PRIMARY KEY (event_id, start, kind))""")
        conn.commit()


def due(since: datetime, now: datetime, late_ok_minutes: int = 10) -> list[dict]:
    """Event reminders that became due in (since, now]: 15 minutes before and at the start; each once.
    Ones more than late_ok_minutes late (the laptop was asleep) are skipped, not fired late."""
    if client is None and not TOKEN.exists():
        return []
    out = []
    for e in events(now - timedelta(hours=1), now + timedelta(hours=2)):
        if e["all_day"]:
            continue
        for kind, at in (("warn", e["start"] - timedelta(minutes=WARN_MINUTES)), ("start", e["start"])):
            if since < at <= now and now - at <= timedelta(minutes=late_ok_minutes):
                with schedule_store.get_conn() as conn:
                    fresh = conn.execute("INSERT OR IGNORE INTO calendar_fired VALUES (?, ?, ?, ?)",
                                         (e["id"], e["start"].isoformat(), kind, now.isoformat())).rowcount
                    conn.commit()
                if fresh:
                    out.append({**e, "kind": kind})
    # "warn" and "start" both due at once (e.g. after sleep): just the start.
    starts = {(x["id"], x["start"]) for x in out if x["kind"] == "start"}
    return [x for x in out if x["kind"] == "start" or (x["id"], x["start"]) not in starts]


def reminder_text(e: dict) -> str:
    if e["kind"] == "warn":
        return f"In {WARN_MINUTES} minutes: {e['title']}" + (f" at {e['location']}" if e["location"] else "") + "."
    return f"It's time: {e['title']}" + (f" at {e['location']}" if e["location"] else "") + "."
