r"""Day one probes for Job Done against the PayPal sandbox. Prints HTTP codes, ids and field names only.

Usage: python tools/sandbox_probe.py <command> [args]

Commands:
  create              create a draft invoice (282.42 demo job) to the sandbox buyer
  send <id>           send it to the recipient
  qr <id>             generate the QR code; prints content type and byte length
  get <id>            read it back; saves tests/fixtures/invoice-<status>.json
  cash                create and send 120.00 to dave@example.com, record CASH 120.00, read back
  rule <id>           add an AUTO_CANCEL conditional rule for tomorrow
  remind <id>         send a reminder
  tip                 create and send an invoice that allows a tip and a part payment of at least 50.00
  reminders           list the account's automatic reminder settings
  reminders-setup     create both settings, INACTIVE
  reminders-on <config id> <days> <times>  AFTER_DUE every <days> days, <times> times, then resume it to ACTIVE
  reminders-stop <invoice id>  stop the automatic reminders for one invoice
  cancel <id>         cancel a sent invoice
  late                create and send the 340.00 invoice for Sam Okafor at sam@example.com
  webhook-create <url>  register this app's one webhook URL
  webhook-list        list webhooks on the shared app (ids and urls only)
  simulate <webhook_id>  fire a simulated INVOICING.INVOICE.PAID
  verify <event.json> [headers.json]  verify a stored event's signature
  resend <event_id>   resend a delivered real event
  events              list recent delivered webhook events (ids and types only)

The secrets file is `paypal-sandbox.local.txt` in the secrets folder. No value from it is ever printed. Saved fixtures
have the merchant persona email replaced with merchant@example.com and every other persona email with
buyer@example.com. Ids of things made here go in tools/out/probe-state.json,
which git ignores.
"""
import base64
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://api-m.sandbox.paypal.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", "out")
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
STATE = os.path.join(OUT, "probe-state.json")


def secrets_dir():
    for d in (os.environ.get("MIDKNIGHT_SECRETS", ""),
              os.path.join(os.path.expanduser("~"), ".cloudflare")):
        if d and os.path.isdir(d):
            return d
    sys.exit("secrets folder not found")


def read_secrets():
    kv = {}
    with open(os.path.join(secrets_dir(), "paypal-sandbox.local.txt"), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                kv[k.strip()] = v.strip()
    return kv


SECRETS = read_secrets()


def scrub(text):
    """Replace every persona email and secret value in text, so nothing from the secrets file is shown or saved."""
    for k, v in SECRETS.items():
        if k.endswith("_EMAIL") and v:
            stand_in = "merchant@example.com" if "MERCHANT" in k else "buyer@example.com"
            text = re.sub(re.escape(v), stand_in, text, flags=re.I)
    for k, v in SECRETS.items():
        if v and len(v) > 6 and not k.endswith("_EMAIL"):
            text = text.replace(v, "<secret>")
    return text


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(**kw):
    os.makedirs(OUT, exist_ok=True)
    s = load_state()
    s.update(kw)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


_token = None


def token():
    global _token
    if _token:
        return _token
    basic = base64.b64encode(f"{SECRETS['PAYPAL_SANDBOX_CLIENT_ID']}:{SECRETS['PAYPAL_SANDBOX_SECRET']}".encode()).decode()
    code, body, _ = raw("POST", "/v1/oauth2/token", b"grant_type=client_credentials",
                        {"Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded"})
    if code != 200:
        sys.exit(f"token HTTP {code}")
    _token = json.loads(body)["access_token"]
    return _token


def raw(method, path, data=None, headers=None, tries=4):
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=headers or {})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)
        except (urllib.error.URLError, OSError) as e:
            if attempt == tries - 1:
                return 0, str(e).encode(), {}
            time.sleep(1.5)


