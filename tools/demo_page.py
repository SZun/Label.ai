"""Serve signed and conventional examples on loopback to try the installed extension."""
import argparse
import base64
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import struct
from threading import Event, Thread
import zlib

SIGNED = Path(__file__).resolve().parents[1] / "tests/fixtures/provenance/firefly-generated.jpg"


def ramp_png():
    def chunk(tag,data):
        return struct.pack(">I",len(data))+tag+data+struct.pack(">I",zlib.crc32(tag+data))
    w,h=240,170
    pixels=b"".join(b'\0'+bytes(((x+y)%250 for x in range(w))) for y in range(h))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack(">IIBBBBB",w,h,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')


@contextmanager
def publisher(port=0):
    blobs = {"signed":SIGNED.read_bytes(), "unsigned":ramp_png()}
    resources = {"/assets/"+hashlib.sha256(v).hexdigest()+(".jpg" if k=="signed" else ".png"):v for k,v in blobs.items()}
    paths = list(resources)
    requests=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):
            pass
        def do_GET(self):
            requests.append(("GET",self.path))
            if self.path in resources:
                data=resources[self.path]
                mime="image/jpeg" if self.path.endswith(".jpg") else "image/png"
            elif self.path=="/":
                uris={k:"data:image/"+("jpeg" if k=="signed" else "png")+";base64,"+base64.b64encode(v).decode() for k,v in blobs.items()}
                data=(f'<!doctype html><meta charset=utf-8><title>Label.ai verification page</title>'
                      f'<link rel=icon href="data:,"><style>img{{width:240px;height:170px;object-fit:contain}}</style>'
                      f'<img id=asset alt="Fixture artwork" src="{uris["signed"]}">'
                      f'<img id=control alt="Conventional gradient" src="{uris["unsigned"]}">'
                      f'<script>globalThis.signedSource={json.dumps(uris["signed"])};globalThis.addressed={json.dumps(paths[0])};</script>').encode()
                mime="text/html"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type",mime)
            self.send_header("Content-Length",str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_POST(self):
            requests.append(("POST",self.path))
            self.send_error(405)
        do_PUT=do_POST
    server=ThreadingHTTPServer(("127.0.0.1",port),Handler)
    thread=Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}",requests
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    port = parser.parse_args().port
    if not SIGNED.is_file():
        raise SystemExit("Run python3 tools/prepare_provenance_fixtures.py first.")
    with publisher(port) as (url, _requests):
        print(f"Open {url} and enable that exact origin in Label.ai. Reload to scan the two examples.",flush=True)
        try:
            Event().wait()
        except KeyboardInterrupt:
            pass
