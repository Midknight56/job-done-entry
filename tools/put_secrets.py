r"""Sets the Worker's secrets from the secrets folder, piping each value to `wrangler secret put` on stdin.

Usage (from Bash, with the Cloudflare token of the target account in the environment):
  python tools/put_secrets.py [NAME=SOURCE_KEY ...] [--webhook-id ID]

By default it sets PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BUYER_EMAIL and a fresh random IP_SALT. No value is
ever printed; only the names and wrangler's success or failure.
"""
import os
import secrets
import subprocess
import sys

DEFAULTS = {
    "PAYPAL_CLIENT_ID": "PAYPAL_SANDBOX_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET": "PAYPAL_SANDBOX_SECRET",
    "PAYPAL_BUYER_EMAIL": "PAYPAL_SANDBOX_BUYER_EMAIL",
}


def read_file():
    out = {}
    path = os.path.join(os.path.expanduser("~"), ".cloudflare", "paypal-sandbox.local.txt")
    with open(path, encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                out[k.strip()] = v.strip()
    return out


def put(name, value, config):
    r = subprocess.run(f"npx wrangler secret put {name} -c {config}", input=value, text=True, encoding="utf-8", errors="replace", capture_output=True,
                       shell=True, timeout=120)
    ok = r.returncode == 0
    print(f"{name}: {'set' if ok else 'FAILED exit ' + str(r.returncode)}")
    if not ok:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        for line in tail:
            print("   ", line[:200].replace(value, "<value>") if value else line[:200])


def main():
    config = "wrangler.deploy.jsonc"
    values = read_file()
    args = sys.argv[1:]
    if "--webhook-id" in args:
        put("PAYPAL_WEBHOOK_ID", args[args.index("--webhook-id") + 1], config)
        return
    pairs = dict(a.split("=", 1) for a in args) if args else DEFAULTS
    for name, key in pairs.items():
        put(name, values[key], config)
    if not args:
        put("IP_SALT", secrets.token_hex(16), config)


if __name__ == "__main__":
    main()