def api(method, path, body=None, request_id=None, accept="application/json"):
    headers = {"Authorization": "Bearer " + token(), "Content-Type": "application/json", "Accept": accept}
    if method == "POST":
        headers["PayPal-Request-Id"] = request_id or str(uuid.uuid4())
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    t = time.time()
    code, out, hdrs = raw(method, path, data, headers)
    ms = int((time.time() - t) * 1000)
    ctype = hdrs.get("Content-Type", hdrs.get("content-type", ""))
    parsed = None
    if out and "json" in ctype:
        try:
            parsed = json.loads(out)
        except ValueError:
            pass
    line = f"{method} {path} -> HTTP {code} ({ms} ms)"
    if parsed is not None and code >= 400:
        line += f" name={parsed.get('name')} debug_id={parsed.get('debug_id')}"
        for d in parsed.get("details", []) or []:
            line += f"\n    issue={d.get('issue')} field={d.get('field')} desc={scrub(str(d.get('description', '')))[:160]}"
    print(line)
    return code, parsed, out, ctype


def keys(obj, prefix=""):
    """Field names of a JSON object, nested, no values."""
    names = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            names.append(prefix + k)
            if isinstance(v, dict):
                names += keys(v, prefix + k + ".")
            elif isinstance(v, list) and v and isinstance(v[0], dict):
                names += keys(v[0], prefix + k + "[].")
    return names


def save_fixture(name, obj):
    os.makedirs(FIXTURES, exist_ok=True)
    path = os.path.join(FIXTURES, name)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(scrub(json.dumps(obj, indent=2)) + "\n")
    print(f"saved {os.path.relpath(path, ROOT)}")


def today(days=0):
    return (datetime.date.today() + datetime.timedelta(days=days)).isoformat()


def invoice_body(ref, given, surname, email, items, note):
    body = {
        # No invoice_date: a date from this PC's clock can be tomorrow for the merchant, and PayPal then holds the
        # invoice as SCHEDULED (seen 22 Oct 2026). PayPal dates it by its own clock when the field is left out.
        "detail": {"currency_code": "USD", "reference": ref, "note": note,
                   "payment_term": {"term_type": "DUE_ON_RECEIPT"}},
        "invoicer": {"business_name": "Elm Street Plumbing (demo)"},
        "primary_recipients": [{"billing_info": {"name": {"given_name": given, "surname": surname},
                                                 "email_address": email}}],
        "items": items,
        "configuration": {"allow_tip": False},
    }
    merchant = SECRETS.get("PAYPAL_SANDBOX_MERCHANT_EMAIL")
    if merchant and os.environ.get("JD_INVOICER_EMAIL", "1") == "1":
        body["invoicer"]["email_address"] = merchant
    return body


def item(name, qty, value, uom, desc=""):
    return {"name": name, "description": desc, "quantity": str(qty),
            "unit_amount": {"currency_code": "USD", "value": value},
            "tax": {"name": "Sales tax (demo)", "percent": "8"}, "unit_of_measure": uom}


def id_from(code, parsed):
    if not parsed:
        return None
    if parsed.get("id"):
        return parsed["id"]
    for link in [parsed] + (parsed.get("links", []) or []):
        m = re.search(r"/invoices/([A-Z0-9-]+)$", link.get("href", "") or "")
        if m:
            return m.group(1)
    return None


def create_invoice(ref, given, surname, email, items, note, tag):
    code, parsed, _, _ = api("POST", "/v2/invoicing/invoices",
                             invoice_body(ref, given, surname, email, items, note), request_id=f"jd-probe-{ref}")
    if parsed is not None:
        print("  top level keys:", sorted(parsed.keys()))
    inv = id_from(code, parsed)
    print("  invoice id:", inv)
    if inv:
        save_state(**{tag: inv})
    return code, inv


