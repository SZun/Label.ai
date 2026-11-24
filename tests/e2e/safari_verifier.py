"""Exercise the actual verifier in native Safari via Apple's local WebDriver on macOS."""
import argparse
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

def webdriver(url, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(url, data=data, method=method, headers={"Content-Type":"application/json"})
    try:
        with urlopen(request, timeout=40) as response:
            return json.load(response)["value"]
    except HTTPError as error:
        raise RuntimeError(f"SafariDriver {error.code}: {error.read(1024).decode(errors='replace')}") from error

def run(harness):
    with socket.socket() as port:
        port.bind(("127.0.0.1",0))
        driver_port = port.getsockname()[1]
    driver_url = f"http://127.0.0.1:{driver_port}"
    server = ThreadingHTTPServer(("127.0.0.1",0),partial(SimpleHTTPRequestHandler,directory=str(harness)))
    Thread(target=server.serve_forever,daemon=True).start()
    driver = subprocess.Popen(["/usr/bin/safaridriver","-p",str(driver_port)])
    session = None
    try:
        deadline = monotonic()+15
        while monotonic()<deadline:
            try:
                webdriver(driver_url+"/status")
                break
            except URLError:
                sleep(.25)
        created = webdriver(driver_url+"/session","POST",{"capabilities":{"alwaysMatch":{"browserName":"Safari"}}})
        session = driver_url+"/session/"+created["sessionId"]
        print("Native Safari", created["capabilities"].get("browserVersion"),flush=True)
        webdriver(session+"/url","POST",{"url":f"http://127.0.0.1:{server.server_port}/"})
        fixtures = Path(__file__).resolve().parents[1]/"fixtures/provenance"
        manifest = json.loads((fixtures/"manifest.json").read_text())
        results = []
        for row in manifest["assets"]:
            file = fixtures/row["file"]
            mime = {".jpg":"image/jpeg",".png":"image/png",".mp4":"video/mp4"}[file.suffix]
            value = webdriver(session+"/execute/async","POST",{
                "script":"const [data,mime,done]=arguments; window.verifyFixture(data,mime).then(done,e=>done({error:String(e)}));",
                "args":[base64.b64encode(file.read_bytes()).decode(),mime]})
            assert value["status"] == row["expected"], (file.name,value,row["expected"])
            assert value["shouldLabel"] is (row["expected"]=="verified-generated")
            results.append((file.name,value["status"]))
        print(json.dumps({"native_safari_verifier":results}),flush=True)
    finally:
        try:
            if session:
                webdriver(session,"DELETE")
        finally:
            driver.terminate()
            driver.wait(timeout=10)
            server.shutdown()
            server.server_close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness",type=Path)
    run(parser.parse_args().harness)
