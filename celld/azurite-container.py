# Create a container in the Azurite blob emulator (SharedKey auth with the well-known dev key).
# Usage: python3 celld/azurite-container.py <name>
# AZURITE_BLOB_STORAGE_URL (as for celld's object_store) moves it off http://127.0.0.1:10000.
import base64, hmac, hashlib, os, sys, urllib.request
from email.utils import formatdate
acct="devstoreaccount1"; key=base64.b64decode("Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==")
name=sys.argv[1]; date=formatdate(usegmt=True); ver="2021-08-06"
canon_h=f"x-ms-date:{date}\nx-ms-version:{ver}\n"
canon_r=f"/{acct}/{acct}/{name}\nrestype:container"
sts="PUT\n\n\n\n\napplication/x-www-form-urlencoded\n\n\n\n\n\n\n"+canon_h+canon_r
sig=base64.b64encode(hmac.new(key,sts.encode(),hashlib.sha256).digest()).decode()
req=urllib.request.Request(os.environ.get("AZURITE_BLOB_STORAGE_URL","http://127.0.0.1:10000").rstrip("/")+f"/{acct}/{name}?restype=container",method="PUT",data=b"",headers={"x-ms-date":date,"x-ms-version":ver,"Authorization":f"SharedKey {acct}:{sig}","Content-Length":"0"})
# 201 creates the container and 409 means it exists; anything else fails.
try: print(urllib.request.urlopen(req).status)
except urllib.error.HTTPError as e:
    print(e.code, e.read()[:300])
    if e.code != 409: sys.exit(1)