def cmd_create(_args):
    ref = "maria-" + uuid.uuid4().hex[:8]
    items = [item("Call out", 1, "45.00", "AMOUNT"),
             item("Labour", "1.5", "85.00", "HOURS", "Kitchen tap"),
             item("Kitchen tap", 1, "89.00", "QUANTITY")]
    code, inv = create_invoice(ref, "Maria", "Lopez", SECRETS["PAYPAL_SANDBOX_BUYER_EMAIL"], items,
                               "Kitchen tap at 14 Elm Street. Thank you.", "maria")
    if inv:
        c, parsed, _, _ = api("GET", f"/v2/invoicing/invoices/{inv}")
        if parsed:
            inv_block = parsed.get("invoicer", {})
            print("  invoicer keys:", sorted(inv_block.keys()))
            m = SECRETS.get("PAYPAL_SANDBOX_MERCHANT_EMAIL", "").lower()
            print("  invoicer is the merchant persona:", inv_block.get("email_address", "").lower() == m)
            print("  status:", parsed.get("status"), " amount keys:", sorted(parsed.get("amount", {}).keys()))
            save_fixture("invoice-draft.json", parsed)


def cmd_tip(_args):
    """One invoice with a tip and a part payment allowed (a deposit now, the rest later), sent and read back."""
    ref = "tip-" + uuid.uuid4().hex[:8]
    items = [item("Call out", 1, "45.00", "AMOUNT"),
             item("Labour", "1.5", "85.00", "HOURS", "Kitchen tap"),
             item("Kitchen tap", 1, "89.00", "QUANTITY")]
    body = invoice_body(ref, "Maria", "Lopez", SECRETS["PAYPAL_SANDBOX_BUYER_EMAIL"], items,
                        "Kitchen tap at 14 Elm Street. Thank you.")
    body["configuration"] = {"allow_tip": True,
                             "partial_payment": {"allow_partial_payment": True,
                                                 "minimum_amount_due": {"currency_code": "USD", "value": "50.00"}}}
    code, parsed, _, _ = api("POST", "/v2/invoicing/invoices", body, request_id=f"jd-probe-{ref}")
    inv = id_from(code, parsed)
    print("  invoice id:", inv)
    if not inv:
        return
    save_state(tip=inv)
    api("POST", f"/v2/invoicing/invoices/{inv}/send", {"send_to_recipient": True}, request_id=f"jd-probe-{ref}-send")
    c, got, _, _ = api("GET", f"/v2/invoicing/invoices/{inv}")
    if got:
        print("  status:", got.get("status"), " configuration:", json.dumps(got.get("configuration")))
        print("  payer page given:", bool((got.get("detail") or {}).get("metadata", {}).get("recipient_view_url")))
        save_fixture("invoice-tip-partial.json", got)


def cmd_reminders(_args):
    """The account's automatic reminder settings (PayPal keeps one BEFORE_DUE and one AFTER_DUE per account)."""
    _, j, _, _ = api("GET", "/v2/invoicing/reminders")
    for x in (j or {}).get("configurations", []):
        print("  ", x.get("id"), x.get("type"), x.get("status"), "every", x["interval"]["value"], "days,", x.get("repetition"), "times")


def cmd_reminders_setup(_args):
    """Creates both settings, INACTIVE (nothing is sent until one is turned on)."""
    api("POST", "/v2/invoicing/setup-reminders", {}, request_id=f"jd-probe-rem-setup-{uuid.uuid4().hex[:8]}")
    cmd_reminders([])


def cmd_reminders_on(args):
    """reminders-on <config id> <days> <times>: AFTER_DUE every <days> days, <times> times, then resumed (a PUT alone
    leaves the status INACTIVE, seen 28 Oct 2026)."""
    rid, days, times = args[0], int(args[1]), int(args[2])
    api("PUT", f"/v2/invoicing/reminders/{rid}", {"type": "AFTER_DUE", "interval": {"unit": "DAY", "value": days},
                                                  "repetition": times, "status": "ACTIVE"})
    api("POST", f"/v2/invoicing/reminders/{rid}/resume", {}, request_id=f"jd-probe-rem-resume-{uuid.uuid4().hex[:8]}")
    cmd_reminders([])


def cmd_reminders_stop(args):
    """Stops PayPal's automatic reminders for one invoice."""
    api("POST", f"/v2/invoicing/invoices/{args[0]}/cancel-reminders", {}, request_id=f"jd-probe-rem-stop-{args[0]}")


def cmd_send(args):
    inv = args[0]
    code, parsed, out, _ = api("POST", f"/v2/invoicing/invoices/{inv}/send",
                               {"send_to_recipient": True, "note": "Thanks for having me out."},
                               request_id=f"jd-probe-send-{inv}")
    if parsed is not None:
        print("  body keys:", keys(parsed))
        save_fixture("send-response.json", parsed)


def cmd_qr(args):
    inv = args[0]
    code, parsed, out, ctype = api("POST", f"/v2/invoicing/invoices/{inv}/generate-qr-code",
                                   {"width": 300, "height": 300}, request_id=f"jd-probe-qr-{inv}", accept="*/*")
    print(f"  content type: {ctype}; bytes: {len(out)}")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"qr-{inv}.bin"), "wb") as f:
        f.write(out)
    # Seen 22 Oct: multipart/form-data with one part named "image", Content-Type text/plain, holding a base64 PNG.
    sep = out.find(b"\r\n\r\n")
    part = out[sep + 4:].split(b"\r\n--", 1)[0] if sep >= 0 else b""
    png = base64.b64decode(part) if part else b""
    print("  part headers:", out[:sep].decode("utf-8", "replace").splitlines()[1:] if sep >= 0 else None)
    print("  decoded is a PNG:", png[:4] == b"\x89PNG", "bytes:", len(png))
    with open(os.path.join(OUT, f"qr-{inv}.png"), "wb") as f:
        f.write(png)
    print("  saved tools/out/qr-%s.png" % inv)


def cmd_get(args):
    inv = args[0]
    code, parsed, _, _ = api("GET", f"/v2/invoicing/invoices/{inv}")
    if parsed:
        print("  status:", parsed.get("status"))
        print("  field names:", keys(parsed))
        save_fixture(f"invoice-{(parsed.get('status') or 'unknown').lower()}.json", parsed)


def cmd_cash(_args):
    ref = "dave-" + uuid.uuid4().hex[:8]
    leak = item("Leak repair", 1, "120.00", "AMOUNT")
    leak.pop("tax")
    code, inv = create_invoice(ref, "Dave", "Chen", "dave@example.com", [leak], "Leak repair.", "dave")
    if not inv:
        return
    api("POST", f"/v2/invoicing/invoices/{inv}/send", {"send_to_recipient": True}, request_id=f"jd-probe-send-{inv}")
    c, parsed, _, _ = api("GET", f"/v2/invoicing/invoices/{inv}")
    due = parsed.get("due_amount", parsed.get("amount", {})).get("value") if parsed else None
    print("  due before cash:", due)
    api("POST", f"/v2/invoicing/invoices/{inv}/payments",
        {"method": "CASH", "payment_date": today(), "amount": {"currency_code": "USD", "value": due or "120.00"},
         "note": "Paid cash on site."}, request_id=f"jd-probe-cash-{inv}")
    cmd_get([inv])


def cmd_rule(args):
    inv = args[0]
    api("POST", f"/v2/invoicing/invoices/{inv}/conditional-rules",
        {"rules": [{"conditional_rule_type": "AUTO_CANCEL",
                    "rule_expiry_terms": {"rule_expiry_condition": "SPECIFIC_DATE",
                                          "condition_rule_end_date": today(1)}}]},
        request_id=f"jd-probe-rule-{inv}")


def cmd_remind(args):
    inv = args[0]
    api("POST", f"/v2/invoicing/invoices/{inv}/remind",
        {"subject": "A quick reminder", "note": "Just a reminder this one is still open. Thanks."},
        request_id=f"jd-probe-remind-{inv}-{uuid.uuid4().hex[:6]}")


def cmd_cancel(args):
    inv = args[0]
    api("POST", f"/v2/invoicing/invoices/{inv}/cancel",
        {"send_to_recipient": True, "note": "The slot was released."}, request_id=f"jd-probe-cancel-{inv}")


def cmd_late(_args):
    ref = "sam-" + uuid.uuid4().hex[:8]
    items = [item("Boiler service", 1, "340.00", "AMOUNT")]
    body = invoice_body(ref, "Sam", "Okafor", "sam@example.com", items, "Boiler service.")
    for it in body["items"]:
        it.pop("tax", None)
    code, parsed, _, _ = api("POST", "/v2/invoicing/invoices", body, request_id=f"jd-probe-{ref}")
    inv = id_from(code, parsed)
    print("  invoice id:", inv)
    if inv:
        save_state(late=inv)
        api("POST", f"/v2/invoicing/invoices/{inv}/send", {"send_to_recipient": True},
            request_id=f"jd-probe-send-{inv}")
        cmd_get([inv])


def cmd_webhook_create(args):
    url = args[0]
    code, parsed, _, _ = api("GET", "/v1/notifications/webhooks")
    for w in (parsed or {}).get("webhooks", []):
        if w.get("url") == url:
            print("  already registered:", w.get("id"))
            return
    code, parsed, _, _ = api("POST", "/v1/notifications/webhooks", {
        "url": url,
        "event_types": [{"name": n} for n in ("INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED",
                                              "INVOICING.INVOICE.UPDATED", "INVOICING.INVOICE.REFUNDED")]})
    if parsed:
        print("  webhook id:", parsed.get("id"))
        save_state(webhook_id=parsed.get("id"))


def cmd_webhook_list(_args):
    code, parsed, _, _ = api("GET", "/v1/notifications/webhooks")
    for w in (parsed or {}).get("webhooks", []):
        print("  ", w.get("id"), w.get("url"), [e.get("name") for e in w.get("event_types", [])])


def cmd_simulate(args):
    code, parsed, _, _ = api("POST", "/v1/notifications/simulate-event",
                             {"webhook_id": args[0], "event_type": "INVOICING.INVOICE.PAID"})
    if parsed:
        print("  event keys:", sorted(parsed.keys()))
        print("  resource keys:", keys(parsed.get("resource", {}))[:12])
        save_fixture("event-invoice-paid-sample.json", parsed)


def cmd_verify(args):
    """args[0]: a file holding {"headers": {...}, "body": "<raw text>"} as the stub Worker stores it."""
    with open(args[0], encoding="utf-8") as f:
        stored = json.load(f)
    h = {k.lower(): v for k, v in stored["headers"].items()}
    webhook_id = args[1] if len(args) > 1 else load_state().get("webhook_id")
    body = ('{"auth_algo":%s,"cert_url":%s,"transmission_id":%s,"transmission_sig":%s,"transmission_time":%s,'
            '"webhook_id":%s,"webhook_event":%s}') % (
        json.dumps(h["paypal-auth-algo"]), json.dumps(h["paypal-cert-url"]), json.dumps(h["paypal-transmission-id"]),
        json.dumps(h["paypal-transmission-sig"]), json.dumps(h["paypal-transmission-time"]), json.dumps(webhook_id),
        stored["body"])
    code, parsed, _, _ = api("POST", "/v1/notifications/verify-webhook-signature", body.encode())
    print("  verification_status:", (parsed or {}).get("verification_status"))


def cmd_resend(args):
    api("POST", f"/v1/notifications/webhooks-events/{args[0]}/resend", {})


def cmd_events(_args):
    code, parsed, _, _ = api("GET", "/v1/notifications/webhooks-events?page_size=10&event_type=INVOICING.INVOICE.PAID")
    for e in (parsed or {}).get("events", []):
        print("  ", e.get("id"), e.get("event_type"), e.get("create_time"), (e.get("resource") or {}).get("id"))


COMMANDS = {n.replace("cmd_", "").replace("_", "-"): f for n, f in globals().items() if n.startswith("cmd_")}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
